use std::collections::VecDeque;
use std::io::{Read, Seek};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};

use crate::stage_timings::ConversionStageTimings;
use crate::write_metadata::copc_write_metadata_from_source_header;

pub(crate) const PROGRESS_REPORT_STRIDE: u64 = 4096;

const READ_BATCH_SIZE: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct AtomicCancel(pub Arc<AtomicBool>);

impl CancelCheck for AtomicCancel {
    fn check(&self) -> copc_core::Result<()> {
        if self.0.load(Ordering::Relaxed) {
            Err(copc_core::Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadProgress {
    pub points_read: u64,
    pub total_points: u64,
}

struct BatchedLasPoints<F: FnMut(ReadProgress)> {
    reader: las::Reader,
    point_data: las::PointData,
    batch: VecDeque<las::Result<las::Point>>,
    points_read: u64,
    total_points: u64,
    on_progress: F,
    exhausted: bool,
}

impl<F: FnMut(ReadProgress)> Iterator for BatchedLasPoints<F> {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(result) = self.batch.pop_front() {
                self.points_read += 1;
                if self.points_read.is_multiple_of(PROGRESS_REPORT_STRIDE)
                    || self.points_read == self.total_points
                {
                    (self.on_progress)(ReadProgress {
                        points_read: self.points_read,
                        total_points: self.total_points,
                    });
                }
                return Some(
                    result
                        .map(|point| LasPointRecord::from_las_point(&point))
                        .map_err(|e| copc_core::Error::Las(e.to_string())),
                );
            }
            if self.exhausted {
                return None;
            }
            match self
                .reader
                .fill_points(READ_BATCH_SIZE, &mut self.point_data)
            {
                Ok(0) => {
                    self.exhausted = true;
                    return None;
                }
                Ok(_) => {
                    self.batch = self.point_data.points().collect();
                }
                Err(e) => {
                    self.exhausted = true;
                    return Some(Err(copc_core::Error::Las(e.to_string())));
                }
            }
        }
    }
}

pub fn convert<R, F>(
    source: R,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
) -> copc_core::Result<()>
where
    R: Read + Seek + Send + Sync + 'static,
    F: FnMut(ReadProgress),
{
    let mut discarded = ConversionStageTimings::default();
    convert_and_timings(
        source,
        output,
        spill_dir,
        params,
        cancel,
        on_progress,
        &mut discarded,
    )
}

pub fn convert_and_timings<R, F>(
    source: R,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
    timings: &mut ConversionStageTimings,
) -> copc_core::Result<()>
where
    R: Read + Seek + Send + Sync + 'static,
    F: FnMut(ReadProgress),
{
    let las_reader = las::Reader::new(source).map_err(|e| copc_core::Error::Las(e.to_string()))?;
    let layout = StreamingLayout::from_las_header(las_reader.header());
    let metadata = copc_write_metadata_from_source_header(las_reader.header());
    let total_points = las_reader.header().number_of_points();
    let point_data = las::PointDataBuilder::new()
        .for_header(las_reader.header())
        .build();

    let points = BatchedLasPoints {
        reader: las_reader,
        point_data,
        batch: VecDeque::new(),
        points_read: 0,
        total_points,
        on_progress,
        exhausted: false,
    };

    let mut ingest = copc_writer::IngestStageTimings::default();
    let mut post = copc_writer::PostProcessStageTimings::default();
    write_streaming_with_cancel_and_timings(
        output,
        layout,
        points,
        params,
        &metadata,
        spill_dir,
        cancel,
        Some(&mut ingest),
        Some(&mut post),
    )?;
    *timings = ConversionStageTimings::from_parts(ingest, post);
    Ok(())
}

pub fn convert_path<F>(
    source: &Path,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
) -> copc_core::Result<()>
where
    F: FnMut(ReadProgress),
{
    let mut discarded = ConversionStageTimings::default();
    convert_path_and_timings(
        source,
        output,
        spill_dir,
        params,
        cancel,
        on_progress,
        &mut discarded,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn convert_path_and_timings<F>(
    source: &Path,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
    timings: &mut ConversionStageTimings,
) -> copc_core::Result<()>
where
    F: FnMut(ReadProgress),
{
    let file =
        std::fs::File::open(source).map_err(|e| copc_core::Error::io("open source LAS/LAZ", e))?;
    convert_and_timings(
        std::io::BufReader::new(file),
        output,
        spill_dir,
        params,
        cancel,
        on_progress,
        timings,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_cancel_reports_ok_until_flagged() {
        let flag = Arc::new(AtomicBool::new(false));
        let cancel = AtomicCancel(flag.clone());
        assert!(cancel.check().is_ok());

        flag.store(true, Ordering::Relaxed);
        assert!(matches!(cancel.check(), Err(copc_core::Error::Cancelled)));
    }
}
