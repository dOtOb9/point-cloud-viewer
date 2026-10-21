//! G1-4 / G1-R2: Web version of the Rasterize window.
//!
//! The same two jobs as the desktop `crates/pcv-convert/src/raster.rs`, on top of the
//! shared code in `pcv_core::raster`; only the reading (`FileRangeReader`) differs.
//!
//! - `WasmRasterPreview`: reads the upper levels of the COPC into a bounded store when
//!   the window opens, then `render` draws a picture from it for every setting change.
//! - `WasmRasterizer`: the export. Streams every point into the grid, then `geotiff`
//!   gives the bytes. There is no other output (the raster is not a layer).
//!
//! # Calls
//!
//! The TypeScript Worker calls `feed` repeatedly with small batches and yields to the
//! event loop in between, so cancelling works.
//!
//! # Memory
//!
//! Preview: at most `PREVIEW_POINT_BUDGET` points (32 bytes each) plus a grid of about
//! 1M cells. Export: the grid holds a few bytes per cell (the constructor refuses a
//! raster over `MAX_CELLS_WEB` before reading), the reader holds one node, and the
//! GeoTIFF is built in one `Vec` (cells x 4 bytes, x 8 for 16-bit RGB). Nothing grows
//! with the point count.

use std::io::BufReader;

use copc_reader::CopcReader;
use pcv_core::crs::{crs_id_from_las_header, CrsId};
use pcv_core::extract::ExtractPoints;
use pcv_core::raster::output::{missing_crs_warning, write_geotiff};
use pcv_core::raster::preview::{
    CoarsePoints, CoarseReader, PreviewOptions, XyBounds, PREVIEW_POINT_BUDGET,
};
use pcv_core::raster::{CellAccumulator, GridSpec, RasterError, RasterOptions, RasterValue};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use web_sys::File;

use crate::file_reader::FileRangeReader;
use crate::stats::Stats;

/// The largest raster the Web build accepts (cells). Everything is in the Worker's wasm
/// memory (4 GiB at most), so it is a quarter of the desktop's. See
/// `TaskSheets/G1-T6-rasterize-tool.md` for how it was chosen.
pub const MAX_CELLS_WEB: u64 = 16_000_000;

const READ_BUFFER_BYTES: usize = 256 * 1024;

type Source = BufReader<FileRangeReader>;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

fn open_source(file: File) -> Source {
    BufReader::with_capacity(READ_BUFFER_BYTES, FileRangeReader::new(file, Stats::new()))
}

/// What the headers say that both classes need: layout facts, extent and CRS.
struct HeaderFacts {
    has_color: bool,
    bounds: XyBounds,
    epsg: Option<u32>,
}

fn read_header(file: &File) -> Result<HeaderFacts, JsValue> {
    let header_reader = las::Reader::new(open_source(file.clone()))
        .map_err(|e| JsValue::from_str(&format!("ヘッダーを読めませんでした: {e}")))?;
    let header = header_reader.header();
    let b = header.bounds();
    let epsg = match crs_id_from_las_header(header) {
        CrsId::Epsg(code) => Some(code),
        _ => None,
    };
    Ok(HeaderFacts {
        has_color: copc_core::StreamingLayout::from_las_header(header).has_color,
        bounds: XyBounds {
            min_x: b.min.x,
            min_y: b.min.y,
            max_x: b.max.x,
            max_y: b.max.y,
        },
        epsg,
    })
}

/// Progress returned by `feed` (both classes).
#[derive(Serialize)]
pub struct RasterFeedDto {
    pub points_scanned: u64,
    pub candidate_points: u64,
    pub done: bool,
}

/// Returned by `WasmRasterizer::info`.
#[derive(Serialize)]
pub struct RasterInfoDto {
    pub width: u32,
    pub height: u32,
    pub warnings: Vec<String>,
}

/// The upper levels of a COPC, kept while the Rasterize window is open.
#[wasm_bindgen]
pub struct WasmRasterPreview {
    reader: Option<CoarseReader<Source>>,
    store: Option<CoarsePoints>,
}

#[wasm_bindgen]
impl WasmRasterPreview {
    /// `file` is the source COPC. Nothing is read until `feed`.
    #[wasm_bindgen(constructor)]
    pub fn new(file: File) -> Result<WasmRasterPreview, JsValue> {
        let facts = read_header(&file)?;
        let copc_reader = CopcReader::open(open_source(file))
            .map_err(|e| JsValue::from_str(&format!("点群(COPC)として開けませんでした: {e}")))?;
        let reader = CoarseReader::new(
            copc_reader,
            facts.bounds,
            facts.has_color,
            PREVIEW_POINT_BUDGET as usize,
        );
        Ok(Self {
            reader: Some(reader),
            store: None,
        })
    }

