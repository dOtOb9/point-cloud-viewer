//! M4-8(`TaskSheets/M4-import-and-conversion.md`)の回帰テスト:
//! octreeの分割(LOD構築)を並列化した後も、キャンセル(`CancelCheck`)が
//! 働くことを確かめる。
//!
//! 並列ワーカー(`rayon`)はそれぞれ独立に`cancel.check()`を呼ぶ
//! (`lod.rs`の`LodIndexBuilder::assign`が元から持っていたポーリングを
//! そのまま使い回しているだけで、並列化のために変えていない)ため、
//! 1つの共有フラグを立てれば全ワーカーがそれぞれ気づいて止まるはず。
//! これを、呼ばれた回数を数えて途中でキャンセルを返す`CancelCheck`実装で
//! 確かめる(タイミング依存のスリープを使わず、決定的に「分割の途中で
//! キャンセルする」状況を作る)。
//!
//! あわせて、キャンセルされた経路でも一時ファイルが(`tests/
//! scratch_read_is_bounded.rs`と同じ`ScratchFs`ラップで)全て手放される
//! (RAIIで片付く)ことも確認する。

use std::io::{Read, Result as IoResult, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use copc_core::{CancelCheck, Error, LasPointRecord, Result, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs, ScratchFs,
    ScratchReader, ScratchWriter, SpillWriter,
};

/// 呼ばれた回数を数え、`trigger_after`回を超えたら`Cancelled`を返す。
/// スリープや実時間に頼らず、決定的に「処理の途中でキャンセルされる」
/// 状況を作るための実装。
struct CancelAfter {
    calls: AtomicUsize,
    trigger_after: usize,
}

impl CancelCheck for CancelAfter {
    fn check(&self) -> Result<()> {
        let count = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
        if count > self.trigger_after {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// 現在開いている一時ファイル数を数える(`scratch_read_is_bounded.rs`と
/// 同じ考え方)。キャンセル経路でもRAIIで0に戻ることを確認するために使う。
#[derive(Clone, Default)]
struct OpenFileTracker(Arc<AtomicUsize>);

impl OpenFileTracker {
    fn opened(&self) -> OpenGuard {
        self.0.fetch_add(1, Ordering::SeqCst);
        OpenGuard(self.0.clone())
    }

    fn current(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

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
        self.inner.create_output(final_path)
    }
}

struct TrackingScratchWriter {
    inner: Box<dyn ScratchWriter>,
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
fn cancellation_stops_parallel_lod_build_and_leaves_no_open_temp_files() {
    // 十分な点数・多段の分割が起きる小さいmax_points_per_nodeで、octree分割の
    // 途中(1回目のcancel.check()では止まらないがすぐ後で止まる)にキャンセルが
    // 入るようにする。
    const POINT_COUNT: u32 = 200_000;
    const MAX_POINTS_PER_NODE: u32 = 500;

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
    for seed in 0..POINT_COUNT {
        spill.push(&record(seed)).expect("spill.push");
    }
    let spill_reader = spill.finalize().expect("spill.finalize");

    // 最初の数回のcancel.check()(書き出し準備・ルート分割)は通し、
    // octreeの分割が本格化した頃合いで止める。
    let cancel = CancelAfter {
        calls: AtomicUsize::new(0),
        trigger_after: 20,
    };

    let output_path = Path::new("cancelled.copc.laz");
    let result = write_copc_from_spill_with_fs(
        &fs,
        output_path,
        spill_reader,
        &CopcWriterParams::new(MAX_POINTS_PER_NODE),
        &cancel,
        &CopcWriteMetadata::default(),
    );

    assert!(
        matches!(result, Err(Error::Cancelled)),
        "キャンセル後はErr(Cancelled)を返すはず: {result:?}"
    );
    assert_eq!(
        tracker.current(),
        0,
        "キャンセル経路でも一時ファイルは全て手放される(RAII)はず"
    );
}
