//! G1-3: rasterise a COPC file (desktop and Android).
//!
//! Streams every point of the source once into a grid of cells, then writes two
//! things:
//!
//! 1. a GeoTIFF (the deliverable), and
//! 2. a display COPC with one point per non-empty cell (so the viewer can show the
//!    raster as an ordinary layer; see `pcv_core::raster::output`).
//!
//! # Memory
//!
//! The reader is `ExtractPoints::all`: one node of points at a time. The grid holds
//! a few bytes per cell, so memory follows the **area / cell size**, never the point
//! count. The caller passes the largest number of cells it accepts, and a bigger grid
//! is refused before any point is read (`GridSpec::from_bounds`).
//!
//! # Zero points
//!
//! If no point is counted (empty cloud, or "ground only" on a cloud without class 2),
//! nothing is written and `RasterRunError::NoPoints` is returned.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use copc_core::{CancelCheck, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
use pcv_core::crs::{crs_id_from_las_header, CrsId};
use pcv_core::extract::{ExtractPoints, ExtractStats};
use pcv_core::raster::output::{missing_crs_warning, write_geotiff};
use pcv_core::raster::{
    filled_cells, CellAccumulator, DisplayPoints, GridSpec, RasterError, RasterOptions, RasterValue,
};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;
use crate::write_metadata::copc_write_metadata_from_source_header;

