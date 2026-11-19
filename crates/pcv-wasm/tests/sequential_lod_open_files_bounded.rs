use std::io::{Read, Result as IoResult, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use copc_core::{LasPointRecord, NeverCancel, Result, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs, ScratchFs,
    ScratchReader, ScratchWriter, SpillWriter,
};

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

fn point_at(x: f64, y: f64, z: f64) -> LasPointRecord {
    LasPointRecord {
        x,
        y,
        z,
        return_number: 1,
        number_of_returns: 1,
        ..LasPointRecord::default()
    }
}

fn points_forcing_depth(depth: u32) -> Vec<LasPointRecord> {
    let h0 = 1_000_000.0f64;
    let depth_usize = depth as usize;
    let mut centers = vec![0.0f64; depth_usize + 1];
    let mut halfsizes = vec![h0; depth_usize + 1];
    for i in 1..=depth_usize {
        halfsizes[i] = halfsizes[i - 1] / 2.0;
        centers[i] = centers[i - 1] - halfsizes[i];
    }

    let mut points = Vec::new();

    points.push(point_at(h0, h0, h0));

    let main_eps = h0 / 2f64.powi(depth as i32 + 10);
    let main = -h0 + main_eps;
    points.push(point_at(main, main, main));
    points.push(point_at(-h0, -h0, -h0));

    for i in 0..depth_usize {
        let c = centers[i];
        let eps = halfsizes[i] / 4.0;
        let flipped = c + eps;
        for pattern in 1u8..8 {
            let x = if pattern & 1 != 0 { flipped } else { main };
            let y = if pattern & 2 != 0 { flipped } else { main };
            let z = if pattern & 4 != 0 { flipped } else { main };
            points.push(point_at(x, y, z));
        }
    }
    points
}

fn peak_open_temp_files_at_depth(depth: u32) -> usize {
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
    let mut spill = SpillWriter::create(&fs, layout, None).expect("SpillWriter::create");
    for point in points_forcing_depth(depth) {
        spill.push(&point).expect("spill.push");
    }
    let spill_reader = spill.finalize().expect("spill.finalize");

    let output_path = Path::new("depth-bounded.copc.laz");
    write_copc_from_spill_with_fs(
        &fs,
        output_path,
        spill_reader,
        &CopcWriterParams::new(2),
        &NeverCancel,
        &CopcWriteMetadata::default(),
    )
    .expect("write_copc_from_spill_with_fs");

    tracker.peak()
}

const OCTANTS: usize = 8;
const ORDER_TEMP_FILES: usize = 1;

fn open_temp_files_upper_bound(depth: usize) -> usize {
    OCTANTS * (depth + 1) + ORDER_TEMP_FILES
}

#[test]
fn depth_zero_has_minimal_peak() {
    let peak = peak_open_temp_files_at_depth(0);
    const ONE_LEVEL_UPPER_BOUND: usize = OCTANTS + ORDER_TEMP_FILES;
    assert!(
        peak <= ONE_LEVEL_UPPER_BOUND,
        "深さ0(アンカーによる不可避の1回の分割のみ)のピーク{peak}が理論上限を超えた"
    );
}

#[test]
fn peak_grows_linearly_with_depth_not_with_point_count() {
    let mut peaks = Vec::new();
    for depth in [0u32, 1, 2, 3, 5, 8, 12, 16] {
        let peak = peak_open_temp_files_at_depth(depth);
        let theoretical_upper_bound = open_temp_files_upper_bound(depth as usize);
        assert!(
            peak <= theoretical_upper_bound,
            "depth={depth}: ピーク{peak}が理論上の上限{theoretical_upper_bound}を超えた"
        );
        peaks.push((depth, peak));
    }
    let (_, deepest_peak) = *peaks.last().unwrap();
    assert!(
        deepest_peak <= open_temp_files_upper_bound(16),
        "深さ16のピーク({deepest_peak})が理論上の上限を超えた(詳細: {peaks:?})"
    );
    println!("sequential build_lod_index peak open temp files by depth: {peaks:?}");
}
