//! G1-T15: the DTM tool on desktop and Android.
//!
//! The work is `pcv_core::dtm::DtmJob`. This file connects it to files:
//!
//! 1. The job runs inside an iterator (`DtmRecords`) that `copc-writer` pulls from. The first `next()` runs pass 1
//!    and the cloth simulation; after that it yields the classified points node by node. So the points go
//!    from the source straight to the writer's spill files and **nothing grows with the point count** (the same
//!    design as `extract.rs`).
//! 2. When the writer is done the job is finished into a TIN and the GeoTIFF / LandXML files are written.
//!
//! Progress is the job's fraction (cloth passes, simulation, classification) scaled to 0..90%; the writer's
//! own work after the last point (octree, compression) is not measured and shows as 95%.
//! When anything fails or is cancelled, every output file is removed.

use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
use pcv_core::crs::{crs_id_from_las_header, CrsId};
use pcv_core::dtm::{
    DtmError, DtmJob, DtmParams, DtmRequest, GroundAgreement, LandXmlOptions,
    DTM_MAX_CELLS_DESKTOP, DTM_MAX_CELLS_WEB, DTM_MAX_PARTICLES_DESKTOP, DTM_MAX_PARTICLES_WEB,
};
use pcv_core::raster::output::missing_crs_warning;

use crate::streaming::ReadProgress;
use crate::write_metadata::copc_write_metadata_from_source_header;

#[derive(Debug, thiserror::Error)]
pub enum DtmRunError {
    /// User-facing text, shown on screen as is.
    #[error(transparent)]
    Dtm(#[from] DtmError),
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
    #[error("COPCの書き出しに失敗しました: {0}")]
    Write(#[source] copc_core::Error),
    #[error("DTM のファイルを書けませんでした ({path}): {source}")]
    File {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl DtmRunError {
    /// Whether it stopped because of cancellation (shown as "cancelled" on screen).
    pub fn is_cancelled(&self) -> bool {
        matches!(
            self,
            DtmRunError::Dtm(DtmError::Cancelled) | DtmRunError::Write(copc_core::Error::Cancelled)
        )
    }
}

/// Where the outputs go. `geotiff` / `landxml` are written only when the request asks for them.
#[derive(Debug, Clone)]
pub struct DtmOutputs {
    /// The classified point cloud (COPC).
    pub copc: PathBuf,
    pub geotiff: PathBuf,
    pub landxml: PathBuf,
}

/// Result of a run.
#[derive(Debug, Clone, PartialEq)]
pub struct DtmSummary {
    pub point_count: u64,
    pub ground_points: u64,
    /// CSF against the source classification (a rough guide, not a truth).
    pub agreement: GroundAgreement,
    pub width: u32,
    pub height: u32,
    pub cell_size: f64,
    /// TIN vertices (cells that held a ground point) and triangles.
    pub tin_points: usize,
    pub tin_triangles: usize,
    pub warnings: Vec<String>,
}

/// The classified points as an iterator for the writer. It owns the job's progress, not the files.
struct DtmRecords<'a> {
    job: &'a mut DtmJob,
    reader: &'a mut CopcReader<std::io::BufReader<File>>,
    buffer: VecDeque<LasPointRecord>,
    done: bool,
    cancel: &'a (dyn CancelCheck + Sync),
    on_progress: &'a mut (dyn FnMut(ReadProgress) + Send),
    /// The real error, kept here because the writer only sees a `copc_core::Error`.
    failure: &'a mut Option<DtmError>,
}

impl Iterator for DtmRecords<'_> {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(record) = self.buffer.pop_front() {
                return Some(Ok(record));
            }
            if self.done {
                return None;
            }
            if let Err(e) = self.cancel.check() {
                *self.failure = Some(DtmError::Cancelled);
                return Some(Err(e));
            }
            match self.job.advance(self.reader) {
                Ok(progress) => {
                    self.done = progress.done;
                    self.buffer.extend(self.job.take_records());
                    (self.on_progress)(ReadProgress {
                        points_read: (progress.fraction * 900.0) as u64,
                        total_points: 1000,
                    });
                }
                Err(e) => {
                    let message = e.to_string();
                    *self.failure = Some(e);
                    return Some(Err(copc_core::Error::InvalidInput(message)));
                }
            }
        }
    }
}

