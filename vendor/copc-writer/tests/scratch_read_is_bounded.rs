//! M4-6の回帰テスト:「一度にメモリに持つ一時ファイルの量が点数に比例しない」
//! ことを確かめる。
//!
//! # 経緯
//!
//! かつて`crates/pcv-wasm/src/opfs.rs`の`OpfsTempReader::as_bytes`は、一時
//! ファイル(spill。1点あたり50〜60バイト)の中身を`vec![0u8; len]`へ
//! **丸ごと**読み込んでいた。ネイティブ実装はmmapでOSにページ管理を
//! 任せられるため問題にならなかったが、OPFSにはmmap相当のAPIが無いため、
//! この丸ごと読み込みはspillのサイズをそのままwasm32のメモリ使用量にした。
//! 数千万点の入力ではこれが数GBになり、wasm32のアドレス空間(実務上4GiB
//! 未満)を超えて確保が失敗し、wasmが`unreachable`で停止する不具合になった
//! (`TaskSheets/M4-import-and-conversion.md`のM4-6b追記、
//! `vendor/copc-writer/PATCH.md`参照)。
//!
//! M4-6aの調査(スパイク段階)は改修前後の出力バイト同一性だけを確認し、
//! **読み込み中にどれだけのメモリを同時に保持するかは検証していなかった**
//! (出力が一致してもメモリの使い方までは保証されない、ということをこの
//! 不具合が示した)。この回帰テストはその抜けを埋める。
//!
//! # やっていること
//!
//! `copc_writer::ScratchFs`/`ScratchReader`を`MemoryScratchFs`の上に薄く
//! かぶせ、`ScratchReader::read_at`・`Read::read`(`open_at`が返すストリーム)
//! に渡された**1回あたりの読み取りバッファの最大サイズ**を記録する。
//! 「一度に読む量」の代理指標として、これを「一度にメモリに持つ量」の
//! 目安に使う(1回の`read_at`呼び出しが要求するバッファぶんだけが、その
//! 呼び出しの間メモリに存在する)。
//!
//! 200万点の合成入力を`write_copc_from_spill_with_fs`で最後まで変換し、
//! 記録された最大値が、点数に比例した値(200万点×1点50〜60バイト強=
//! 1億バイト前後になるはず。これが`as_bytes`時代の実際の挙動)ではなく、
//! コード中の固定バッファサイズ(`spill.rs`のレコード幅、`lod.rs`の
//! `INDEX_IO_BUFFER_BYTES`=1MiB)程度の小さい値に収まることを確かめる。

use std::io::{Read, Result as IoResult, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use copc_core::{LasPointRecord, NeverCancel, Result, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs, ScratchFs,
    ScratchReader, ScratchWriter, SpillWriter,
};

/// 1回の読み取り呼び出しで要求された最大バイト数を記録する。
/// `ScratchFs: Send + Sync`経由でラップするため`Arc<AtomicUsize>`を使う
/// (`Rc<Cell<_>>`だと`Send`/`Sync`を満たせない)。
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

struct TrackingScratchFs {
    inner: MemoryScratchFs,
    tracker: PeakReadTracker,
}

impl ScratchFs for TrackingScratchFs {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
        Ok(Box::new(TrackingScratchWriter {
            inner: self.inner.create_temp(label)?,
            tracker: self.tracker.clone(),
        }))
    }

    fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
        Ok(Box::new(TrackingScratchWriter {
            inner: self.inner.create_output(final_path)?,
            tracker: self.tracker.clone(),
        }))
    }
}

struct TrackingScratchWriter {
    inner: Box<dyn ScratchWriter>,
    tracker: PeakReadTracker,
}

impl Write for TrackingScratchWriter {
    fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> IoResult<()> {
        self.inner.flush()
    }
}

impl Seek for TrackingScratchWriter {
    fn seek(&mut self, pos: SeekFrom) -> IoResult<u64> {
        self.inner.seek(pos)
    }
}

impl ScratchWriter for TrackingScratchWriter {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        Ok(Box::new(TrackingScratchReader {
            inner: self.inner.finish_temp()?,
            tracker: self.tracker,
        }))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        self.inner.finish_output()
    }
}

struct TrackingScratchReader {
    inner: Box<dyn ScratchReader>,
    tracker: PeakReadTracker,
}

impl ScratchReader for TrackingScratchReader {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        Ok(Box::new(TrackingRead {
            inner: self.inner.open_at(offset)?,
            tracker: self.tracker.clone(),
        }))
    }

    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.tracker.record(buf.len());
        self.inner.read_at(offset, buf)
    }

    fn len(&self) -> Result<u64> {
        self.inner.len()
    }
}

struct TrackingRead {
    inner: Box<dyn Read + Send>,
    tracker: PeakReadTracker,
}

impl Read for TrackingRead {
    fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
        let n = self.inner.read(buf)?;
        self.tracker.record(n);
        Ok(n)
    }
}

/// x/y/z全軸に散らした決定的な合成点群(1ノードしかできないと octree分割を
/// ほとんど検証できないため)。
fn record(seed: u32) -> LasPointRecord {
    let f = f64::from(seed);
    LasPointRecord {
        x: (f * 1.5) % 10_000.0,
        y: (f * 2.25) % 10_000.0,
        z: (f * 0.75) % 10_000.0,
        return_number: 1,
        number_of_returns: 1,
        ..LasPointRecord::default()
    }
}

#[test]
fn spill_reads_stay_bounded_regardless_of_point_count() {
    // 200万点: 課題の受け入れ条件が例示する規模。record_width(RGB無し、
    // GPS無しのStreamingLayout::default()相当)はおよそ43バイト程度なので、
    // かつての`as_bytes`(ファイル全体を一括読み込み)なら
    // 200万 × 43バイト ≈ 8600万バイトがピークになっていたはずの規模。
    const POINT_COUNT: u32 = 2_000_000;
    // `spill.rs`のレコード幅・`lod.rs`のINDEX_IO_BUFFER_BYTES(1MiB)より
    // 十分大きく、かつ「点数に比例する」挙動(今回なら8600万バイト程度)
    // よりは遥かに小さい、固定の上限。
    const PEAK_READ_UPPER_BOUND_BYTES: usize = 2 * 1024 * 1024;

    let tracker = PeakReadTracker::default();
    let fs = TrackingScratchFs {
        inner: MemoryScratchFs::new(),
        tracker: tracker.clone(),
    };

    let layout = StreamingLayout {
        point_format: 0,
        has_gps: false,
        has_color: false,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };
    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriter::create");
    for seed in 0..POINT_COUNT {
        spill.push(&record(seed)).expect("spill.push");
    }
    let spill_reader = spill.finalize().expect("spill.finalize");

    let output_path = Path::new("bounded.copc.laz");
    write_copc_from_spill_with_fs(
        &fs,
        output_path,
        spill_reader,
        // max_points_per_nodeを小さくし、lod.rsのoctree分割(partition_index_run
        // の繰り返し呼び出し)を実際に起こす。
        &CopcWriterParams::new(5_000),
        &NeverCancel,
        &CopcWriteMetadata::default(),
    )
    .expect("write_copc_from_spill_with_fs");

    let peak = tracker.peak();
    assert!(
        peak <= PEAK_READ_UPPER_BOUND_BYTES,
        "1回の読み取りで{peak}バイト要求された。{POINT_COUNT}点(点数に比例するなら\
         数千万バイト規模になるはず)に対してこの値は大きすぎる。as_bytes相当の\
         全体読み込みが復活していないか確認すること"
    );
    assert!(
        peak > 0,
        "読み取りが一度も記録されていない(テスト自体の不備)"
    );
}
