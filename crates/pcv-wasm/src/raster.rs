//! G1-4: Web version of the Rasterize tool.
//!
//! The same job as the desktop `crates/pcv-convert/src/raster.rs`: stream every point of
//! a COPC into a grid (`pcv_core::raster`), then make a GeoTIFF and a display COPC with
//! one point per non-empty cell. The shared parts (grid, accumulators, GeoTIFF, display
//! points) live in `pcv-core`; only the reading (`FileRangeReader`) and the writing
//! (`SpillWriter` on OPFS) differ, exactly as for `extract.rs`.
//!
//! # Calls
//!
//! The TypeScript Worker calls `feed` repeatedly with small batches and yields to the
//! event loop in between, so cancelling works. `feed` has two phases:
//!
//! 1. reading: points go into the grid (`points_scanned` grows);
//! 2. emitting: the non-empty cells go to the spill (`done` is true after the last one).
//!
//! Then `geotiff()` gives the GeoTIFF bytes and `finish()` builds the octree and writes
//! the display COPC (that last step cannot be cancelled, like the other tools).
//!
//! # Memory
//!
//! The grid holds a few bytes per cell (the Worker refuses a raster over
//! `MAX_CELLS_WEB` before reading), the reader holds one node, the GeoTIFF is built in
//! one `Vec` (cells x 4 bytes, or x 8 for RGB). Nothing grows with the point count.

use std::io::BufReader;
use std::path::Path;

use copc_core::{NeverCancel, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_copc_from_spill_with_fs_and_timings, CopcWriterParams, SpillWriter};
use js_sys::Array;
use pcv_core::crs::{crs_id_from_las_header, CrsId};
use pcv_core::extract::ExtractPoints;
use pcv_core::raster::output::{missing_crs_warning, write_geotiff};
use pcv_core::raster::{CellAccumulator, DisplayCursor, GridSpec, RasterOptions, RasterValue};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};

use crate::convert::handles_from_js_array;
use crate::file_reader::FileRangeReader;
use crate::opfs::OpfsScratchFs;
use crate::stats::Stats;
use crate::write_metadata::copc_write_metadata_from_source_header;

/// The largest raster the Web build accepts (cells). Everything is in the Worker's wasm
/// memory (4 GiB at most, shared with the spill buffers), so it is a quarter of the
/// desktop's. See `TaskSheets/G1-T6-rasterize-tool.md` for how it was chosen.
pub const MAX_CELLS_WEB: u64 = 16_000_000;

const READ_BUFFER_BYTES: usize = 256 * 1024;

/// Same text as the desktop `RasterRunError::NoPoints`.
const NO_POINTS_MESSAGE: &str = "ラスタにできる点がありません";
/// Same text as the desktop `RasterRunError::NoColor`.
const NO_COLOR_MESSAGE: &str = "このレイヤーは色を持たないため、色(RGB)のラスタは作れません";

type Source = BufReader<FileRangeReader>;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

fn open_source(file: File) -> Source {
    BufReader::with_capacity(READ_BUFFER_BYTES, FileRangeReader::new(file, Stats::new()))
}

/// Progress returned by `feed`.
#[derive(Serialize)]
pub struct RasterFeedDto {
    pub points_scanned: u64,
    pub candidate_points: u64,
    /// Both phases are finished (go on to `geotiff` and `finish`).
    pub done: bool,
}

/// Returned by `finish`.
#[derive(Serialize)]
pub struct RasterFinishDto {
    /// Points of the display COPC (= non-empty cells).
    pub point_count: u64,
    pub width: u32,
    pub height: u32,
    pub warnings: Vec<String>,
}

#[wasm_bindgen]
pub struct WasmRasterizer {
    points: ExtractPoints<'static, Source>,
    acc: CellAccumulator,
    /// `Some` once reading has finished (the emit phase).
    cursor: Option<DisplayCursor>,
    extra_bytes_len: usize,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    output_name: String,
    metadata: copc_writer::CopcWriteMetadata,
    params: CopcWriterParams,
    epsg: Option<u32>,
    display_points: u64,
    /// The emit phase has run out of cells.
    emit_done: bool,
}

