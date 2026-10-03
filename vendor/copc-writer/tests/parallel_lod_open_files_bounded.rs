//! M4-8(`TaskSheets/M4-import-and-conversion.md`)の回帰テスト:
//! octreeの分割(LOD構築、`lod.rs`)を並列化しても、**同時に開いている
//! 一時ファイルの数が点数(ノード数)に比例しない**ことを確かめる。
//!
//! # 経緯
//!
//! `build_lod_index`の並列版は、ルート直下のオクタントごとに独立した
//! ローカルの一時ファイル(order-branch)を作って並列処理する
//! (`lod.rs`のドキュメント参照)。各部分木の内部(逐次の`assign`)は
//! 今までどおり一時ファイルを作っては閉じる(root・partition・order)。
//! 「並列化で同時に抱える一時ファイルの数が増え、メモリ・ファイル
//! ハンドルの使用量が点数やノード数に比例してしまわないか」を、
//! `vendor/copc-writer/tests/scratch_read_is_bounded.rs`と同じ考え方
//! (`ScratchFs`を薄くラップして指標を記録する)で確かめる。
//!
//! # やっていること
//!
//! `copc_writer::ScratchFs`を`MemoryScratchFs`の上にかぶせ、「一時ファイルが
//! 作られてから(writer→readerの変換をまたいで)完全に手放されるまで」の
//! 区間をRAIIで数える`OpenFileTracker`を用意する。点数が10倍違う2つの入力を
//! 同じ`max_points_per_node`で変換し、**同時に開いていた一時ファイル数の
//! ピークが10倍にはならない**(スレッド数程度の定数倍に収まる)ことを確認する。

use std::io::{Read, Result as IoResult, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use copc_core::{LasPointRecord, NeverCancel, Result, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs, ScratchFs,
    ScratchReader, ScratchWriter, SpillWriter,
};

/// 「現在何個の一時ファイルが開いているか」とそのピークを数える。
#[derive(Clone, Default)]
struct OpenFileTracker {
    current: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

impl OpenFileTracker {
    fn opened(&self) -> OpenGuard {
        let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        OpenGuard(self.current.clone())
    }

    fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
}

/// `create_temp`で確保し、writer→reader(`finish_temp`)をまたいで持ち回し、
/// readerが(あるいは未完了のwriterが)dropされた時に手放されたと数える。
struct OpenGuard(Arc<AtomicUsize>);

impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct TrackingScratchFs {
    inner: MemoryScratchFs,
    tracker: OpenFileTracker,
}

impl ScratchFs for TrackingScratchFs {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
        Ok(Box::new(TrackingScratchWriter {
            inner: self.inner.create_temp(label)?,
            guard: Some(self.tracker.opened()),
        }))
    }

    fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
        // 出力ファイルは1個しかできないので、このテストの関心事(並列化で
        // 同時に抱える一時ファイルの数)には数えない。
        self.inner.create_output(final_path)
    }
}

struct TrackingScratchWriter {
    inner: Box<dyn ScratchWriter>,
    /// `finish_temp`で`TrackingScratchReader`へ持ち回す。未完了のまま
    /// dropされた場合はここで手放される(`Option`のdrop経由)。
    guard: Option<OpenGuard>,
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
    fn finish_temp(mut self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        let guard = self.guard.take();
        let inner = self.inner.finish_temp()?;
        Ok(Box::new(TrackingScratchReader {
            inner,
            _guard: guard,
        }))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        self.inner.finish_output()
    }
}

struct TrackingScratchReader {
    inner: Box<dyn ScratchReader>,
    /// readerがdropされるまで一時ファイルを「開いている」ものとして数える。
    _guard: Option<OpenGuard>,
}

impl ScratchReader for TrackingScratchReader {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        self.inner.open_at(offset)
    }

    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.inner.read_at(offset, buf)
    }

    fn len(&self) -> Result<u64> {
        self.inner.len()
    }
}

/// x/y/z全軸に散らした決定的な合成点群(多段のoctree分割を実際に起こすため)。
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

/// `point_count`個の合成点群を変換し、同時に開いていた一時ファイル数の
/// ピークを返す。
fn peak_open_temp_files(point_count: u32, max_points_per_node: u32) -> usize {
    let tracker = OpenFileTracker::default();
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
    for seed in 0..point_count {
        spill.push(&record(seed)).expect("spill.push");
    }
    let spill_reader = spill.finalize().expect("spill.finalize");

    let output_path = Path::new("bounded.copc.laz");
    write_copc_from_spill_with_fs(
        &fs,
        output_path,
        spill_reader,
        &CopcWriterParams::new(max_points_per_node),
        &NeverCancel,
        &CopcWriteMetadata::default(),
    )
    .expect("write_copc_from_spill_with_fs");

    tracker.peak()
}

#[test]
fn concurrently_open_temp_files_do_not_scale_with_point_count() {
    const MAX_POINTS_PER_NODE: u32 = 500;
    // 点数が10倍の2つの規模で測り、ピークの比が点数の比(10倍)に
    // 近づかない(スレッド数程度の定数倍に収まる)ことを確認する。
    let small_peak = peak_open_temp_files(20_000, MAX_POINTS_PER_NODE);
    let large_peak = peak_open_temp_files(200_000, MAX_POINTS_PER_NODE);

    assert!(
        small_peak > 0,
        "一時ファイルが一度も開かれていない(テスト不備)"
    );
    // 「点数に比例しない」ことを、比較的ゆるい倍率(点数比10倍よりずっと
    // 小さい3倍)で機械的に判定する。実際の構造上は`rayon`のスレッド数
    // 程度の定数倍にしかならないはずなので、3倍の余裕があれば十分。
    assert!(
        large_peak <= small_peak * 3,
        "一時ファイルのピーク同時オープン数が点数に比例して増えている疑いがある: \
         20,000点で{small_peak}、200,000点で{large_peak}(10倍の点数に対し\
         {large_peak}/{small_peak}倍は増えすぎ)"
    );
}
