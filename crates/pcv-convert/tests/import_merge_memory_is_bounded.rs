//! M4-17: the multi-file point merge must not hold memory proportional to the point count.
//!
//! Method: a counting global allocator records the peak number of live heap bytes during a
//! merge, and compares it with the existing single-file import of the same number of points.
//! merge, and compares it with the existing single-file import of the same number of points.
//! The merge must add no per-point memory on top of the single-file import.
//! This file has exactly one test, because the allocator is process-wide and a second test
//! running in parallel would disturb the numbers.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::import::convert_path_to_copc;
use pcv_convert::import::merge::convert_paths_to_copc_and_timings;
use pcv_convert::stage_timings::ConversionStageTimings;

struct CountingAlloc;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call is forwarded unchanged to the system allocator; we only count sizes.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if !new_ptr.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            let live = LIVE.fetch_add(new_size, Ordering::Relaxed) + new_size;
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        new_ptr
    }
}

#[global_allocator]
static ALLOCATOR: CountingAlloc = CountingAlloc;

/// Writes `a.ply` and `b.pcd` (`count` points each, far apart in x) and `all.ply`, which has
/// the points of both (`2 * count`) so that it has the same geometry as the merge of the two.
fn write_inputs(dir: &Path, count: usize) -> Vec<std::path::PathBuf> {
    let ply_header = |n: usize| {
        format!(
            "ply\nformat ascii 1.0\nelement vertex {n}\n\
             property float x\nproperty float y\nproperty float z\nend_header\n"
        )
    };
    let mut ply = ply_header(count);
    let mut all = ply_header(2 * count);
    let mut pcd = format!(
        "# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n\
         WIDTH {count}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {count}\nDATA ascii\n"
    );
    let mut pcd_lines = String::new();
    for i in 0..count {
        let t = (i % 1000) as f32;
        let u = (i / 1000) as f32;
        let ply_line = format!("{t} {u} {}\n", t + u);
        let pcd_line = format!("{} {u} {t}\n", t + 2000.0);
        ply.push_str(&ply_line);
        all.push_str(&ply_line);
        pcd.push_str(&pcd_line);
        pcd_lines.push_str(&pcd_line);
    }
    all.push_str(&pcd_lines);
    let paths = vec![dir.join("a.ply"), dir.join("b.pcd"), dir.join("all.ply")];
    std::fs::write(&paths[0], ply).expect("write ply");
    std::fs::write(&paths[1], pcd).expect("write pcd");
    std::fs::write(&paths[2], all).expect("write all.ply");
    paths
}

/// Peak live heap bytes of `run`, minus what was already live before it started.
/// The input files are written (and their text freed) before the measurement starts.
fn peak_of(run: impl FnOnce()) -> usize {
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    run();
    PEAK.load(Ordering::Relaxed) - baseline
}

fn params() -> CopcWriterParams {
    // A small memory budget makes the octree split on disk (as the other bounded tests do).
    CopcWriterParams::new(500).with_memory_budget_bytes(256 * 1024)
}

/// Merge of a PLY and a PCD with `per_file` points each.
fn merge_peak(per_file: usize) -> usize {
    let dir = tempfile::tempdir().expect("tempdir");
    let paths = write_inputs(dir.path(), per_file);
    let output = dir.path().join("out.copc.laz");
    let mut timings = ConversionStageTimings::default();
    peak_of(|| {
        convert_paths_to_copc_and_timings(
            &paths[..2],
            &output,
            dir.path(),
            &params(),
            &NeverCancel,
            |_| {},
            &mut timings,
        )
        .expect("merge");
    })
}

/// The existing single-file import of `all.ply` (`2 * per_file` points, the reference).
fn single_file_peak(per_file: usize) -> usize {
    let dir = tempfile::tempdir().expect("tempdir");
    let paths = write_inputs(dir.path(), per_file);
    let output = dir.path().join("out.copc.laz");
    peak_of(|| {
        convert_path_to_copc(
            &paths[2],
            &output,
            dir.path(),
            &params(),
            &NeverCancel,
            None,
            |_| {},
        )
        .expect("single import");
    })
}

/// The single-file import has some memory that grows with the point count inside the writer
/// (not in this crate). The merge must not add to it: for the same total number of points,
/// it must stay close to the single-file import. A merge that collected the points in a `Vec`
/// would add tens of bytes per point on top (400k points: > 15 MB).
#[test]
fn point_merge_does_not_use_more_memory_than_a_single_file_import() {
    let total = 400_000;
    let merged = merge_peak(total / 2);
    let single = single_file_peak(total / 2);
    eprintln!("peak heap bytes for {total} points: merge={merged} single_file={single}");
    assert!(
        merged < single + 5_000_000,
        "the merge used much more memory than a single-file import \
         (merge={merged}, single={single}); does it keep points in memory?"
    );
}