#[wasm_bindgen]
impl WasmRasterizer {
    /// `file` is the source COPC; `options` is the `RasterOptions` JSON (`src/datasource/tools.ts`).
    /// Fails before reading any point when the grid is over `MAX_CELLS_WEB`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        file: File,
        options: JsValue,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmRasterizer, JsValue> {
        let options: RasterOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("ラスタ化の設定が正しくありません: {e}")))?;

        // Header only: layout, metadata, extent and CRS (no point data is read).
        let header_reader = las::Reader::new(open_source(file.clone()))
            .map_err(|e| JsValue::from_str(&format!("ヘッダーを読めませんでした: {e}")))?;
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
            return Err(JsValue::from_str(NO_COLOR_MESSAGE));
        }
        let spec = GridSpec::from_bounds(
            bounds.min.x,
            bounds.min.y,
            bounds.max.x,
            bounds.max.y,
            options.cell_size,
            MAX_CELLS_WEB,
        )
        .map_err(to_js_error)?;
        let acc = CellAccumulator::new(spec, options.value, options.class_filter());

        let copc_reader = CopcReader::open(open_source(file))
            .map_err(|e| JsValue::from_str(&format!("点群(COPC)として開けませんでした: {e}")))?;
        let points = ExtractPoints::all(copc_reader);

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let extra_bytes_len = usize::from(layout.extra_bytes);
        let spill = SpillWriter::create(&fs, layout, metadata.transform()).map_err(to_js_error)?;

        Ok(Self {
            points,
            acc,
            cursor: None,
            extra_bytes_len,
            spill: Some(spill),
            fs,
            output_name,
            metadata,
            params: CopcWriterParams::new(max_points_per_node),
            epsg,
            display_points: 0,
            emit_done: false,
        })
    }

    /// Does up to `batch_size` units of work: points read into the grid, or cells written
    /// to the spill. Go to `geotiff` / `finish` when `done`.
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let batch = batch_size as usize;
        match self.cursor.as_mut() {
            None => {
                let mut taken = 0;
                let mut exhausted = false;
                while taken < batch {
                    match self.points.next() {
                        Some(Ok(record)) => self.acc.add_record(&record),
                        Some(Err(e)) => return Err(to_js_error(e)),
                        None => {
                            exhausted = true;
                            break;
                        }
                    }
                    taken += 1;
                }
                if exhausted {
                    if self.acc.accepted_points() == 0 {
                        return Err(JsValue::from_str(NO_POINTS_MESSAGE));
                    }
                    self.cursor = Some(DisplayCursor::new(&self.acc, self.extra_bytes_len));
                }
            }
            Some(cursor) => {
                let spill = self
                    .spill
                    .as_mut()
                    .ok_or_else(|| JsValue::from_str("feedはfinishの後には呼べない"))?;
                let mut taken = 0;
                while taken < batch {
                    let Some(record) = cursor.next_record(&self.acc) else {
                        // The cursor has passed the last cell.
                        self.emit_done = true;
                        break;
                    };
                    spill.push(&record).map_err(to_js_error)?;
                    self.display_points += 1;
                    taken += 1;
                }
            }
        }
        let stats = self.points.stats();
        let dto = RasterFeedDto {
            points_scanned: stats.points_scanned,
            candidate_points: stats.candidate_points,
            done: self.emit_done,
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    /// The GeoTIFF bytes. Call after `feed` reported `done` and before `finish`.
    pub fn geotiff(&self) -> Result<Vec<u8>, JsValue> {
        let mut bytes = Vec::new();
        write_geotiff(&self.acc, self.epsg, &mut bytes).map_err(to_js_error)?;
        Ok(bytes)
    }

    /// Builds the octree and writes the display COPC on OPFS.
    pub fn finish(mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        if self.display_points == 0 {
            return Err(JsValue::from_str(NO_POINTS_MESSAGE));
        }
        let reader = spill.finalize().map_err(to_js_error)?;
        write_copc_from_spill_with_fs_and_timings(
            &self.fs,
            Path::new(&self.output_name),
            reader,
            &self.params,
            &NeverCancel,
            &self.metadata,
        )
        .map_err(to_js_error)?;
        let dto = RasterFinishDto {
            point_count: self.display_points,
            width: self.acc.spec().width,
            height: self.acc.spec().height,
            warnings: missing_crs_warning(self.epsg).into_iter().collect(),
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }
}
