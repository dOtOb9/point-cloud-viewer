//! L2-C: "read a COPC file and write only the points that match a condition into a
//! new COPC file" (desktop and Android).
//!
//! This is the core of the point-cloud tools (point selection, cross section).
//! A new layer is created from a chosen layer
//! (`TaskSheets/ADR-0018-layer-centric-operations.md`), so **the source file is never
//! modified**.
//!
//! # Design: no new octree / writer
//!
//! It works the same way as merging (`merge.rs`). The iterator that yields matching
//! points one by one (`pcv_core::extract::ExtractPoints`, which reads only the nodes
//! that intersect the condition) is handed to `vendor/copc-writer`'s
//! `write_streaming_with_cancel_and_timings`, which does the octree split, LAZ
//! compression and COPC hierarchy assembly. The reader holds only one node of points
//! at a time and the writer spills to temporary files, so **memory does not grow
//! with the point count** (see the `ExtractPoints` docs and the test
//! `buffer_is_bounded_by_largest_node`).
//!
//! Rejected alternative: collect the matching points into a `Vec` and write them
//! afterwards. A wide selection can be hundreds of millions of points, so memory
//! would grow with the point count.
//!
//! # Zero points
//!
//! If no point matches, no output is created and `ExtractError::EmptySelection` is
//! returned. The first matching point is taken before the writer starts, so no
//! temporary file is created in that case either.
//!
//! # Attributes
//!
//! Points read with `read_node` go through `LasPointRecord::from_las_point`, so RGB,
//! intensity, classification, GPS time, return numbers, etc. are carried over. The
//! layout (point format, color, extra bytes) and the output metadata (scale/offset,
//! CRS) are built from the source COPC header with the same functions as `merge.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use copc_core::{CancelCheck, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
use pcv_core::extract::{ExtractFilter, ExtractPoints, ExtractStats};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;
use crate::write_metadata::copc_write_metadata_from_source_header;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    /// User-facing text, shown on screen as is.
    #[error("選んだ範囲に点がありません")]
    EmptySelection,
    #[error("抽出の条件が正しくありません: {0}")]
    Filter(String),
    #[error("{path}: 点群(COPC)として開けませんでした: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: copc_core::Error,
    },
    #[error("{path}: ヘッダーを読めませんでした: {source}")]
    OpenHeader {
        path: PathBuf,
        #[source]
        source: las::Error,
    },
    #[error("点を読めませんでした: {0}")]
    Read(#[source] copc_core::Error),
    #[error("COPCの書き出しに失敗しました: {0}")]
    Write(#[source] copc_core::Error),
}

impl ExtractError {
    /// Whether it stopped because of cancellation (shown as "cancelled" on screen).
    pub fn is_cancelled(&self) -> bool {
        matches!(
            self,
            ExtractError::Read(copc_core::Error::Cancelled)
                | ExtractError::Write(copc_core::Error::Cancelled)
        )
    }
}

/// Result of an extraction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtractSummary {
    /// Number of points written.
    pub point_count: u64,
    pub stats: ExtractStats,
}

