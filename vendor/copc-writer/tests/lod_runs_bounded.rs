//! ADR-0019: the temporary files of the octree construction stay bounded.
//!
//! - A run file is deleted as soon as it has been partitioned, so the bytes of
//!   live temporary files peak at about two copies of the data (the run being
//!   partitioned and the child runs written from it), not one copy per level.
//! - The number of temporary files alive at the same moment does not grow with
//!   the point count.
//!
//! `ScratchFs` is wrapped on top of `MemoryScratchFs`: a file counts from
//! `create_temp` until its reader (or an unfinished writer) is dropped, and the
//! bytes written to it count while it lives.

use std::io::{Read, Result as IoResult, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use copc_core::{LasPointRecord, NeverCancel, Result, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, LasTransform,
    MemoryScratchFs, ScratchFs, ScratchReader, ScratchWriter, SpillWriter,
};

#[derive(Clone, Default)]
struct Tracker {
    files: Arc<AtomicUsize>,
    peak_files: Arc<AtomicUsize>,
    bytes: Arc<AtomicU64>,
    peak_bytes: Arc<AtomicU64>,
}

/// Releases one file (and the bytes written to it) when dropped.
struct FileGuard {
    tracker: Tracker,
    written: u64,
}

impl Drop for FileGuard {
    fn drop(&mut self) {
        self.tracker.files.fetch_sub(1, Ordering::SeqCst);
        self.tracker.bytes.fetch_sub(self.written, Ordering::SeqCst);
    }
}

struct TrackingFs {
    inner: MemoryScratchFs,
    tracker: Tracker,
}

impl ScratchFs for TrackingFs {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
        let now = self.tracker.files.fetch_add(1, Ordering::SeqCst) + 1;
        self.tracker.peak_files.fetch_max(now, Ordering::SeqCst);
        Ok(Box::new(TrackingWriter {
            inner: self.inner.create_temp(label)?,
            guard: Some(FileGuard {
                tracker: self.tracker.clone(),
                written: 0,
            }),
        }))
    }

    fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
        // The output is one file; it is not what this test is about.
        self.inner.create_output(final_path)
    }
}

struct TrackingWriter {
    inner: Box<dyn ScratchWriter>,
    guard: Option<FileGuard>,
}

impl Write for TrackingWriter {
    fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
        let n = self.inner.write(buf)?;
        if let Some(guard) = self.guard.as_mut() {
            guard.written += n as u64;
            let now = guard.tracker.bytes.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
            guard.tracker.peak_bytes.fetch_max(now, Ordering::SeqCst);
        }
        Ok(n)
    }

    fn flush(&mut self) -> IoResult<()> {
        self.inner.flush()
    }
}

impl Seek for TrackingWriter {
    fn seek(&mut self, pos: SeekFrom) -> IoResult<u64> {
        self.inner.seek(pos)
    }
}

impl ScratchWriter for TrackingWriter {
    fn finish_temp(mut self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        let guard = self.guard.take();
        let inner = self.inner.finish_temp()?;
        Ok(Box::new(TrackingReader {
            inner,
            _guard: guard,
        }))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        self.inner.finish_output()
    }
}

struct TrackingReader {
    inner: Box<dyn ScratchReader>,
    _guard: Option<FileGuard>,
}

impl ScratchReader for TrackingReader {
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

/// Points spread over all three axes, so the octree splits several levels.
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

/// The output scale and offset. With `compact` the spill stores them as i32
/// (the production path); without it the spill keeps f64 coordinates.
const TRANSFORM: LasTransform = LasTransform {
    scale: (0.001, 0.001, 0.001),
    offset: (0.0, 0.0, 0.0),
};

fn metadata(compact: bool) -> CopcWriteMetadata {
    let mut metadata = CopcWriteMetadata::default();
    if compact {
        metadata.scale = Some(TRANSFORM.scale);
        metadata.offset = Some(TRANSFORM.offset);
    }
    metadata
}

struct Measured {
    spill_bytes: u64,
    peak_bytes: u64,
    peak_files: usize,
    files_after: usize,
}

fn convert(
    point_count: u32,
    max_points_per_node: u32,
    memory_budget: u64,
    workers: usize,
    compact: bool,
) -> Measured {
    let tracker = Tracker::default();
    let fs = TrackingFs {
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
    let mut spill = SpillWriter::create(&fs, layout, compact.then_some(TRANSFORM))
        .expect("SpillWriter::create");
    for seed in 0..point_count {
        spill.push(&record(seed)).expect("spill.push");
    }
    let spill = spill.finalize().expect("spill.finalize");
    let spill_bytes = tracker.bytes.load(Ordering::SeqCst);

    write_copc_from_spill_with_fs(
        &fs,
        Path::new("bounded.copc.laz"),
        spill,
        &CopcWriterParams::new(max_points_per_node)
            .with_memory_budget_bytes(memory_budget)
            .with_max_concurrent_subtrees(workers),
        &NeverCancel,
        &metadata(compact),
    )
    .expect("write_copc_from_spill_with_fs");

    Measured {
        spill_bytes,
        peak_bytes: tracker.peak_bytes.load(Ordering::SeqCst),
        peak_files: tracker.peak_files.load(Ordering::SeqCst),
        files_after: tracker.files.load(Ordering::SeqCst),
    }
}

#[test]
fn live_temp_bytes_peak_at_about_two_copies_of_the_data() {
    // 200,000 points against a 256 KiB budget: several levels are split on disk.
    for (workers, compact) in [(1, true), (4, true), (4, false)] {
        let m = convert(200_000, 500, 256 * 1024, workers, compact);
        assert!(m.spill_bytes > 0);
        assert!(
            m.peak_bytes <= m.spill_bytes * 21 / 10,
            "live temp bytes peaked at {} for a spill of {} ({workers} worker(s)): \
             runs are not deleted as soon as they are partitioned",
            m.peak_bytes,
            m.spill_bytes
        );
        assert!(
            m.peak_bytes > m.spill_bytes,
            "test setup: nothing was split on disk (peak {} spill {})",
            m.peak_bytes,
            m.spill_bytes
        );
        assert_eq!(m.files_after, 0, "temporary files are left over");
    }
}

#[test]
fn concurrently_open_temp_files_do_not_scale_with_point_count() {
    // Ten times the points must not mean ten times the files alive at once.
    let small = convert(20_000, 500, 256 * 1024, 4, true);
    let large = convert(200_000, 500, 256 * 1024, 4, true);
    assert!(small.peak_files > 0);
    assert!(
        large.peak_files <= small.peak_files * 3,
        "peak open temp files grew with the point count: {} at 20,000 points, {} at 200,000",
        small.peak_files,
        large.peak_files
    );
}