/// Classifies the ground of `source` (COPC), writes the result as the COPC `outputs.copc` and the DTM as
/// `outputs.geotiff` and/or `outputs.landxml` (as `request.output` says).
///
/// - `on_progress`: `points_read` / `total_points` is the fraction in per mille (0..1000).
/// - `cancel`: checked between steps and by the writer. On failure or cancel, every output is removed.
/// - `unix_seconds`: the time written into LandXML.
#[allow(clippy::too_many_arguments)]
pub fn dtm_path(
    source: &Path,
    request: DtmRequest,
    max_particles: u64,
    max_cells: u64,
    outputs: &DtmOutputs,
    spill_dir: &Path,
    unix_seconds: i64,
    cancel: &(dyn CancelCheck + Sync),
    mut on_progress: impl FnMut(ReadProgress) + Send,
) -> Result<DtmSummary, DtmRunError> {
    let result = dtm_inner(
        source,
        request,
        max_particles,
        max_cells,
        outputs,
        spill_dir,
        unix_seconds,
        cancel,
        &mut on_progress,
    );
    if result.is_err() {
        // Best effort: half-written outputs must not stay behind.
        for path in [&outputs.copc, &outputs.geotiff, &outputs.landxml] {
            let _ = std::fs::remove_file(path);
        }
    }
    result
}

/// `dtm_path` with the caps of this platform: the desktop caps, or on Android the (smaller) Web caps, because a phone has
/// far less memory (the desktop caps are measured in `TaskSheets/G1-T15-dtm.md`; the Android ones are not).
#[allow(clippy::too_many_arguments)]
pub fn dtm_path_desktop(
    source: &Path,
    request: DtmRequest,
    outputs: &DtmOutputs,
    spill_dir: &Path,
    unix_seconds: i64,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: impl FnMut(ReadProgress) + Send,
) -> Result<DtmSummary, DtmRunError> {
    dtm_path(
        source,
        request,
        if cfg!(target_os = "android") {
            DTM_MAX_PARTICLES_WEB
        } else {
            DTM_MAX_PARTICLES_DESKTOP
        },
        if cfg!(target_os = "android") {
            DTM_MAX_CELLS_WEB
        } else {
            DTM_MAX_CELLS_DESKTOP
        },
        outputs,
        spill_dir,
        unix_seconds,
        cancel,
        on_progress,
    )
}

