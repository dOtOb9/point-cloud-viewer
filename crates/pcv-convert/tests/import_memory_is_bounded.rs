//! M4-9の新規受け入れテスト: E57/PLY/PCD(`binary_compressed`を除く)の
//! 読み込み側が、一度に抱えるメモリを点数に比例させないことを確かめる。
//!
//! # 考え方(`vendor/copc-writer/tests/scratch_read_is_bounded.rs`と同じ)
//!
//! 「一度にメモリに持つ量」を直接測るのは難しいので、**入力ソースへの
//! 1回の`read()`呼び出しが要求する最大バイト数**を代理指標にする。読み込みが
//! `Vec`に全点を貯めるような実装なら、`read_to_end`等でファイルサイズに
//! 近い大きな読み取りが少なくとも1回は発生するか、その後の処理
//! (`for_each_point`)がメモリ上の巨大な配列を舐めるだけになり、入力への
//! 読み取り自体は小さくても「保持量」は増える。後者を直接測れないため、
//! **点数を変えても入力への最大読み取りサイズが変わらないこと**を確かめる
//! ことで代える: 読み込みが本当にストリーミング(固定サイズのバッファで
//! 1点ずつ処理)であれば、点数に関わらず最大読み取りサイズは同じ(固定の
//! バッファ容量)になるはずであり、`Vec`に貯める実装(M4-4以前)なら
//! 点数に応じて読み取り単位が変わりうる(最悪`read_to_end`で1回の読み取りが
//! ファイルサイズ全体になる)。
//!
//! `binary_compressed`のPCDは対象外(`pcd.rs`のモジュールドキュメント参照。
//! 展開の性質上、点数に比例したメモリを使うことが分かっている例外)。

use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::import::{convert_to_copc, SourceFormat};

/// 入力への`read()`呼び出しのうち、要求された最大バイト数を記録する
/// (`vendor/copc-writer/tests/scratch_read_is_bounded.rs`の
/// `PeakReadTracker`と同じ考え方)。
#[derive(Clone, Default)]
struct PeakReadTracker(Arc<AtomicUsize>);

impl PeakReadTracker {
    fn record(&self, len: usize) {
        self.0.fetch_max(len, Ordering::Relaxed);
    }
    fn peak(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }
}

struct TrackingReader {
    inner: Cursor<Vec<u8>>,
    tracker: PeakReadTracker,
}

impl Read for TrackingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        // 要求されたバッファの大きさ(`buf.len()`)を記録する。`n`(実際に
        // 埋まった量)ではなく`buf.len()`を見るのは、「呼び出し側が一度に
        // どれだけのバッファを用意したか」が「一度にメモリ上に置く量」の
        // 代理指標として直接的なため。
        self.tracker.record(buf.len());
        Ok(n)
    }
}

impl Seek for TrackingReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

