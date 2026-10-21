//! L2-C: Web version of "write only the points of a COPC file that match a condition
//! into a new COPC file" (point selection, cross section).
//!
//! The read side is the same as on desktop (`crates/pcv-convert/src/extract.rs`):
//! `pcv_core::extract::ExtractPoints` reads only the nodes that intersect the
//! condition and holds one node of points at a time. The write side is the same as
//! the Web conversion (`convert.rs`): `SpillWriter` then
//! `write_copc_from_spill_with_fs_and_timings` (temporary files and output on OPFS).
//! No new octree / writer code.
//!
//! Cancellation also works like the conversion (see the top of `convert.rs`): the
//! caller (the TypeScript Worker) calls `feed` repeatedly with small batches and
//! yields to the event loop in between. It cannot be cancelled during `finish`
//! (octree build and write).
//!
//! With zero points, `finish` fails (with "選んだ範囲に点がありません") before it
//! starts writing.

use std::io::BufReader;
use std::path::Path;
use std::time::Duration;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_copc_from_spill_with_fs_and_timings, CopcWriterParams, SpillWriter};
use js_sys::Array;
use pcv_core::extract::{ExtractFilter, ExtractPoints};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};
use web_time::Instant;

use crate::convert::handles_from_js_array;
use crate::file_reader::FileRangeReader;
use crate::opfs::OpfsScratchFs;
use crate::stats::Stats;
use crate::write_metadata::copc_write_metadata_from_source_header;

/// Read-ahead buffer of the source reader. One node (one LAZ chunk) fits in a single read, so it is small.
const READ_BUFFER_BYTES: usize = 256 * 1024;

/// Same text as the desktop `ExtractError::EmptySelection`.
const EMPTY_SELECTION_MESSAGE: &str = "選んだ範囲に点がありません";

pub(crate) type Source = BufReader<FileRangeReader>;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// Progress returned by `feed`.
#[derive(Serialize)]
pub struct ExtractFeedDto {
    /// Points read so far.
    pub points_scanned: u64,
    /// Total points of the nodes that will be read (denominator of progress).
    pub candidate_points: u64,
    /// Matching points written.
    pub points_matched: u64,
    /// Reading is finished (go on to `finish`).
    pub done: bool,
}

#[wasm_bindgen]
pub struct WasmExtractor {
    points: ExtractPoints<'static, Source>,
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

pub(crate) fn open_source(file: File) -> Source {
    BufReader::with_capacity(READ_BUFFER_BYTES, FileRangeReader::new(file, Stats::new()))
}

#[wasm_bindgen]
impl WasmExtractor {
    /// `file` is the source COPC; `filter` is the `ExtractFilter` JSON (shape in `src/datasource/tools.ts`).
    /// The scratch-file pool and output handle are the same ones the conversion (`WasmConverter`) uses.
    #[wasm_bindgen(constructor)]
    pub fn new(
        file: File,
        filter: JsValue,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmExtractor, JsValue> {
        let filter: ExtractFilter = serde_wasm_bindgen::from_value(filter)
            .map_err(|e| JsValue::from_str(&format!("抽出の条件が正しくありません: {e}")))?;
        let file_size_bytes = file.size() as u64;

        // Read the header (layout and output metadata) with `las`; no point data is read.
        let header_reader = las::Reader::new(open_source(file.clone()))
            .map_err(|e| JsValue::from_str(&format!("ヘッダーを読めませんでした: {e}")))?;
        let layout = StreamingLayout::from_las_header(header_reader.header());
        let metadata = copc_write_metadata_from_source_header(header_reader.header());
        drop(header_reader);

        let copc_reader = CopcReader::open(open_source(file))
            .map_err(|e| JsValue::from_str(&format!("点群(COPC)として開けませんでした: {e}")))?;
        let points = ExtractPoints::new(copc_reader, filter).map_err(to_js_error)?;

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let spill = SpillWriter::create(&fs, layout, metadata.transform()).map_err(to_js_error)?;

        Ok(Self {
            points,
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

    /// Takes up to `batch_size` points and writes them to the spill. Go to `finish` when `done`.
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("feedはfinishの後には呼べない"))?;

        let read_start = Instant::now();
        let mut records: Vec<LasPointRecord> = Vec::new();
        let mut done = false;
        while records.len() < batch_size as usize {
            match self.points.next() {
                Some(Ok(record)) => records.push(record),
                Some(Err(e)) => return Err(to_js_error(e)),
                None => {
                    done = true;
                    break;
                }
            }
        }
        self.source_read_and_decode += read_start.elapsed();

        let push_start = Instant::now();
        for record in &records {
            spill.push(record).map_err(to_js_error)?;
            self.points_fed += 1;
        }
        self.spill_write += push_start.elapsed();

        let stats = self.points.stats();
        let dto = ExtractFeedDto {
            points_scanned: stats.points_scanned,
            candidate_points: stats.candidate_points,
            points_matched: self.points_fed,
            done,
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
            return Err(JsValue::from_str(EMPTY_SELECTION_MESSAGE));
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