#[allow(clippy::too_many_arguments)]
fn dtm_inner(
    source: &Path,
    request: DtmRequest,
    max_particles: u64,
    max_cells: u64,
    outputs: &DtmOutputs,
    spill_dir: &Path,
    unix_seconds: i64,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: &mut (dyn FnMut(ReadProgress) + Send),
) -> Result<DtmSummary, DtmRunError> {
    request.validate()?;
    // Layout, output metadata and CRS come from the header only (no point is read).
    let header_reader =
        las::Reader::from_path(source).map_err(|source_err| DtmRunError::OpenHeader {
            path: source.to_path_buf(),
            source: source_err,
        })?;
    let header = header_reader.header();
    let layout = StreamingLayout::from_las_header(header);
    let metadata = copc_write_metadata_from_source_header(header);
    let epsg = match crs_id_from_las_header(header) {
        CrsId::Epsg(code) => Some(code),
        _ => None,
    };
    drop(header_reader);

    let mut reader = CopcReader::from_path(source).map_err(|e| DtmRunError::Open {
        path: source.to_path_buf(),
        source: e,
    })?;
    // The caps are checked here, before any point is read.
    let params: DtmParams = request.to_params(max_particles, max_cells);
    let mut job = DtmJob::new(&reader, epsg, &params)?;
    let total_points = job.points_total();

    let mut failure: Option<DtmError> = None;
    let written = write_streaming_with_cancel_and_timings(
        &outputs.copc,
        layout,
        DtmRecords {
            job: &mut job,
            reader: &mut reader,
            buffer: VecDeque::new(),
            done: false,
            cancel,
            on_progress: &mut *on_progress,
            failure: &mut failure,
        },
        &CopcWriterParams::default(),
        &metadata,
        spill_dir,
        cancel,
        None,
        None,
    );
    if let Some(e) = failure {
        return Err(e.into());
    }
    written.map_err(DtmRunError::Write)?;
    on_progress(ReadProgress {
        points_read: 950,
        total_points: 1000,
    });
    cancel
        .check()
        .map_err(|_| DtmRunError::Dtm(DtmError::Cancelled))?;

    let ground_points = job.points_ground();
    let agreement = job.ground_agreement();
    let surface = job.finish()?;
    let mut warnings = Vec::new();
    if let Some(w) = missing_crs_warning(epsg) {
        warnings.push(w);
    }
    if request.output.geotiff {
        let file = File::create(&outputs.geotiff).map_err(|source| DtmRunError::File {
            path: outputs.geotiff.clone(),
            source,
        })?;
        let mut out = BufWriter::new(file);
        surface.write_geotiff(&mut out, request.output.tiff)?;
        std::io::Write::flush(&mut out).map_err(|source| DtmRunError::File {
            path: outputs.geotiff.clone(),
            source,
        })?;
    }
    if request.output.landxml {
        let file = File::create(&outputs.landxml).map_err(|source| DtmRunError::File {
            path: outputs.landxml.clone(),
            source,
        })?;
        let mut out = BufWriter::new(file);
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("DTM")
            .trim_end_matches(".laz")
            .trim_end_matches(".copc");
        surface.write_landxml(
            &mut out,
            &LandXmlOptions {
                name,
                unit: request.output.unit,
                unix_seconds,
            },
        )?;
        std::io::Write::flush(&mut out).map_err(|source| DtmRunError::File {
            path: outputs.landxml.clone(),
            source,
        })?;
    }
    Ok(DtmSummary {
        point_count: total_points,
        ground_points,
        agreement,
        width: surface.grid().width,
        height: surface.grid().height,
        cell_size: surface.grid().cell_size,
        tin_points: surface.ground_cells(),
        tin_triangles: surface.triangle_count(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use copc_core::NeverCancel;
    use pcv_core::dtm::{DtmOutputOptions, LandXmlUnit};
    use pcv_core::raster::TiffKind;
    use pcv_core::CopcFile;

    use crate::streaming::AtomicCancel;

    /// A flat 40 x 40 m ground (class 1, every 0.5 m) with a 4 x 4 m box 5 m above it (class 6).
    fn write_town_las(path: &Path) {
        let mut builder = las::Builder::from((1, 4));
        builder.point_format = las::point::Format::new(6).expect("PDRF6");
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
        let mut put = |x: f64, y: f64, z: f64, class: u8| {
            let point = las::Point {
                x,
                y,
                z,
                classification: las::point::Classification::new(class).expect("class"),
                gps_time: Some(0.0),
                ..Default::default()
            };
            writer.write_point(point).expect("write point");
        };
        for i in 0..=80 {
            for j in 0..=80 {
                let (x, y) = (1000.0 + f64::from(i) * 0.5, 2000.0 + f64::from(j) * 0.5);
                let under_box = (1010.0..=1014.0).contains(&x) && (2010.0..=2014.0).contains(&y);
                if !under_box {
                    put(x, y, 10.0, 1);
                }
            }
        }
        for i in 0..=8 {
            for j in 0..=8 {
                put(
                    1010.0 + f64::from(i) * 0.5,
                    2010.0 + f64::from(j) * 0.5,
                    15.0,
                    6,
                );
            }
        }
        writer.close().expect("close");
    }

    fn make_copc(dir: &Path) -> PathBuf {
        let las_path = dir.join("town.las");
        write_town_las(&las_path);
        let copc_path = dir.join("town.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        crate::streaming::convert_path(
            &las_path,
            &copc_path,
            spill.path(),
            &CopcWriterParams::new(400),
            &NeverCancel,
            |_| {},
        )
        .expect("convert");
        copc_path
    }

    fn request(geotiff: bool, landxml: bool) -> DtmRequest {
        let csf = pcv_core::section_line::CsfParamsInput {
            cloth_resolution: 0.5,
            rigidness: 3,
            time_step: 0.65,
            class_threshold_upper: 0.1,
            class_threshold_lower: 1.0,
            iterations: 500,
            slope_smooth: true,
            hdiff: 0.3,
            convergence_threshold: 0.005,
        };
        DtmRequest {
            csf,
            cell_size: 1.0,
            output: DtmOutputOptions {
                geotiff,
                landxml,
                tiff: TiffKind::Values,
                unit: LandXmlUnit::Meter,
            },
        }
    }

    fn outputs(dir: &Path) -> DtmOutputs {
        DtmOutputs {
            copc: dir.join("dtm.copc.laz"),
            geotiff: dir.join("dtm.tif"),
            landxml: dir.join("dtm.xml"),
        }
    }

    #[test]
    fn writes_the_classified_cloud_and_both_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path());
        let out = outputs(dir.path());
        let spill = tempfile::tempdir().expect("spill");
        let summary = dtm_path(
            &source,
            request(true, true),
            2_000_000,
            2_000_000,
            &out,
            spill.path(),
            0,
            &NeverCancel,
            |_| {},
        )
        .expect("dtm");
        let source_count = CopcFile::open(&source).expect("source").info().point_count;
        assert_eq!(summary.point_count, source_count, "header count");

        // The new layer has every point; the ground is class 2 and the box keeps class 6.
        let mut file = CopcFile::open(&out.copc).expect("output");
        assert_eq!(file.info().point_count, source_count);
        let keys: Vec<_> = file.hierarchy().nodes().map(|n| n.key).collect();
        let (mut ground, mut boxed, mut other) = (0u64, 0u64, 0u64);
        for key in keys {
            for p in file.read_node_points(key).expect("node") {
                match p.classification {
                    2 => ground += 1,
                    6 => boxed += 1,
                    _ => other += 1,
                }
            }
        }
        assert_eq!(boxed, 81, "the box keeps its class");
        assert_eq!(other, 0);
        assert_eq!(ground, source_count - 81);
        assert_eq!(summary.ground_points, ground);
        assert!(summary.tin_points > 1_000 && summary.tin_triangles > 1_000);
        assert_eq!((summary.width, summary.height), (40, 40));
        assert!(out.geotiff.exists() && out.landxml.exists());
        assert_eq!(summary.warnings.len(), 1, "no CRS: the files say so");
    }

    #[test]
    fn only_the_chosen_files_are_written() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path());
        let out = outputs(dir.path());
        let spill = tempfile::tempdir().expect("spill");
        dtm_path(
            &source,
            request(false, true),
            2_000_000,
            2_000_000,
            &out,
            spill.path(),
            0,
            &NeverCancel,
            |_| {},
        )
        .expect("dtm");
        assert!(out.landxml.exists());
        assert!(!out.geotiff.exists());
    }

    #[test]
    fn a_request_without_a_file_is_refused_and_a_cap_is_refused_before_reading() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path());
        let out = outputs(dir.path());
        let spill = tempfile::tempdir().expect("spill");
        let run = |req, particles, cells| {
            let mut progress_calls = 0u32;
            let result = dtm_path(
                &source,
                req,
                particles,
                cells,
                &out,
                spill.path(),
                0,
                &NeverCancel,
                |_| progress_calls += 1,
            );
            (result, progress_calls)
        };
        let (none, _) = run(request(false, false), 2_000_000, 2_000_000);
        assert!(none.expect_err("no file").to_string().contains("出力形式"));
        let (cloth, calls) = run(request(true, true), 100, 2_000_000);
        assert!(cloth
            .expect_err("cloth cap")
            .to_string()
            .contains("布の解像度を粗くするか"));
        assert_eq!(calls, 0, "refused before any progress");
        let (cells, _) = run(request(true, true), 2_000_000, 10);
        assert!(cells
            .expect_err("cell cap")
            .to_string()
            .contains("先に範囲を切り出して"));
        assert!(!out.copc.exists(), "nothing was written");
    }

    #[test]
    fn cancel_removes_every_output() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path());
        let out = outputs(dir.path());
        let spill = tempfile::tempdir().expect("spill");
        let flag = Arc::new(AtomicBool::new(false));
        let cancel = AtomicCancel(Arc::clone(&flag));
        let mut calls = 0u32;
        let result = dtm_path(
            &source,
            request(true, true),
            2_000_000,
            2_000_000,
            &out,
            spill.path(),
            0,
            &cancel,
            |_| {
                calls += 1;
                if calls == 3 {
                    flag.store(true, Ordering::Relaxed);
                }
            },
        );
        let err = result.expect_err("cancelled");
        assert!(err.is_cancelled(), "{err}");
        assert!(!out.copc.exists() && !out.geotiff.exists() && !out.landxml.exists());
    }
}
