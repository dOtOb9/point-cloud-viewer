//! Tests of `thin_path` / `filter_path` on synthetic COPC files (tiling independence,
//! attributes, SOR's two passes, zero points, cancel, the tile size bound).

// `expect_err` needs `Debug` on the success types, which the helpers do not derive.
#![allow(clippy::err_expect)]

use super::*;

use std::collections::{BTreeMap, BTreeSet};

use copc_core::NeverCancel;
use copc_writer::{
    write_source, CopcPointFields, CopcPointSource, CopcWriteMetadata, CopcWriterParams,
};
use pcv_core::thin::{GridKeep, ThinKind};

struct Source(Vec<CopcPointFields>);

impl CopcPointSource for Source {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn xyz(&self, i: usize) -> copc_core::Result<(f64, f64, f64)> {
        Ok((self.0[i].x, self.0[i].y, self.0[i].z))
    }
    fn fields_into(&self, i: usize, out: &mut CopcPointFields) -> copc_core::Result<()> {
        out.clone_from(&self.0[i]);
        Ok(())
    }
}

/// `id` is stored in `gps_time`; intensity, classification and colour are derived
/// from it so that attribute preservation can be checked.
fn field(x: f64, y: f64, z: f64, id: u32) -> CopcPointFields {
    CopcPointFields {
        x,
        y,
        z,
        intensity: (id % 60000) as u16,
        return_number: 1,
        number_of_returns: 1,
        synthetic: 0,
        key_point: 0,
        withheld: 0,
        overlap: 0,
        scan_channel: 0,
        scan_direction_flag: 0,
        edge_of_flight_line: 0,
        classification: (id % 7) as u8,
        user_data: 0,
        scan_angle: 0.0,
        point_source_id: 1,
        gps_time: f64::from(id),
        red: (id % 251) as u16,
        green: (id % 241) as u16,
        blue: (id % 239) as u16,
        extra_bytes: Vec::new(),
    }
}

/// Deterministic numbers in [0, 1).
fn rng(seed: u64) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 33) as f64) / f64::from(1u32 << 31)
    }
}

const CLUSTER_POINTS: u32 = 5400;
const TOTAL_POINTS: u32 = 6000;

/// Ids `0..CLUSTER_POINTS` are three dense clusters; the rest is a sparse background
/// over 200 x 200, so outlier filters must keep the former and drop the latter.
fn cluster_points() -> Vec<CopcPointFields> {
    let mut next = rng(7);
    let mut v = Vec::new();
    for id in 0..CLUSTER_POINTS {
        let (ox, oy) = match id % 3 {
            0 => (1010.0, 2010.0),
            1 => (1100.0, 2060.0),
            _ => (1170.0, 2150.0),
        };
        v.push(field(
            ox + next() * 6.0,
            oy + next() * 6.0,
            next() * 4.0,
            id,
        ));
    }
    for id in CLUSTER_POINTS..TOTAL_POINTS {
        v.push(field(
            1000.0 + next() * 200.0,
            2000.0 + next() * 200.0,
            next() * 10.0,
            id,
        ));
    }
    v
}

fn write_copc(dir: &Path, points: Vec<CopcPointFields>) -> PathBuf {
    let bounds = points.iter().fold(
        copc_core::Bounds::point(points[0].x, points[0].y, points[0].z),
        |mut b, p| {
            b.extend(p.x, p.y, p.z);
            b
        },
    );
    let path = dir.join("source.copc.laz");
    write_source(
        &path,
        &Source(points),
        true,
        bounds,
        &CopcWriterParams::new(300),
        &CopcWriteMetadata::default(),
    )
    .expect("write source copc");
    path
}

fn tiling(cap: u64) -> TilingParams {
    TilingParams {
        cap_points: cap,
        // A huge minimum gives exactly one tile (the reference).
        min_tile_size: if cap >= 1_000_000 { 1.0e6 } else { 0.0 },
    }
}

/// id (gps_time bits) -> (x, y, z, intensity, class, rgb) of every output point.
type Attrs = (f64, f64, f64, u16, u8, [u16; 3]);