fn convert_and_track(bytes: Vec<u8>, format: SourceFormat) -> usize {
    let tracker = PeakReadTracker::default();
    let reader = TrackingReader {
        inner: Cursor::new(bytes),
        tracker: tracker.clone(),
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("out.copc.laz");
    convert_to_copc(
        reader,
        format,
        &output,
        dir.path(),
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |_| {},
    )
    .expect("convert_to_copc");
    tracker.peak()
}

// ---- PLY(ASCII) ----

fn build_ascii_ply(point_count: usize) -> Vec<u8> {
    let mut text = format!("ply\nformat ascii 1.0\nelement vertex {point_count}\n");
    text.push_str("property float x\nproperty float y\nproperty float z\nend_header\n");
    for i in 0..point_count {
        let t = i as f32;
        text.push_str(&format!("{t} {} {}\n", t * 2.0, t * 3.0));
    }
    text.into_bytes()
}

#[test]
fn ascii_ply_peak_read_does_not_scale_with_point_count() {
    let small = convert_and_track(build_ascii_ply(1_000), SourceFormat::Ply);
    let large = convert_and_track(build_ascii_ply(200_000), SourceFormat::Ply);
    assert_eq!(
        small, large,
        "PLY(ASCII)の最大読み取りサイズが点数で変わった(small={small}, large={large})。\
         全点を読んでから処理していないか確認すること"
    );
}

// ---- PLY(binary_little_endian) ----

fn build_binary_ply(point_count: usize) -> Vec<u8> {
    let mut out = format!("ply\nformat binary_little_endian 1.0\nelement vertex {point_count}\n")
        .into_bytes();
    out.extend_from_slice(b"property float x\nproperty float y\nproperty float z\nend_header\n");
    for i in 0..point_count {
        let t = i as f32;
        out.extend_from_slice(&t.to_le_bytes());
        out.extend_from_slice(&(t * 2.0).to_le_bytes());
        out.extend_from_slice(&(t * 3.0).to_le_bytes());
    }
    out
}

#[test]
fn binary_ply_peak_read_does_not_scale_with_point_count() {
    let small = convert_and_track(build_binary_ply(1_000), SourceFormat::Ply);
    let large = convert_and_track(build_binary_ply(200_000), SourceFormat::Ply);
    assert_eq!(
        small, large,
        "PLY(binary)の最大読み取りサイズが点数で変わった(small={small}, large={large})。\
         全点を読んでから処理していないか確認すること"
    );
}

// ---- PCD(ASCII) ----

fn build_ascii_pcd(point_count: usize) -> Vec<u8> {
    let mut text = format!(
        "# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n\
         WIDTH {point_count}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {point_count}\nDATA ascii\n"
    );
    for i in 0..point_count {
        let t = i as f32;
        text.push_str(&format!("{t} {} {}\n", t * 2.0, t * 3.0));
    }
    text.into_bytes()
}

#[test]
fn ascii_pcd_peak_read_does_not_scale_with_point_count() {
    let small = convert_and_track(build_ascii_pcd(1_000), SourceFormat::Pcd);
    let large = convert_and_track(build_ascii_pcd(200_000), SourceFormat::Pcd);
    assert_eq!(
        small, large,
        "PCD(ASCII)の最大読み取りサイズが点数で変わった(small={small}, large={large})。\
         全点を読んでから処理していないか確認すること"
    );
}

// ---- PCD(binary、非圧縮) ----

fn build_binary_pcd(point_count: usize) -> Vec<u8> {
    let mut out = format!(
        "# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n\
         WIDTH {point_count}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {point_count}\nDATA binary\n"
    )
    .into_bytes();
    for i in 0..point_count {
        let t = i as f32;
        out.extend_from_slice(&t.to_le_bytes());
        out.extend_from_slice(&(t * 2.0).to_le_bytes());
        out.extend_from_slice(&(t * 3.0).to_le_bytes());
    }
    out
}

#[test]
fn binary_pcd_peak_read_does_not_scale_with_point_count() {
    let small = convert_and_track(build_binary_pcd(1_000), SourceFormat::Pcd);
    let large = convert_and_track(build_binary_pcd(200_000), SourceFormat::Pcd);
    assert_eq!(
        small, large,
        "PCD(binary)の最大読み取りサイズが点数で変わった(small={small}, large={large})。\
         全点を読んでから処理していないか確認すること"
    );
}

// ---- E57 ----

fn build_e57(point_count: usize) -> Vec<u8> {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("scan.e57");
    let mut writer = e57::E57Writer::from_file(&path, "guid-root").expect("create e57 writer");
    let prototype = vec![
        e57::Record::CARTESIAN_X_F64,
        e57::Record::CARTESIAN_Y_F64,
        e57::Record::CARTESIAN_Z_F64,
    ];
    let mut pc = writer
        .add_pointcloud("guid-scan1", prototype)
        .expect("add scan");
    for i in 0..point_count {
        let t = i as f64;
        pc.add_point(vec![
            e57::RecordValue::Double(t),
            e57::RecordValue::Double(t * 2.0),
            e57::RecordValue::Double(t * 3.0),
        ])
        .expect("add point");
    }
    pc.finalize().expect("finalize scan");
    writer.finalize().expect("finalize e57");
    std::fs::read(&path).expect("read back e57 bytes")
}

#[test]
fn e57_peak_read_does_not_scale_with_point_count() {
    // E57は書き込み自体がASCII/PCDより重いため、点数は控えめにする
    // (それでも「点数を変えても最大読み取りサイズが変わらないか」という
    // 検証の本質には影響しない)。
    let small = convert_and_track(build_e57(500), SourceFormat::E57);
    let large = convert_and_track(build_e57(50_000), SourceFormat::E57);
    assert_eq!(
        small, large,
        "E57の最大読み取りサイズが点数で変わった(small={small}, large={large})。\
         全点を読んでから処理していないか確認すること"
    );
}
