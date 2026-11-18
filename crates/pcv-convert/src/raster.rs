use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use crate::streaming::ReadProgress;
use copc_core::{CancelCheck, StreamingLayout};
use copc_reader::CopcReader;
use pcv_core::crs::{crs_id_from_las_header, CrsId};
use pcv_core::extract::{ExtractPoints, ExtractStats};
use pcv_core::raster::output::{missing_crs_warning, write_geotiff};
use pcv_core::raster::preview::{CoarsePoints, CoarseReader, XyBounds};
use pcv_core::raster::{CellAccumulator, GridSpec, RasterError, RasterOptions, RasterValue};

#[derive(Debug, thiserror::Error)]
pub enum RasterRunError {
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
    #[error("GeoTIFFを書き出せませんでした: {0}")]
    GeoTiffFile(#[source] std::io::Error),
}

impl RasterRunError {
    pub fn is_cancelled(&self) -> bool {
        matches!(self, RasterRunError::Read(copc_core::Error::Cancelled))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RasterSummary {
    pub width: u32,
    pub height: u32,
    pub points_counted: u64,
    pub warnings: Vec<String>,
    pub stats: ExtractStats,
}

struct HeaderFacts {
    layout: StreamingLayout,
    bounds: XyBounds,
    epsg: Option<u32>,
}

fn read_header(source: &Path) -> Result<HeaderFacts, RasterRunError> {
    let header_reader =
        las::Reader::from_path(source).map_err(|source_err| RasterRunError::OpenHeader {
            path: source.to_path_buf(),
            source: source_err,
        })?;
    let header = header_reader.header();
    let b = header.bounds();
    let epsg = match crs_id_from_las_header(header) {
        CrsId::Epsg(code) => Some(code),
        _ => None,
    };
    Ok(HeaderFacts {
        layout: StreamingLayout::from_las_header(header),
        bounds: XyBounds {
            min_x: b.min.x,
            min_y: b.min.y,
            max_x: b.max.x,
            max_y: b.max.y,
        },
        epsg,
    })
}

const COARSE_BATCH_POINTS: usize = 50_000;

pub fn read_coarse_path<F>(
    source: &Path,
    cap: usize,
    cancel: &(dyn CancelCheck + Sync),
    mut on_progress: F,
) -> Result<CoarsePoints, RasterRunError>
where
    F: FnMut(ReadProgress),
{
    let facts = read_header(source)?;
    let copc_reader = CopcReader::from_path(source).map_err(|e| RasterRunError::Open {
        path: source.to_path_buf(),
        source: e,
    })?;
    let mut reader = CoarseReader::new(copc_reader, facts.bounds, facts.layout.has_color, cap);
    loop {
        cancel.check().map_err(RasterRunError::Read)?;
        let done = reader
            .feed(COARSE_BATCH_POINTS)
            .map_err(RasterRunError::Read)?;
        let (points_read, total_points) = reader.progress();
        on_progress(ReadProgress {
            points_read,
            total_points,
        });
        if done {
            return Ok(reader.finish());
        }
    }
}

pub fn rasterize_path<F>(
    source: &Path,
    options: RasterOptions,
    max_cells: u64,
    geotiff_output: &Path,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
) -> Result<RasterSummary, RasterRunError>
where
    F: FnMut(ReadProgress) + Send,
{
    let result = rasterize_inner(
        source,
        options,
        max_cells,
        geotiff_output,
        cancel,
        on_progress,
    );
    if result.is_err() {
        let _ = std::fs::remove_file(geotiff_output);
    }
    result
}

fn rasterize_inner<F>(
    source: &Path,
    options: RasterOptions,
    max_cells: u64,
    geotiff_output: &Path,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
) -> Result<RasterSummary, RasterRunError>
where
    F: FnMut(ReadProgress) + Send,
{
    let facts = read_header(source)?;
    if options.value == RasterValue::RgbMean && !facts.layout.has_color {
        return Err(RasterRunError::NoColor);
    }
    let b = facts.bounds;
    let spec = GridSpec::from_bounds(
        b.min_x,
        b.min_y,
        b.max_x,
        b.max_y,
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
    cancel.check().map_err(RasterRunError::Read)?;

    let file = File::create(geotiff_output).map_err(RasterRunError::GeoTiffFile)?;
    let mut out = BufWriter::new(file);
    write_geotiff(&acc, facts.epsg, &options, &mut out)?;
    std::io::Write::flush(&mut out).map_err(RasterRunError::GeoTiffFile)?;

    Ok(RasterSummary {
        width: acc.spec().width,
        height: acc.spec().height,
        points_counted: acc.accepted_points(),
        warnings: missing_crs_warning(facts.epsg).into_iter().collect(),
        stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use copc_core::NeverCancel;
    use copc_writer::CopcWriterParams;
    use pcv_core::raster::preview::PreviewOptions;
    use pcv_core::raster::TiffKind;
    use tiff::decoder::{Decoder, DecodingResult};

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

    fn run(
        source: &Path,
        dir: &Path,
        options: RasterOptions,
        max_cells: u64,
    ) -> (Result<RasterSummary, RasterRunError>, PathBuf) {
        let tif = dir.join("out.tif");
        let result = rasterize_path(source, options, max_cells, &tif, &NeverCancel, |_| {});
        (result, tif)
    }

    fn options(value: RasterValue, ground_only: bool) -> RasterOptions {
        RasterOptions {
            cell_size: 2.0,
            value,
            ground_only,
            tiff: TiffKind::Values,
            range: None,
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

    #[test]
    fn z_mean_per_cell() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (result, tif) = run(&source, dir.path(), options(RasterValue::ZMean, false), 100);
        let summary = result.expect("raster");
        assert_eq!((summary.width, summary.height), (5, 5));
        assert_eq!(summary.points_counted, 300);
        assert_eq!(
            summary.warnings.len(),
            1,
            "no CRS: the GeoTIFF has none and the result says so"
        );

        let (w, h, values) = read_f32_tiff(&tif);
        assert_eq!((w, h), (5, 5));
        assert!(values.iter().all(|&v| v == 20.0), "{values:?}");
        let written: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("out"))
            .collect();
        assert_eq!(written, vec!["out.tif".to_string()]);
    }

    #[test]
    fn min_max_count_and_ground_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (min, tif) = run(&source, dir.path(), options(RasterValue::ZMin, false), 100);
        min.expect("min");
        assert!(read_f32_tiff(&tif).2.iter().all(|&v| v == 10.0));
        let (max, tif) = run(&source, dir.path(), options(RasterValue::ZMax, false), 100);
        max.expect("max");
        assert!(read_f32_tiff(&tif).2.iter().all(|&v| v == 30.0));
        let (count, tif) = run(&source, dir.path(), options(RasterValue::Count, false), 100);
        count.expect("count");
        assert!(read_f32_tiff(&tif).2.iter().all(|&v| v == 12.0));
        let (ground, tif) = run(&source, dir.path(), options(RasterValue::Count, true), 100);
        let summary = ground.expect("ground");
        assert_eq!(summary.points_counted, 100);
        assert!(read_f32_tiff(&tif).2.iter().all(|&v| v == 4.0));
    }

    #[test]
    fn rgb_values_geotiff_has_four_u16_bands_with_colour_means() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (result, tif) = run(
            &source,
            dir.path(),
            options(RasterValue::RgbMean, false),
            100,
        );
        result.expect("rgb");
        let file = File::open(&tif).expect("open tiff");
        let mut d = Decoder::new(std::io::BufReader::new(file)).expect("decoder");
        match d.read_image().expect("image") {
            DecodingResult::U16(v) => {
                assert_eq!(v.len(), 5 * 5 * 4);
                assert_eq!(&v[0..4], &[500, 8500, 0, 65_535]);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn colored_geotiff_is_rgba8_and_uses_the_range_it_is_given() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let mut o = options(RasterValue::ZMean, false);
        o.tiff = TiffKind::Colored;
        o.range = Some((10.0, 50.0));
        let (result, tif) = run(&source, dir.path(), o, 100);
        result.expect("colored");
        let file = File::open(&tif).expect("open tiff");
        let mut d = Decoder::new(std::io::BufReader::new(file)).expect("decoder");
        match d.read_image().expect("image") {
            DecodingResult::U8(v) => {
                assert_eq!(v.len(), 5 * 5 * 4);
                assert_eq!(&v[0..4], &[0, 191, 64, 255]);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn too_many_cells_is_refused_with_the_grid_message_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 2);
        let (result, tif) = run(&source, dir.path(), options(RasterValue::ZMean, false), 24);
        let err = result.expect_err("5 x 5 cells > 24");
        assert!(err.to_string().contains("セルの大きさ"), "{err}");
        assert!(!tif.exists());
    }

    #[test]
    fn ground_only_without_ground_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 500, 1);
        let (result, tif) = run(&source, dir.path(), options(RasterValue::Count, true), 100);
        assert!(matches!(result, Err(RasterRunError::NoPoints)));
        assert!(!tif.exists());
    }

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

    struct CancelNow;
    impl CancelCheck for CancelNow {
        fn check(&self) -> copc_core::Result<()> {
            Err(copc_core::Error::Cancelled)
        }
    }

    #[test]
    fn cancel_stops_reading_and_leaves_no_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 50, 2);
        let tif = dir.path().join("out.tif");
        let err = rasterize_path(
            &source,
            options(RasterValue::ZMean, false),
            100,
            &tif,
            &CancelNow,
            |_| {},
        )
        .expect_err("cancelled");
        assert!(err.is_cancelled(), "{err}");
        assert!(!tif.exists());
    }

    #[test]
    fn progress_is_reported_per_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 50, 2);
        let calls: Arc<Mutex<Vec<ReadProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_in = Arc::clone(&calls);
        rasterize_path(
            &source,
            options(RasterValue::ZMean, false),
            100,
            &dir.path().join("out.tif"),
            &NeverCancel,
            move |p| calls_in.lock().expect("lock").push(p),
        )
        .expect("raster");
        let calls = calls.lock().expect("lock");
        assert!(calls.len() > 1);
        let last = calls.last().expect("last");
        assert_eq!((last.points_read, last.total_points), (300, 300));
    }

    #[test]
    fn coarse_read_keeps_at_most_the_cap_and_renders_a_preview() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 50, 2);
        let all = read_coarse_path(&source, 1_000_000, &NeverCancel, |_| {}).expect("all");
        assert_eq!(all.len(), 300);
        let cap = read_coarse_path(&source, 40, &NeverCancel, |_| {}).expect("capped");
        assert!(cap.len() <= 40, "{}", cap.len());
        assert!(cap.bytes_held() <= 40 * 32, "{}", cap.bytes_held());
        let image = all
            .render(&PreviewOptions {
                cell_size: 2.0,
                value: RasterValue::ZMean,
                ground_only: false,
            })
            .expect("render");
        assert_eq!((image.width, image.height), (5, 5));
        assert_eq!(image.range, Some((20.0, 20.0)));
    }

    #[test]
    fn coarse_read_can_be_cancelled() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 50, 2);
        let err = read_coarse_path(&source, 1000, &CancelNow, |_| {})
            .err()
            .expect("cancelled");
        assert!(err.is_cancelled(), "{err}");
    }
}
