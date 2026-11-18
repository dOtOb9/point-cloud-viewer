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
use crate::stats::BytesReadCounter;

pub const MAX_CELLS_WEB: u64 = 16_000_000;

const READ_BUFFER_BYTES: usize = 256 * 1024;

type Source = BufReader<FileRangeReader>;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

fn open_source(file: File) -> Source {
    BufReader::with_capacity(
        READ_BUFFER_BYTES,
        FileRangeReader::new(file, BytesReadCounter::new()),
    )
}

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

#[derive(Serialize)]
pub struct RasterFeedDto {
    pub points_scanned: u64,
    pub candidate_points: u64,
    pub done: bool,
}

#[derive(Serialize)]
pub struct RasterInfoDto {
    pub width: u32,
    pub height: u32,
    pub warnings: Vec<String>,
}

#[wasm_bindgen]
pub struct WasmRasterPreview {
    reader: Option<CoarseReader<Source>>,
    store: Option<CoarsePoints>,
}

#[wasm_bindgen]
impl WasmRasterPreview {
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

    pub fn info(&self) -> Result<JsValue, JsValue> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| JsValue::from_str("プレビューの点がまだ読めていません"))?;
        serde_wasm_bindgen::to_value(&store.open_info()).map_err(to_js_error)
    }

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

#[wasm_bindgen]
pub struct WasmRasterizer {
    points: ExtractPoints<'static, Source>,
    acc: CellAccumulator,
    options: RasterOptions,
    epsg: Option<u32>,
}

#[wasm_bindgen]
impl WasmRasterizer {
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

    pub fn geotiff(&self) -> Result<Vec<u8>, JsValue> {
        let mut bytes = Vec::new();
        write_geotiff(&self.acc, self.epsg, &self.options, &mut bytes).map_err(to_js_error)?;
        Ok(bytes)
    }

    pub fn info(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&RasterInfoDto {
            width: self.acc.spec().width,
            height: self.acc.spec().height,
            warnings: missing_crs_warning(self.epsg).into_iter().collect(),
        })
        .map_err(to_js_error)
    }
}