/// Writes only the points of `source` (COPC) that match `filter` into `output` (COPC).
///
/// - `on_progress`: called after each node is read. `points_read` is the number of
///   points read so far and `total_points` the total of the nodes that will be read
///   (only nodes intersecting the condition, so smaller than the source's total).
///   It is not called during the write phase that follows.
/// - `cancel`: checked on both the read side (per node) and the write side.
#[allow(clippy::too_many_arguments)]
pub fn extract_path_and_timings<F>(
    source: &Path,
    filter: ExtractFilter,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    mut on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<ExtractSummary, ExtractError>
where
    F: FnMut(ReadProgress) + Send,
{
    filter.validate().map_err(ExtractError::Filter)?;

    // Layout and output metadata come from the header only, read with `las`
    // (same as `summarize_headers` in `merge.rs`; no point data is read here).
    let header_reader =
        las::Reader::from_path(source).map_err(|source_err| ExtractError::OpenHeader {
            path: source.to_path_buf(),
            source: source_err,
        })?;
    let layout = StreamingLayout::from_las_header(header_reader.header());
    let metadata = copc_write_metadata_from_source_header(header_reader.header());
    drop(header_reader);

    let copc_reader = CopcReader::from_path(source).map_err(|e| ExtractError::Open {
        path: source.to_path_buf(),
        source: e,
    })?;
    let mut points = ExtractPoints::new(copc_reader, filter).map_err(ExtractError::Read)?;

    // The callback keeps running after the iterator is handed to the writer, so the
    // latest stats are left in a shared cell.
    let last_stats = Arc::new(Mutex::new(points.stats()));
    let last_stats_in_callback = Arc::clone(&last_stats);
    points.set_node_callback(Box::new(move |stats: &ExtractStats| {
        if let Ok(mut guard) = last_stats_in_callback.lock() {
            *guard = *stats;
        }
        cancel.check()?;
        on_progress(ReadProgress {
            points_read: stats.points_scanned,
            total_points: stats.candidate_points,
        });
        Ok(())
    }));

    // Take the first point before starting the writer; with none, fail without writing.
    let first = match points.next() {
        None => return Err(ExtractError::EmptySelection),
        Some(Err(e)) => return Err(ExtractError::Read(e)),
        Some(Ok(record)) => record,
    };
    // Count the points handed to the writer (`ExtractStats::points_matched` cannot be
    // read back once the iterator has been moved into the writer).
    let written = Arc::new(AtomicU64::new(0));
    let written_in_iter = Arc::clone(&written);
    let all_points = std::iter::once(Ok(first))
        .chain(points)
        .inspect(move |item| {
            if item.is_ok() {
                written_in_iter.fetch_add(1, Ordering::Relaxed);
            }
        });

    let mut ingest = copc_writer::IngestStageTimings::default();
    let mut post = copc_writer::PostProcessStageTimings::default();
    write_streaming_with_cancel_and_timings(
        output,
        layout,
        all_points,
        params,
        &metadata,
        spill_dir,
        cancel,
        Some(&mut ingest),
        Some(&mut post),
    )
    .map_err(ExtractError::Write)?;
    *timings = ConversionStageTimings::from_parts(ingest, post);

    // Stats as of the last node read (they include the last node), plus the count.
    let mut stats = last_stats.lock().map(|guard| *guard).map_err(|_| {
        ExtractError::Read(copc_core::Error::InvalidInput("統計の取得に失敗".into()))
    })?;
    let point_count = written.load(Ordering::Relaxed);
    stats.points_matched = point_count;
    Ok(ExtractSummary { point_count, stats })
}

#[cfg(test)]
mod tests {
    use super::*;

    use copc_core::NeverCancel;
    use pcv_core::extract::OrientedBox;
    use pcv_core::CopcFile;

    /// Writes a LAS (PDRF7, with color) of a cube grid with `side` points per edge
    /// (1 m spacing, origin (1000, 2000, 30)). Intensity is the running index (low
    /// 16 bits), classification is index % 5, color is derived from the position.
    fn write_grid_las(path: &Path, side: u32) {
        let mut builder = las::Builder::from((1, 4));
        builder.point_format = las::point::Format::new(7).expect("PDRF7");
        builder.transforms = las::Vector {
            x: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            y: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer = las::Writer::new(std::io::BufWriter::new(file), header).expect("writer");
        let mut n: u32 = 0;
        for ix in 0..side {
            for iy in 0..side {
                for iz in 0..side {
                    let point = las::Point {
                        x: 1000.0 + f64::from(ix),
                        y: 2000.0 + f64::from(iy),
                        z: 30.0 + f64::from(iz),
                        intensity: (n & 0xFFFF) as u16,
                        classification: las::point::Classification::new((n % 5) as u8)
                            .expect("classification"),
                        gps_time: Some(f64::from(n)),
                        color: Some(las::Color {
                            red: (ix * 100) as u16,
                            green: (iy * 100) as u16,
                            blue: (iz * 100) as u16,
                        }),
                        ..Default::default()
                    };
                    writer.write_point(point).expect("write point");
                    n += 1;
                }
            }
        }
        writer.close().expect("close");
    }

    /// Converts the grid LAS into a COPC with at most `max_points_per_node` per node.
    fn make_copc(dir: &Path, side: u32, max_points_per_node: u32) -> PathBuf {
        let las_path = dir.join("grid.las");
        write_grid_las(&las_path, side);
        let copc_path = dir.join("grid.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        crate::streaming::convert_path(
            &las_path,
            &copc_path,
            spill.path(),
            &CopcWriterParams::new(max_points_per_node),
            &NeverCancel,
            |_| {},
        )
        .expect("convert");
        copc_path
    }

    fn box_filter(min: [f64; 3], max: [f64; 3]) -> ExtractFilter {
        ExtractFilter::OrientedBox(OrientedBox {
            center: [
                (min[0] + max[0]) / 2.0,
                (min[1] + max[1]) / 2.0,
                (min[2] + max[2]) / 2.0,
            ],
            axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            half_extents: [
                (max[0] - min[0]) / 2.0,
                (max[1] - min[1]) / 2.0,
                (max[2] - min[2]) / 2.0,
            ],
        })
    }

    fn run(
        source: &Path,
        filter: ExtractFilter,
        output: &Path,
    ) -> Result<ExtractSummary, ExtractError> {
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        extract_path_and_timings(
            source,
            filter,
            output,
            spill.path(),
            &CopcWriterParams::new(500),
            &NeverCancel,
            |_| {},
            &mut timings,
        )
    }

    /// Cutting with a box outputs only the points inside, keeping coordinates,
    /// intensity, classification and color.
    #[test]
    fn extracts_points_in_box_and_keeps_attributes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500); // 8000 points
                                                     // x: 1005..1009, y: 2002..2004, z: 30..39 -> 5*3*10 = 150 points
        let filter = box_filter([1004.5, 2001.5, 29.5], [1009.5, 2004.5, 39.5]);
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        assert_eq!(summary.point_count, 150);

        // Read every point of the output and check it against the grid's rules.
        let mut reader = CopcReader::from_path(&output).expect("open output");
        assert_eq!(reader.header().number_of_points(), 150);
        let keys: Vec<_> = reader
            .file()
            .hierarchy_entries()
            .filter(|e| e.has_point_data())
            .map(|e| e.key)
            .collect();
        let mut seen = 0usize;
        for key in keys {
            for p in reader.read_node(key).expect("read node") {
                let (ix, iy, iz) = (p.x - 1000.0, p.y - 2000.0, p.z - 30.0);
                assert!((5.0..=9.0).contains(&ix) && (2.0..=4.0).contains(&iy));
                assert!((0.0..=9.0).contains(&iz));
                let color = p.color.expect("color is carried over");
                assert_eq!(f64::from(color.red), ix * 100.0);
                assert_eq!(f64::from(color.green), iy * 100.0);
                assert_eq!(f64::from(color.blue), iz * 100.0);
                // intensity = low 16 bits of the index (ix*400+iy*20+iz), class = index % 5.
                let n = (ix as u32) * 400 + (iy as u32) * 20 + iz as u32;
                assert_eq!(u32::from(p.intensity), n & 0xFFFF);
                assert_eq!(u8::from(p.classification), (n % 5) as u8);
                seen += 1;
            }
        }
        assert_eq!(seen, 150);

        // The header bounds shrink to the extracted points.
        let file = CopcFile::open(&output).expect("pcv-core open");
        assert_eq!(file.info().min[0], 1005.0);
        assert_eq!(file.info().max[0], 1009.0);
    }

    /// A screen polygon works too (all depths along z are selected).
    #[test]
    fn extracts_points_inside_screen_polygon_for_all_depths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500);
        // Top-down orthographic-like view: ndc.x = 0.1*(x-1000), ndc.y = 0.1*(y-2000), w = 1.
        let mut m = [0.0; 16];
        m[0] = 0.1;
        m[12] = -100.0;
        m[5] = 0.1;
        m[13] = -200.0;
        m[10] = 1.0;
        m[15] = 1.0;
        let filter = ExtractFilter::ScreenPolygon(pcv_core::extract::ScreenPolygon {
            view_proj: m,
            polygon_ndc: vec![[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]],
        });
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        // x in 1002.5..1007.5 -> 3..=7 (5 values), same for y, all 20 values of z.
        assert_eq!(summary.point_count, 5 * 5 * 20);
        assert!(summary.stats.nodes_read < summary.stats.nodes_total);
    }

    /// Nodes that do not intersect the condition are not read.
    #[test]
    fn skips_nodes_that_do_not_intersect() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500);
        let filter = box_filter([1000.0, 2000.0, 30.0], [1002.0, 2002.0, 32.0]);
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        assert_eq!(summary.point_count, 27); // 3x3x3 for 0..=2
        let s = summary.stats;
        assert!(s.nodes_total > 4, "expects several nodes: {s:?}");
        assert!(s.nodes_read < s.nodes_total, "read every node: {s:?}");
        assert_eq!(s.nodes_read, s.nodes_selected);
        assert!(s.points_scanned < 8000);
    }

    /// With zero points it is an error and no output file is created.
    #[test]
    fn empty_selection_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 500);
        let filter = box_filter([5000.0, 5000.0, 5000.0], [5001.0, 5001.0, 5001.0]);
        let output = dir.path().join("out.copc.laz");
        let err = run(&source, filter, &output).expect_err("zero points is an error");
        assert!(matches!(err, ExtractError::EmptySelection));
        assert_eq!(err.to_string(), "選んだ範囲に点がありません");
        assert!(!output.exists());
    }

    /// Also an error when the box intersects a node but contains no point (node
    /// culling is coarse).
    #[test]
    fn empty_selection_inside_a_node_is_also_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 500);
        // A small box between grid points (integer coordinates).
        let filter = box_filter([1000.2, 2000.2, 30.2], [1000.4, 2000.4, 30.4]);
        let output = dir.path().join("out.copc.laz");
        let err = run(&source, filter, &output).expect_err("zero points is an error");
        assert!(matches!(err, ExtractError::EmptySelection));
    }

    /// Bound on what is held: the reader never holds more than one node of points.
    /// From a source of 8000 points with at most 500 per node (so many nodes),
    /// selecting every point still holds at most one node (about 500) at a time, far
    /// below the total (8000).
    #[test]
    fn buffer_is_bounded_by_largest_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500);
        let filter = box_filter([0.0, 0.0, 0.0], [10_000.0, 10_000.0, 10_000.0]);
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        assert_eq!(summary.point_count, 8000);

        let reader = CopcReader::from_path(&source).expect("open source");
        let largest_node = reader
            .file()
            .hierarchy_entries()
            .filter(|e| e.has_point_data())
            .map(|e| e.point_count)
            .max()
            .expect("nodes") as usize;
        let s = summary.stats;
        assert!(s.nodes_read > 8, "enough nodes: {s:?}");
        assert_eq!(s.max_buffered_points, largest_node);
        assert!(s.max_buffered_points <= 500, "{s:?}");
        assert!(s.max_buffered_points * 10 < 8000);
    }

    /// Progress is reported per node and ends at the number of points to be read.
    #[test]
    fn reports_progress_per_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 200);
        let filter = box_filter([0.0, 0.0, 0.0], [10_000.0, 10_000.0, 10_000.0]);
        let output = dir.path().join("out.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        let calls = Arc::new(Mutex::new(Vec::<ReadProgress>::new()));
        let calls_in = Arc::clone(&calls);
        let mut timings = ConversionStageTimings::default();
        extract_path_and_timings(
            &source,
            filter,
            &output,
            spill.path(),
            &CopcWriterParams::new(200),
            &NeverCancel,
            move |p| calls_in.lock().expect("lock").push(p),
            &mut timings,
        )
        .expect("extract");
        let calls = calls.lock().expect("lock");
        assert!(calls.len() > 1);
        let last = calls.last().expect("last");
        assert_eq!(last.points_read, 1000);
        assert_eq!(last.total_points, 1000);
    }

    /// Cancellation works during the scan (it does not wait for the writer's check).
    #[test]
    fn cancel_stops_during_scan() {
        struct CancelNow;
        impl CancelCheck for CancelNow {
            fn check(&self) -> copc_core::Result<()> {
                Err(copc_core::Error::Cancelled)
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 200);
        let filter = box_filter([0.0, 0.0, 0.0], [10_000.0, 10_000.0, 10_000.0]);
        let output = dir.path().join("out.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        let err = extract_path_and_timings(
            &source,
            filter,
            &output,
            spill.path(),
            &CopcWriterParams::new(200),
            &CancelNow,
            |_| {},
            &mut timings,
        )
        .expect_err("cancelled");
        assert!(err.is_cancelled(), "{err}");
        assert!(!output.exists());
    }

    /// A file that is not a COPC fails with a clear message.
    #[test]
    fn non_copc_input_fails_with_clear_message() {
        let dir = tempfile::tempdir().expect("tempdir");
        let las_path = dir.path().join("plain.las");
        write_grid_las(&las_path, 3);
        let filter = box_filter([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
        let output = dir.path().join("out.copc.laz");
        let err = run(&las_path, filter, &output).expect_err("not a COPC");
        assert!(matches!(err, ExtractError::Open { .. }), "{err}");
    }

    /// Merging (`merge.rs`) accepts COPC inputs as they are; counts add up.
    #[test]
    fn merge_accepts_copc_inputs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a_dir = dir.path().join("a");
        let b_dir = dir.path().join("b");
        std::fs::create_dir_all(&a_dir).expect("mkdir");
        std::fs::create_dir_all(&b_dir).expect("mkdir");
        let a = make_copc(&a_dir, 6, 100);
        // b overlaps a in coordinates, but points are counted separately.
        let b = make_copc(&b_dir, 5, 100);
        let output = dir.path().join("merged.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        let summary = crate::merge::merge_paths_and_timings(
            vec![a, b],
            &output,
            spill.path(),
            &CopcWriterParams::new(100),
            &NeverCancel,
            |_| {},
            &mut timings,
        )
        .expect("merging COPC inputs");
        assert_eq!(summary.declared_points_total, 216 + 125);
        let file = CopcFile::open(&output).expect("open merged");
        assert_eq!(file.info().point_count, 216 + 125);
    }
}
