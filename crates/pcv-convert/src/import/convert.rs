use std::path::Path;
use std::time::{Duration, Instant};

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs_and_timings, CopcWriteMetadata, CopcWriterParams,
    NativeScratchFs, SpillWriter,
};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;

use super::point::{PointSource, RawPoint};
use super::{ImportError, ImportSummary};

const POINT_FORMAT_IGNORED_BY_COPC_WRITER_WHICH_PICKS_6_OR_7_FROM_COLOR: u8 = 0;

const PROGRESS_REPORT_STRIDE: u64 = 4096;

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_import<S: PointSource>(
    source: S,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    mut on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<ImportSummary, ImportError> {
    let has_color = source.has_color();
    let total_points = source.declared_point_count();

    let layout = StreamingLayout {
        point_format: POINT_FORMAT_IGNORED_BY_COPC_WRITER_WHICH_PICKS_6_OR_7_FROM_COLOR,
        has_gps: false,
        has_color,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };

    let spill_fs = NativeScratchFs::new(spill_dir);
    let mut spill = SpillWriter::create(&spill_fs, layout, None).map_err(ImportError::Copc)?;

    let mut points_read: u64 = 0;
    let mut spill_write_total = Duration::ZERO;
    let for_each_point_start = Instant::now();
    source.for_each_point(&mut |point: RawPoint| -> Result<(), ImportError> {
        if points_read.is_multiple_of(PROGRESS_REPORT_STRIDE) {
            cancel.check().map_err(ImportError::Copc)?;
        }
        let record = LasPointRecord {
            x: point.x,
            y: point.y,
            z: point.z,
            intensity: point.intensity,
            red: point.color[0],
            green: point.color[1],
            blue: point.color[2],
            ..LasPointRecord::default()
        };
        let push_start = Instant::now();
        spill.push(&record).map_err(ImportError::Copc)?;
        spill_write_total += push_start.elapsed();
        points_read += 1;
        if points_read.is_multiple_of(PROGRESS_REPORT_STRIDE) || points_read == total_points {
            on_progress(ReadProgress {
                points_read,
                total_points,
            });
        }
        Ok(())
    })?;
    let for_each_point_elapsed = for_each_point_start.elapsed();
    timings.spill_write = spill_write_total;
    timings.source_read_and_decode = for_each_point_elapsed.saturating_sub(spill_write_total);
    cancel.check().map_err(ImportError::Copc)?;

    let reader = spill.finalize().map_err(ImportError::Copc)?;
    let bounds = reader.bounds();
    let (scale, offset) = super::scale::choose_scale_offset(bounds.min, bounds.max);

    let crs_known = crs_wkt.is_some();
    let mut metadata = CopcWriteMetadata::default();
    metadata.wkt_crs = crs_wkt;
    metadata.scale = Some(scale);
    metadata.offset = Some(offset);

    let lod_fs = NativeScratchFs::new(std::env::temp_dir());
    let post = write_copc_from_spill_with_fs_and_timings(
        &lod_fs, output, reader, params, cancel, &metadata,
    )
    .map_err(ImportError::Copc)?;
    timings.lod_index_build = post.lod_index_build;
    timings.node_compression = post.node_compression;
    timings.header_and_hierarchy_write = post.header_and_hierarchy_write;

    Ok(ImportSummary {
        point_count: points_read,
        crs_known,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::point::RawPoint;

    struct SyntheticSource {
        count: u32,
    }

    impl PointSource for SyntheticSource {
        fn has_color(&self) -> bool {
            false
        }

        fn declared_point_count(&self) -> u64 {
            u64::from(self.count)
        }

        fn for_each_point(
            self,
            visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
        ) -> Result<(), ImportError> {
            for i in 0..self.count {
                let f = f64::from(i);
                visit(RawPoint {
                    x: f,
                    y: f * 2.0,
                    z: f * 3.0,
                    color: [0, 0, 0],
                    intensity: 0,
                })?;
            }
            Ok(())
        }
    }

    #[test]
    fn run_import_fills_all_five_stage_timings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("out.copc.laz");
        let spill_dir = dir.path().join("spill");
        std::fs::create_dir_all(&spill_dir).expect("create spill dir");

        let mut timings = ConversionStageTimings::default();
        run_import(
            SyntheticSource { count: 5_000 },
            &output,
            &spill_dir,
            &CopcWriterParams::new(500).with_memory_budget_bytes(64 * 1024),
            &copc_core::NeverCancel,
            None,
            |_progress| {},
            &mut timings,
        )
        .expect("run_import");

        assert!(
            timings.source_read_and_decode > Duration::ZERO,
            "読み込み時間が0のまま: {timings:?}"
        );
        assert!(
            timings.spill_write > Duration::ZERO,
            "spill書き込み時間が0のまま: {timings:?}"
        );
        assert!(
            timings.lod_index_build > Duration::ZERO,
            "octree分割時間が0のまま: {timings:?}"
        );
        assert!(
            timings.node_compression > Duration::ZERO,
            "ノード圧縮時間が0のまま: {timings:?}"
        );
    }
}