fn read_all(path: &Path) -> BTreeMap<u64, Attrs> {
    let mut reader = CopcReader::from_path(path).expect("open output");
    let keys: Vec<_> = reader
        .file()
        .hierarchy_entries()
        .filter(|e| e.has_point_data())
        .map(|e| e.key)
        .collect();
    let mut out = BTreeMap::new();
    for key in keys {
        for p in reader.read_node(key).expect("read node") {
            let attrs = (
                p.x,
                p.y,
                p.z,
                p.intensity,
                u8::from(p.classification),
                p.color.map_or([0, 0, 0], |c| [c.red, c.green, c.blue]),
            );
            assert!(
                out.insert(p.gps_time.unwrap_or(f64::NAN).to_bits(), attrs)
                    .is_none(),
                "twice"
            );
        }
    }
    out
}

struct Run {
    summary: ThinFilterSummary,
    points: BTreeMap<u64, Attrs>,
    last_progress: ReadProgress,
}

fn run_thin(source: &Path, settings: &ThinSettings, cap: u64) -> Run {
    let dir = tempfile::tempdir().expect("dir");
    let spill = tempfile::tempdir().expect("spill");
    let output = dir.path().join("thin.copc.laz");
    let mut timings = ConversionStageTimings::default();
    let mut last = ReadProgress {
        points_read: 0,
        total_points: 0,
    };
    let summary = thin_path(
        source,
        settings,
        &tiling(cap),
        &output,
        spill.path(),
        &CopcWriterParams::new(500),
        &NeverCancel,
        |p| last = p,
        &mut timings,
    )
    .expect("thin");
    Run {
        summary,
        points: read_all(&output),
        last_progress: last,
    }
}

fn run_filter(source: &Path, filter: &OutlierFilter, cap: u64) -> Result<Run, ThinFilterError> {
    let dir = tempfile::tempdir().expect("dir");
    let spill = tempfile::tempdir().expect("spill");
    let output = dir.path().join("filtered.copc.laz");
    let mut timings = ConversionStageTimings::default();
    let mut last = ReadProgress {
        points_read: 0,
        total_points: 0,
    };
    let summary = filter_path(
        source,
        filter,
        &tiling(cap),
        &output,
        spill.path(),
        &CopcWriterParams::new(500),
        &NeverCancel,
        |p| last = p,
        &mut timings,
    )?;
    assert!(output.exists());
    Ok(Run {
        summary,
        points: read_all(&output),
        last_progress: last,
    })
}

fn ids(run: &Run) -> BTreeSet<u64> {
    run.points.keys().copied().collect()
}

#[test]
fn grid_thinning_keeps_one_original_point_per_cell_and_all_attributes() {
    let dir = tempfile::tempdir().expect("dir");
    let source_points = cluster_points();
    let source = write_copc(dir.path(), source_points.clone());
    let settings = ThinSettings {
        size: 2.0,
        kind: ThinKind::Grid(GridKeep::NearestCentre),
    };
    let run = run_thin(&source, &settings, 1500);
    assert_eq!(run.summary.kept_points as usize, run.points.len());
    assert!(run.summary.tile_count > 4, "{:?}", run.summary);

    // One point per cell, every occupied cell present.
    let cell = |x: f64, y: f64| ((x / 2.0).floor() as i64, (y / 2.0).floor() as i64);
    // Cells come from the coordinates as stored in the source file (rounded to its
    // scale), which is what thinning sees; the original floats can differ by the scale.
    let stored = read_all(&source);
    let occupied: BTreeSet<_> = stored.values().map(|a| cell(a.0, a.1)).collect();
    let by_id: BTreeMap<u64, &CopcPointFields> = source_points
        .iter()
        .map(|p| (p.gps_time.to_bits(), p))
        .collect();
    let mut seen = BTreeSet::new();
    for attrs in run.points.values() {
        assert!(seen.insert(cell(attrs.0, attrs.1)), "two points in a cell");
    }
    assert_eq!(seen, occupied);

    // Attributes are those of the original point.
    for (id, attrs) in &run.points {
        let original = by_id[id];
        assert!((attrs.0 - original.x).abs() < 1e-3);
        assert!((attrs.1 - original.y).abs() < 1e-3);
        assert!((attrs.2 - original.z).abs() < 1e-3);
        assert_eq!(attrs.3, original.intensity);
        assert_eq!(attrs.4, original.classification);
        assert_eq!(attrs.5, [original.red, original.green, original.blue]);
    }
}