    /// Reads up to `batch_size` points. `done` is true once the store is ready.
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let Some(reader) = self.reader.as_mut() else {
            return Err(JsValue::from_str("feedはもう終わっている"));
        };
        let done = reader.feed(batch_size as usize).map_err(to_js_error)?;
        let (points_scanned, candidate_points) = reader.progress();
        if done {
            if let Some(reader) = self.reader.take() {
                self.store = Some(reader.finish());
            }
        }
        serde_wasm_bindgen::to_value(&RasterFeedDto {
            points_scanned,
            candidate_points,
            done,
        })
        .map_err(to_js_error)
    }

    /// `{ heldPoints, depth, truncated }`. Call after `feed` reported `done`.
    pub fn info(&self) -> Result<JsValue, JsValue> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| JsValue::from_str("プレビューの点がまだ読めていません"))?;
        serde_wasm_bindgen::to_value(&store.open_info()).map_err(to_js_error)
    }

    /// Draws the preview for `options` (a `PreviewOptions` JSON) from the held points.
    /// The bytes are `PreviewImage::to_bytes` (layout in `pcv_core::raster::preview`).
    pub fn render(&self, options: JsValue) -> Result<Vec<u8>, JsValue> {
        let options: PreviewOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("プレビューの設定が正しくありません: {e}")))?;
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| JsValue::from_str("プレビューの点がまだ読めていません"))?;
        let image = store.render(&options).map_err(to_js_error)?;
        Ok(image.to_bytes())
    }
}

/// The export: every point into the grid, then the GeoTIFF bytes.
#[wasm_bindgen]
pub struct WasmRasterizer {
    points: ExtractPoints<'static, Source>,
    acc: CellAccumulator,
    options: RasterOptions,
    epsg: Option<u32>,
}

#[wasm_bindgen]
impl WasmRasterizer {
    /// `file` is the source COPC; `options` is the `RasterOptions` JSON (`src/datasource/tools.ts`).
    /// Fails before reading any point when the grid is over `MAX_CELLS_WEB`.
    #[wasm_bindgen(constructor)]
    pub fn new(file: File, options: JsValue) -> Result<WasmRasterizer, JsValue> {
        let options: RasterOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("ラスタ化の設定が正しくありません: {e}")))?;
        let facts = read_header(&file)?;
        if options.value == RasterValue::RgbMean && !facts.has_color {
            return Err(to_js_error(RasterError::NoColor));
        }
        let b = facts.bounds;
        let spec = GridSpec::from_bounds(
            b.min_x,
            b.min_y,
            b.max_x,
            b.max_y,
            options.cell_size,
            MAX_CELLS_WEB,
        )
        .map_err(to_js_error)?;
        let acc = CellAccumulator::new(spec, options.value, options.class_filter());
        let copc_reader = CopcReader::open(open_source(file))
            .map_err(|e| JsValue::from_str(&format!("点群(COPC)として開けませんでした: {e}")))?;
        Ok(Self {
            points: ExtractPoints::all(copc_reader),
            acc,
            options,
            epsg: facts.epsg,
        })
    }

    /// Reads up to `batch_size` points into the grid. Go to `geotiff` when `done`.
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let mut done = false;
        for _ in 0..batch_size {
            match self.points.next() {
                Some(Ok(record)) => self.acc.add_record(&record),
                Some(Err(e)) => return Err(to_js_error(e)),
                None => {
                    done = true;
                    break;
                }
            }
        }
        if done && self.acc.accepted_points() == 0 {
            return Err(to_js_error(RasterError::NoPoints));
        }
        let stats = self.points.stats();
        serde_wasm_bindgen::to_value(&RasterFeedDto {
            points_scanned: stats.points_scanned,
            candidate_points: stats.candidate_points,
            done,
        })
        .map_err(to_js_error)
    }

    /// The GeoTIFF bytes. Call after `feed` reported `done`.
    pub fn geotiff(&self) -> Result<Vec<u8>, JsValue> {
        let mut bytes = Vec::new();
        write_geotiff(&self.acc, self.epsg, &self.options, &mut bytes).map_err(to_js_error)?;
        Ok(bytes)
    }

    /// `{ width, height, warnings }`.
    pub fn info(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&RasterInfoDto {
            width: self.acc.spec().width,
            height: self.acc.spec().height,
            warnings: missing_crs_warning(self.epsg).into_iter().collect(),
        })
        .map_err(to_js_error)
    }
}
