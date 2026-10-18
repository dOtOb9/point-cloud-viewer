//! M4-17: the multi-file point merge must not hold memory proportional to the point count.
//!
//! Method: a counting global allocator records the peak number of live heap bytes during a
//! merge, and compares it with the existing single-file import of the same number of points.
//! The merge must add no per-point memory on top of the single-file import.
//!
//! Only allocations made by the thread that runs the conversion are counted (see
//! `ThreadCounter`). The merge reads and visits points on that thread; the COPC writer's
//! worker threads also allocate, and how much of that is live at the same moment depends on
//! thread scheduling (see the comment on the test for the measured noise). Counting
//! process-wide made this test flaky in CI.
//! This file has exactly one test, so that nothing else allocates on the measured thread.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::Path;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::import::convert_path_to_copc;
use pcv_convert::import::merge::convert_paths_to_copc_and_timings;
use pcv_convert::stage_timings::ConversionStageTimings;

struct CountingAlloc;

thread_local! {
    // Bytes allocated minus bytes freed by this thread. Signed, because this thread may free
    // a block that another thread allocated. `const` init: no allocation inside the allocator.
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
}

fn add_live(delta: isize) {
    LIVE.with(|live| {
        let now = live.get() + delta;
        live.set(now);
        PEAK.with(|peak| peak.set(peak.get().max(now)));
    });
}

// SAFETY: every call is forwarded unchanged to the system allocator; we only count sizes.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            add_live(layout.size() as isize);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        add_live(-(layout.size() as isize));
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if !new_ptr.is_null() {
            add_live(new_size as isize - layout.size() as isize);
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

/// Peak live heap bytes of `run` on the calling thread, minus what was live before it started.
/// The input files are written (and their text freed) before the measurement starts.
fn peak_of(run: impl FnOnce()) -> usize {
    let baseline = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(baseline));
    run();
    (PEAK.with(Cell::get) - baseline).max(0) as usize
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

/// For the same total number of points, the merge must stay close to the single-file import.
///
/// Measured (debug build, Windows, 20 runs of the old process-wide version at 400k points):
/// merge peak 35.9 to 44.3 MB, single-file peak 37.6 to 48.5 MB, so the difference between
/// the two ranged from -12.5 to +6.6 MB from run to run, and CI saw +5.15 MB. That noise comes
/// from the writer's threads. Counting only the calling thread gave 1059680 bytes (merge) and
/// 1057466 bytes (single file) in every one of 10 runs at 100k and at 400k points, so the
/// number no longer depends on the point count or on scheduling.
///
/// Margin: 1 MB, against a difference of about 2 KB. A merge that kept the points in a `Vec`
/// would add far more: with a deliberately added `Vec<RawPoint>` per file the merge peak rose
/// by 2.1 MB at 100k, 4.2 MB at 200k and 8.4 MB at 400k points (about 21 B per point).
// At the 200k points used here that is 4.2 MB, four times the margin (verified: the test fails).
#[test]
fn point_merge_does_not_use_more_memory_than_a_single_file_import() {
    let total = 200_000;
    let merged = merge_peak(total / 2);
    let single = single_file_peak(total / 2);
    eprintln!("peak heap bytes for {total} points: merge={merged} single_file={single}");
    assert!(
        merged < single + 1_000_000,
        "the merge used much more memory than a single-file import \
         (merge={merged}, single={single}); does it keep points in memory?"
    );
}