#[test]
fn thinning_does_not_depend_on_the_tiling_and_progress_reaches_the_total() {
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    for kind in [ThinKind::Grid(GridKeep::Highest), ThinKind::Voxel] {
        let settings = ThinSettings { size: 1.5, kind };
        let one = run_thin(&source, &settings, 1_000_000);
        assert_eq!(one.summary.tile_count, 1);
        let many = run_thin(&source, &settings, 1200);
        assert!(many.summary.tile_count > 4);
        assert_eq!(ids(&many), ids(&one), "{kind:?}");
        assert_eq!(many.last_progress.points_read, u64::from(TOTAL_POINTS));
        assert_eq!(many.last_progress.total_points, u64::from(TOTAL_POINTS));
        assert_eq!(many.summary.core_points_read, u64::from(TOTAL_POINTS));
    }
}

#[test]
fn the_largest_tile_is_bounded_by_the_cap_not_by_the_total() {
    // Memory bound: one tile (+ margin) is all that is held. Check the tile's size.
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let settings = ThinSettings {
        size: 1.0,
        kind: ThinKind::Voxel,
    };
    let cap = 1200;
    let run = run_thin(&source, &settings, cap);
    // The clusters are dense, so the estimate can be off; a factor 2 is allowed.
    assert!(
        run.summary.largest_tile_points <= 2 * cap,
        "largest {} cap {cap}",
        run.summary.largest_tile_points
    );
    assert!(run.summary.largest_tile_points < u64::from(TOTAL_POINTS) / 2);
}

#[test]
fn ror_drops_the_sparse_background_and_keeps_the_clusters() {
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let filter = OutlierFilter::Ror(RorSettings {
        radius: 1.5,
        min_neighbors: 4,
    });
    let one = run_filter(&source, &filter, 1_000_000).expect("ror");
    let many = run_filter(&source, &filter, 1200).expect("ror");
    assert!(many.summary.tile_count > 4);
    assert_eq!(ids(&many), ids(&one));
    let cluster_kept = many
        .points
        .keys()
        .filter(|bits| f64::from_bits(**bits) < f64::from(CLUSTER_POINTS))
        .count();
    assert_eq!(cluster_kept, CLUSTER_POINTS as usize);
    assert!(many.points.len() < CLUSTER_POINTS as usize + 10);
    assert!(many.summary.sor.is_none());
    assert_eq!(many.summary.core_points_read, u64::from(TOTAL_POINTS));
}

#[test]
fn sor_reads_twice_and_its_statistics_do_not_depend_on_the_tiling() {
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let filter = OutlierFilter::Sor(SorSettings {
        k: 8,
        n_sigma: 1.0,
        search_radius: 12.0,
    });
    let one = run_filter(&source, &filter, 1_000_000).expect("sor");
    let many = run_filter(&source, &filter, 1200).expect("sor");
    assert!(many.summary.tile_count > 8);
    assert_eq!(ids(&many), ids(&one));
    // Two passes: every point is a core point once per pass.
    assert_eq!(many.summary.core_points_read, 2 * u64::from(TOTAL_POINTS));
    assert_eq!(many.last_progress.points_read, 2 * u64::from(TOTAL_POINTS));
    assert_eq!(many.last_progress.total_points, 2 * u64::from(TOTAL_POINTS));
    let (a, b) = match (one.summary.sor, many.summary.sor) {
        (Some(a), Some(b)) => (a, b),
        other => panic!("no SOR summary: {other:?}"),
    };
    // Only the order of summation differs between tilings.
    assert!((a.mean - b.mean).abs() <= 1e-9 * a.mean);
    assert!((a.std - b.std).abs() <= 1e-9 * a.std);
    assert!((a.threshold - b.threshold).abs() <= 1e-9 * a.threshold);
    // Clusters survive; most of the sparse background goes.
    let cluster_kept = many
        .points
        .keys()
        .filter(|bits| f64::from_bits(**bits) < f64::from(CLUSTER_POINTS))
        .count();
    assert!(cluster_kept > 5000, "cluster points kept: {cluster_kept}");
    assert!(many.points.len() < cluster_kept + 100);
}

#[test]
fn nothing_kept_is_an_error_and_creates_no_output() {
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let filter = OutlierFilter::Ror(RorSettings {
        radius: 0.5,
        min_neighbors: 100_000,
    });
    let err = run_filter(&source, &filter, 1500).err().expect("error");
    assert!(matches!(err, ThinFilterError::EmptyResult), "{err}");
}

#[test]
fn bad_settings_are_rejected() {
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let filter = OutlierFilter::Sor(SorSettings {
        k: 0,
        n_sigma: 1.0,
        search_radius: 5.0,
    });
    let err = run_filter(&source, &filter, 1500).err().expect("error");
    assert!(matches!(err, ThinFilterError::Settings(_)), "{err}");
}

