//! ADR-0019: the heap used by a conversion does not grow with the point count.
//!
//! Temporary files live on disk here (`NativeScratchFs`), so what the global
//! allocator sees is only what the conversion keeps in memory: the buffers of
//! the disk passes, the subtrees being built, and the compression buffers. The
//! same budget is used for a small and a big input; the heap peak of the big
//! one must stay close to the small one (a conversion that held every point
//! would grow with the input).
//!
//! This is its own test binary because the counting allocator is global and
//! other tests running at the same time would disturb the numbers.

#![cfg(feature = "native-fs")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, NativeScratchFs,
    SpillWriter,
};

struct CountingAllocator;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: forwards every call to the system allocator unchanged; the counters
// are only bookkeeping.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            let now = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = System.realloc(ptr, layout, new_size);
        if !new_ptr.is_null() {
            if new_size >= layout.size() {
                let now = LIVE.fetch_add(new_size - layout.size(), Ordering::Relaxed) + new_size
                    - layout.size();
                PEAK.fetch_max(now, Ordering::Relaxed);
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        new_ptr
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

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

/// Converts `point_count` points and returns the heap peak, in bytes, above
/// what was live before the conversion started.
fn heap_peak(point_count: u32, workers: usize) -> usize {
    let dir = tempfile::tempdir().expect("tempdir");
    let fs = NativeScratchFs::new(dir.path());
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
    let spill = spill.finalize().expect("spill.finalize");

    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    write_copc_from_spill_with_fs(
        &fs,
        &dir.path().join("out.copc.laz"),
        spill,
        &CopcWriterParams::new(500)
            .with_memory_budget_bytes(4 * 1024 * 1024)
            .with_max_concurrent_subtrees(workers),
        &NeverCancel,
        &CopcWriteMetadata::default(),
    )
    .expect("write_copc_from_spill_with_fs");
    PEAK.load(Ordering::Relaxed).saturating_sub(before)
}

#[test]
fn heap_peak_does_not_grow_with_the_point_count() {
    for workers in [1, 4] {
        let small = heap_peak(50_000, workers);
        let large = heap_peak(400_000, workers);
        eprintln!(
            "workers {workers}: heap peak {small} bytes at 50,000 points, {large} bytes at 400,000"
        );
        assert!(small > 0);
        // 8 times the points. The peak is dominated by fixed buffers (the
        // disk passes, the budget), so it should stay about the same.
        assert!(
            large <= small * 3 / 2 + 2 * 1024 * 1024,
            "heap peak grew with the point count ({workers} worker(s)): \
             {small} bytes at 50,000 points, {large} bytes at 400,000"
        );
    }
}
