//! G3-5: Web version of thinning and the outlier filters (ROR, SOR). It writes the kept points of a COPC
//! file into a new COPC file on OPFS.
//!
//! The work is `pcv_core::thin_filter_job::ThinFilterJob`, the same decision functions as the desktop
//! `pcv_convert::thin_filter`. A Worker cannot be told to stop while a long call runs, so the Worker calls
//! `advance` repeatedly (one tile of the source per call) and yields to the event loop between calls,
//! where a cancel message is handled. This is the same shape as `WasmExtractor::feed`. The write side
//! is the same as `extract.rs`: `SpillWriter`, then `write_copc_from_spill_with_fs_and_timings`.
//!
//! Memory: one tile (+ margin) of the source, plus the spill on OPFS. `advance` does not keep the tile.
//! It cannot be cancelled during `finish` (octree build and write). With zero kept points, `finish`
//! fails with "残る点がありません" (the desktop `ThinFilterError::EmptyResult` text) before writing.

use std::path::Path;
use std::time::Duration;

use copc_core::{NeverCancel, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_copc_from_spill_with_fs_and_timings, CopcWriterParams, SpillWriter};
use js_sys::Array;
use pcv_core::thin_filter_job::{FilterRequest, JobMode, ThinFilterJob, ThinRequest};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};
use web_time::Instant;

use crate::convert::handles_from_js_array;
use crate::extract::{open_source, Source};
use crate::opfs::OpfsScratchFs;
use crate::write_metadata::copc_write_metadata_from_source_header;

/// Target points per tile core. Smaller than the desktop's 2,000,000 because a Worker has less memory
/// (a tile holds full point records and the filter's grid).
const TILE_CAP_POINTS: u64 = 500_000;

/// Same text as the desktop `ThinFilterError::EmptyResult`.
const EMPTY_RESULT_MESSAGE: &str = "残る点がありません";

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// Progress returned by `advance`.
#[derive(Serialize)]
pub struct ThinFilterStepDto {
    /// Core points handled so far (every point once per pass).
    pub points_read: u64,
    /// The header's point count times the number of passes.
    pub total_points: u64,
    /// Points written so far.
    pub points_kept: u64,
    /// Reading is finished (go on to `finish`).
    pub done: bool,
}

#[wasm_bindgen]
pub struct WasmThinFilter {
    job: ThinFilterJob<Source>,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    output_name: String,
    metadata: copc_writer::CopcWriteMetadata,
    params: CopcWriterParams,
    points_fed: u64,
    source_read_and_decode: Duration,
    spill_write: Duration,
    file_size_bytes: u64,
}

impl WasmThinFilter {
    fn build(
        file: File,
        mode: JobMode,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmThinFilter, JsValue> {
        let file_size_bytes = file.size() as u64;

        // Read the header (layout and output metadata) with `las`; no point data is read.
        let header_reader = las::Reader::new(open_source(file.clone()))
            .map_err(|e| JsValue::from_str(&format!("ヘッダーを読めませんでした: {e}")))?;
        let layout = StreamingLayout::from_las_header(header_reader.header());
        let metadata = copc_write_metadata_from_source_header(header_reader.header());
        drop(header_reader);

        let open = move || CopcReader::open(open_source(file.clone()));
        let job = ThinFilterJob::new(mode, open, TILE_CAP_POINTS).map_err(to_js_error)?;

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let spill = SpillWriter::create(&fs, layout, metadata.transform()).map_err(to_js_error)?;

        Ok(Self {
            job,
            spill: Some(spill),
            fs,
            output_name,
            metadata,
            params: CopcWriterParams::new(max_points_per_node),
            points_fed: 0,
            source_read_and_decode: Duration::ZERO,
            spill_write: Duration::ZERO,
            file_size_bytes,
        })
    }
}

#[wasm_bindgen]
impl WasmThinFilter {
    /// Thinning. `file` is the source COPC; `request` is the `ThinRequest` JSON (shape in
    /// `src/datasource/thin-filter.ts`, lengths in the file's unit). The scratch-file pool and output handle
    /// are the same ones the conversion uses.
    #[wasm_bindgen(js_name = forThin)]
    pub fn for_thin(
        file: File,
        request: JsValue,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmThinFilter, JsValue> {
        let request: ThinRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsValue::from_str(&format!("間引きの指定が正しくありません: {e}")))?;
        Self::build(
            file,
            JobMode::from(request),
            scratch_handles,
            output_handle,
            output_name,
            max_points_per_node,
        )
    }

    /// Outlier filter (ROR or SOR). `request` is the `FilterRequest` JSON. Otherwise like `forThin`.
    #[wasm_bindgen(js_name = forFilter)]
    pub fn for_filter(
        file: File,
        request: JsValue,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmThinFilter, JsValue> {
        let request: FilterRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsValue::from_str(&format!("フィルタの指定が正しくありません: {e}")))?;
        Self::build(
            file,
            JobMode::from(request),
            scratch_handles,
            output_handle,
            output_name,
            max_points_per_node,
        )
    }

    /// Handles one tile of the source and writes its kept points to the spill. Go to `finish` when `done`.
    pub fn advance(&mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("advanceはfinishの後には呼べない"))?;

        let read_start = Instant::now();
        let step = self.job.advance().map_err(to_js_error)?;
        self.source_read_and_decode += read_start.elapsed();

        let push_start = Instant::now();
        for record in &step.kept {
            spill.push(record).map_err(to_js_error)?;
            self.points_fed += 1;
        }
        self.spill_write += push_start.elapsed();

        let dto = ThinFilterStepDto {
            points_read: step.points_read,
            total_points: step.total_points,
            points_kept: self.points_fed,
            done: step.done,
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    /// Builds the octree and writes the OPFS output. Fails (writing nothing) for zero points.
    pub fn finish(mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        if self.points_fed == 0 {
            return Err(JsValue::from_str(EMPTY_RESULT_MESSAGE));
        }
        let reader = spill.finalize().map_err(to_js_error)?;
        let post_timings = write_copc_from_spill_with_fs_and_timings(
            &self.fs,
            Path::new(&self.output_name),
            reader,
            &self.params,
            &NeverCancel,
            &self.metadata,
        )
        .map_err(to_js_error)?;

        let dto = crate::dto::FinishResultDto {
            point_count: self.points_fed,
            stage_timings: crate::dto::ConversionStageBreakdownDto::new(
                self.source_read_and_decode,
                self.spill_write,
                post_timings,
                self.points_fed,
                self.file_size_bytes,
                Some(self.fs.io_timings()),
                Some(self.fs.read_stats()),
                Some(self.fs.seq_read_stats()),
                1,
            ),
            warnings: Vec::new(),
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }
}