#[test]
fn cancel_stops_the_run() {
    struct CancelNow;
    impl CancelCheck for CancelNow {
        fn check(&self) -> copc_core::Result<()> {
            Err(copc_core::Error::Cancelled)
        }
    }
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let spill = tempfile::tempdir().expect("spill");
    let output = dir.path().join("cancelled.copc.laz");
    let mut timings = ConversionStageTimings::default();
    let err = thin_path(
        &source,
        &ThinSettings {
            size: 1.0,
            kind: ThinKind::Voxel,
        },
        &tiling(1500),
        &output,
        spill.path(),
        &CopcWriterParams::new(500),
        &CancelNow,
        |_| {},
        &mut timings,
    )
    .err()
    .expect("error");
    assert!(err.is_cancelled(), "{err}");
    assert!(!output.exists());
}

// ---- G3-5: the step-by-step job used by the Web build gives the same points ----

/// Runs `ThinFilterJob` to the end. Returns the ids (gps_time bits) of the kept points, the
/// number of `advance` calls, the largest batch one call returned and the largest tile held.
fn run_job(
    source: &Path,
    mode: pcv_core::thin_filter_job::JobMode,
    cap: u64,
) -> (BTreeSet<u64>, u64, usize, u64) {
    let path = source.to_path_buf();
    let open = move || CopcReader::from_path(&path);
    let mut job = pcv_core::thin_filter_job::ThinFilterJob::new(mode, open, cap).expect("job");
    let mut ids = BTreeSet::new();
    let mut calls = 0u64;
    let mut largest_batch = 0usize;
    loop {
        let step = job.advance().expect("advance");
        calls += 1;
        largest_batch = largest_batch.max(step.kept.len());
        for record in &step.kept {
            assert!(ids.insert(record.gps_time.to_bits()), "twice");
        }
        if step.done {
            assert_eq!(
                step.points_read, step.total_points,
                "progress reaches the total"
            );
            break;
        }
    }
    assert_eq!(job.counters().kept_points as usize, ids.len());
    (
        ids,
        calls,
        largest_batch,
        job.counters().largest_tile_points,
    )
}

#[test]
fn the_step_job_keeps_the_same_points_as_thin_path_and_filter_path() {
    use pcv_core::thin_filter_job::JobMode;
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let cap = 1200;

    for kind in [ThinKind::Grid(GridKeep::Lowest), ThinKind::Voxel] {
        let settings = ThinSettings { size: 1.5, kind };
        let reference = run_thin(&source, &settings, cap);
        let (kept, calls, batch, largest_tile) = run_job(&source, JobMode::Thin(settings), cap);
        assert_eq!(kept, ids(&reference), "{kind:?}");
        assert!(calls > 5, "the work is split in steps: {calls}");
        assert!(batch as u64 <= 2 * cap, "batch {batch}");
        assert_eq!(largest_tile, reference.summary.largest_tile_points);
    }

    let ror = RorSettings {
        radius: 1.5,
        min_neighbors: 4,
    };
    let reference = run_filter(&source, &OutlierFilter::Ror(ror), cap).expect("ror");
    let (kept, _, _, _) = run_job(&source, JobMode::Ror(ror), cap);
    assert_eq!(kept, ids(&reference));

    let sor = SorSettings {
        k: 8,
        n_sigma: 1.0,
        search_radius: 12.0,
    };
    let reference = run_filter(&source, &OutlierFilter::Sor(sor), cap).expect("sor");
    let (kept, _, _, largest_tile) = run_job(&source, JobMode::Sor(sor), cap);
    assert_eq!(kept, ids(&reference));
    assert!(
        largest_tile < u64::from(TOTAL_POINTS) / 2,
        "memory is one tile: {largest_tile}"
    );
}

#[test]
fn the_step_job_rejects_bad_settings() {
    use pcv_core::thin_filter_job::{JobError, JobMode, ThinFilterJob};
    let dir = tempfile::tempdir().expect("dir");
    let source = write_copc(dir.path(), cluster_points());
    let bad = JobMode::Sor(SorSettings {
        k: 0,
        n_sigma: 1.0,
        search_radius: 5.0,
    });
    let err = ThinFilterJob::new(bad, move || CopcReader::from_path(&source), 1500)
        .err()
        .expect("error");
    assert!(matches!(err, JobError::Settings(_)), "{err}");
}