#[derive(Debug, thiserror::Error)]
pub enum RasterRunError {
    /// The text comes from `RasterError` (cell cap, bad cell size, ...).
    #[error("{0}")]
    Raster(#[from] RasterError),
    #[error("このレイヤーは色を持たないため、色(RGB)のラスタは作れません")]
    NoColor,
    #[error("ラスタにできる点がありません")]
    NoPoints,
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
    #[error("GeoTIFFを書き出せませんでした: {0}")]
    GeoTiffFile(#[source] std::io::Error),
}

impl RasterRunError {
    /// Whether it stopped because of cancellation (shown as "cancelled" on screen).
    pub fn is_cancelled(&self) -> bool {
        matches!(
            self,
            RasterRunError::Read(copc_core::Error::Cancelled)
                | RasterRunError::Write(copc_core::Error::Cancelled)
        )
    }
}

/// Result of a rasterisation.
#[derive(Debug, Clone, PartialEq)]
pub struct RasterSummary {
    pub width: u32,
    pub height: u32,
    /// Points that were counted (class filter applied).
    pub points_counted: u64,
    /// Points of the display COPC (= non-empty cells).
    pub display_points: u64,
    /// For the error log (for example: no CRS in the GeoTIFF).
    pub warnings: Vec<String>,
    pub stats: ExtractStats,
}

/// Rasterises `source` (COPC) into `geotiff_output` and `display_output` (COPC).
///
/// - `max_cells`: the largest grid accepted (more is refused before reading points).
/// - `on_progress`: called after each node is read, like `extract_path_and_timings`.
///   It is not called while the two files are written.
/// - `cancel`: checked per node while reading and by the COPC writer. When it stops
///   or fails, the GeoTIFF is removed too.
#[allow(clippy::too_many_arguments)]
pub fn rasterize_path_and_timings<F>(
    source: &Path,
    options: RasterOptions,
    max_cells: u64,
    geotiff_output: &Path,
    display_output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<RasterSummary, RasterRunError>
where
    F: FnMut(ReadProgress) + Send,
{
    let result = rasterize_inner(
        source,
        options,
        max_cells,
        geotiff_output,
        display_output,
        spill_dir,
        params,
        cancel,
        on_progress,
        timings,
    );
    if result.is_err() {
        // Best effort: a half-written GeoTIFF must not stay behind.
        let _ = std::fs::remove_file(geotiff_output);
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn rasterize_inner<F>(
    source: &Path,
    options: RasterOptions,
    max_cells: u64,
    geotiff_output: &Path,
    display_output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<RasterSummary, RasterRunError>
where
    F: FnMut(ReadProgress) + Send,
{
    // Layout, metadata, extent and CRS come from the header only (no point is read).
    let header_reader =
        las::Reader::from_path(source).map_err(|source_err| RasterRunError::OpenHeader {
            path: source.to_path_buf(),
            source: source_err,
        })?;
    let header = header_reader.header();
    let layout = StreamingLayout::from_las_header(header);
    let metadata = copc_write_metadata_from_source_header(header);
    let bounds = header.bounds();
    let epsg = match crs_id_from_las_header(header) {
        CrsId::Epsg(code) => Some(code),
        _ => None,
    };
    drop(header_reader);

    if options.value == RasterValue::RgbMean && !layout.has_color {
        return Err(RasterRunError::NoColor);
    }
    let spec = GridSpec::from_bounds(
        bounds.min.x,
        bounds.min.y,
        bounds.max.x,
        bounds.max.y,
        options.cell_size,
        max_cells,
    )?;
    let mut acc = CellAccumulator::new(spec, options.value, options.class_filter());

    let copc_reader = CopcReader::from_path(source).map_err(|e| RasterRunError::Open {
        path: source.to_path_buf(),
        source: e,
    })?;
    let mut points = ExtractPoints::all(copc_reader);
    let mut on_progress = on_progress;
    points.set_node_callback(Box::new(move |stats: &ExtractStats| {
        cancel.check()?;
        on_progress(ReadProgress {
            points_read: stats.points_scanned,
            total_points: stats.candidate_points,
        });
        Ok(())
    }));
    for record in points.by_ref() {
        acc.add_record(&record.map_err(RasterRunError::Read)?);
    }
    let stats = points.stats();
    drop(points);
    if acc.accepted_points() == 0 {
        return Err(RasterRunError::NoPoints);
    }
    // The last node may have been read after the final callback check.
    cancel.check().map_err(RasterRunError::Read)?;

    // 1. GeoTIFF.
    let file = File::create(geotiff_output).map_err(RasterRunError::GeoTiffFile)?;
    let mut out = BufWriter::new(file);
    write_geotiff(&acc, epsg, &mut out)?;
    std::io::Write::flush(&mut out).map_err(RasterRunError::GeoTiffFile)?;
    drop(out);

    // 2. Display COPC: one point per non-empty cell, handed to the writer lazily.
    let display_points = filled_cells(&acc);
    let records = DisplayPoints::new(&acc, usize::from(layout.extra_bytes)).map(Ok);
    let mut ingest = copc_writer::IngestStageTimings::default();
    let mut post = copc_writer::PostProcessStageTimings::default();
    write_streaming_with_cancel_and_timings(
        display_output,
        layout,
        records,
        params,
        &metadata,
        spill_dir,
        cancel,
        Some(&mut ingest),
        Some(&mut post),
    )
    .map_err(RasterRunError::Write)?;
    *timings = ConversionStageTimings::from_parts(ingest, post);

    Ok(RasterSummary {
        width: acc.spec().width,
        height: acc.spec().height,
        points_counted: acc.accepted_points(),
        display_points,
        warnings: missing_crs_warning(epsg).into_iter().collect(),
        stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use copc_core::NeverCancel;
    use tiff::decoder::{Decoder, DecodingResult};

    /// Writes a LAS (PDRF7, with colour): 10 x 10 columns at 1 m spacing from
    /// (1000, 2000); each column has 3 points at z = 10, 20, 30. The z = 10 point has
    /// class `lowest_class` (2 = ground), the others class 1. Intensity is 100 * (k + 1); colour is
    /// (ix * 1000, iy * 1000, 0). No CRS.
    fn write_columns_las(path: &Path, lowest_class: u8) {
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
        let file = File::create(path).expect("create las");
        let mut writer = las::Writer::new(BufWriter::new(file), header).expect("writer");
        for ix in 0..10u32 {
            for iy in 0..10u32 {
                for k in 0..3u32 {
                    let point = las::Point {
                        x: 1000.0 + f64::from(ix),
                        y: 2000.0 + f64::from(iy),
                        z: 10.0 * f64::from(k + 1),
                        intensity: (100 * (k + 1)) as u16,
                        classification: las::point::Classification::new(if k == 0 {
                            lowest_class
                        } else {
                            1
                        })
                        .expect("classification"),
                        gps_time: Some(0.0),
                        color: Some(las::Color {
                            red: (ix * 1000) as u16,
                            green: (iy * 1000) as u16,
                            blue: 0,
                        }),
                        ..Default::default()
                    };
                    writer.write_point(point).expect("write point");
                }
            }
        }
        writer.close().expect("close");
    }

    fn make_copc(dir: &Path, max_points_per_node: u32, lowest_class: u8) -> PathBuf {
        let las_path = dir.join("columns.las");
        write_columns_las(&las_path, lowest_class);
        let copc_path = dir.join("columns.copc.laz");
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

    struct Paths {
        tif: PathBuf,
        copc: PathBuf,
    }

    fn run(
        source: &Path,
        dir: &Path,
        options: RasterOptions,
        max_cells: u64,
    ) -> (Result<RasterSummary, RasterRunError>, Paths) {
        let paths = Paths {
            tif: dir.join("out.tif"),
            copc: dir.join("out.copc.laz"),
        };
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        let result = rasterize_path_and_timings(
            source,
            options,
            max_cells,
            &paths.tif,
            &paths.copc,
            spill.path(),
            &CopcWriterParams::new(500),
            &NeverCancel,
            |_| {},
            &mut timings,
        );
        (result, paths)
    }

    fn options(value: RasterValue, ground_only: bool) -> RasterOptions {
        RasterOptions {
            cell_size: 2.0,
            value,
            ground_only,
        }
    }

    fn read_f32_tiff(path: &Path) -> (u32, u32, Vec<f32>) {
        let file = File::open(path).expect("open tiff");
        let mut d = Decoder::new(std::io::BufReader::new(file)).expect("decoder");
        let (w, h) = d.dimensions().expect("dims");
        match d.read_image().expect("image") {
            DecodingResult::F32(v) => (w, h, v),
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    /// 10 x 10 columns with a 2 m cell: 5 x 5 cells, each holding 2 x 2 columns x 3
    /// points = 12 points (z = 10, 20, 30).
    #[test]
    fn z_mean_per_cell_and_one_display_point_per_cell() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (result, paths) = run(&source, dir.path(), options(RasterValue::ZMean, false), 100);
        let summary = result.expect("raster");
        assert_eq!((summary.width, summary.height), (5, 5));
        assert_eq!(summary.points_counted, 300);
        assert_eq!(summary.display_points, 25);
        assert_eq!(
            summary.warnings.len(),
            1,
            "no CRS: the GeoTIFF has none and the result says so"
        );

        let (w, h, values) = read_f32_tiff(&paths.tif);
        assert_eq!((w, h), (5, 5));
        assert!(values.iter().all(|&v| v == 20.0), "{values:?}");

        let reader = CopcReader::from_path(&paths.copc).expect("open display copc");
        assert_eq!(reader.header().number_of_points(), 25);
    }

    #[test]
    fn min_max_count_and_ground_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (min, _) = run(&source, dir.path(), options(RasterValue::ZMin, false), 100);
        min.expect("min");
        assert!(read_f32_tiff(&dir.path().join("out.tif"))
            .2
            .iter()
            .all(|&v| v == 10.0));
        let (max, _) = run(&source, dir.path(), options(RasterValue::ZMax, false), 100);
        max.expect("max");
        assert!(read_f32_tiff(&dir.path().join("out.tif"))
            .2
            .iter()
            .all(|&v| v == 30.0));
        let (count, _) = run(&source, dir.path(), options(RasterValue::Count, false), 100);
        count.expect("count");
        assert!(read_f32_tiff(&dir.path().join("out.tif"))
            .2
            .iter()
            .all(|&v| v == 12.0));
        // Ground only: class 2 is z = 10, 4 per cell.
        let (ground, _) = run(&source, dir.path(), options(RasterValue::Count, true), 100);
        let summary = ground.expect("ground");
        assert_eq!(summary.points_counted, 100);
        assert!(read_f32_tiff(&dir.path().join("out.tif"))
            .2
            .iter()
            .all(|&v| v == 4.0));
    }

    #[test]
    fn rgb_geotiff_has_four_bands_with_colour_means() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (result, paths) = run(
            &source,
            dir.path(),
            options(RasterValue::RgbMean, false),
            100,
        );
        result.expect("rgb");
        let file = File::open(&paths.tif).expect("open tiff");
        let mut d = Decoder::new(std::io::BufReader::new(file)).expect("decoder");
        match d.read_image().expect("image") {
            DecodingResult::U16(v) => {
                assert_eq!(v.len(), 5 * 5 * 4);
                // Image order: row 0 is the north row (iy = 8, 9), column 0 is ix = 0, 1:
                // mean red = 500, mean green = 8500, alpha opaque.
                assert_eq!(&v[0..4], &[500, 8500, 0, 65_535]);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn too_many_cells_is_refused_with_the_grid_message_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (result, paths) = run(&source, dir.path(), options(RasterValue::ZMean, false), 24);
        let err = result.expect_err("5 x 5 cells > 24");
        assert!(err.to_string().contains("セルの大きさ"), "{err}");
        assert!(!paths.tif.exists());
        assert!(!paths.copc.exists());
    }

    #[test]
    fn ground_only_without_ground_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 1); // class 1 only: no ground
        let (result, paths) = run(&source, dir.path(), options(RasterValue::Count, true), 100);
        assert!(matches!(result, Err(RasterRunError::NoPoints)));
        assert!(!paths.tif.exists());
        assert!(!paths.copc.exists());
    }

    /// The reader holds one node at a time, however many points there are.
    #[test]
    fn buffer_is_bounded_by_largest_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 50, 2);
        let (result, _) = run(&source, dir.path(), options(RasterValue::ZMean, false), 100);
        let stats = result.expect("raster").stats;
        assert!(stats.nodes_read > 4, "{stats:?}");
        assert!(stats.max_buffered_points <= 50, "{stats:?}");
        assert_eq!(stats.points_scanned, 300);
    }

    #[test]
    fn cancel_stops_reading_and_leaves_no_files() {
        struct CancelNow;
        impl CancelCheck for CancelNow {
            fn check(&self) -> copc_core::Result<()> {
                Err(copc_core::Error::Cancelled)
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 50, 2);
        let tif = dir.path().join("out.tif");
        let copc = dir.path().join("out.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        let err = rasterize_path_and_timings(
            &source,
            options(RasterValue::ZMean, false),
            100,
            &tif,
            &copc,
            spill.path(),
            &CopcWriterParams::new(50),
            &CancelNow,
            |_| {},
            &mut timings,
        )
        .expect_err("cancelled");
        assert!(err.is_cancelled(), "{err}");
        assert!(!tif.exists());
        assert!(!copc.exists());
    }

    #[test]
    fn progress_is_reported_per_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 50, 2);
        let calls: Arc<Mutex<Vec<ReadProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_in = Arc::clone(&calls);
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        rasterize_path_and_timings(
            &source,
            options(RasterValue::ZMean, false),
            100,
            &dir.path().join("out.tif"),
            &dir.path().join("out.copc.laz"),
            spill.path(),
            &CopcWriterParams::new(50),
            &NeverCancel,
            move |p| calls_in.lock().expect("lock").push(p),
            &mut timings,
        )
        .expect("raster");
        let calls = calls.lock().expect("lock");
        assert!(calls.len() > 1);
        let last = calls.last().expect("last");
        assert_eq!((last.points_read, last.total_points), (300, 300));
    }
}
