//! G1-T15: Web version of the DTM tool. CSF classifies the ground of a COPC file, the classified points are written
//! into a new COPC file on OPFS, and the DTM (GeoTIFF and/or LandXML) is returned as bytes.
//!
//! The work is `pcv_core::dtm::DtmJob`, the same as on desktop (`crates/pcv-convert/src/dtm.rs`). A Worker cannot be
//! told to stop while a long call runs, so the Worker calls `advance` repeatedly (a small piece of work per call:
//! about 200 thousand points, or ten cloth steps) and yields to the event loop between calls, where a cancel message
//! is handled. This is the same shape as `WasmExtractor::feed`. The write side is the same as `extract.rs`:
//! `SpillWriter`, then `write_copc_from_spill_with_fs_and_timings`.
//!
//! # Calls
//!
//! `new` -> `advance` until done -> `finish` (octree, write, TIN) -> `info` / `geotiff` / `landxml`. `finish` keeps
//! the TIN in the object so the two files can be asked for afterwards.
//!
//! # Memory
//!
//! The cloth, the best-point grid and the TIN follow the area (the constructor refuses a cloth over
//! `DTM_MAX_PARTICLES_WEB` or a grid over the cell cap before reading a point). The reader holds one node and the
//! record buffer one `advance` call. The classified points go to the spill on OPFS. The GeoTIFF and LandXML are each
//! built in one `Vec` (the cell cap is lower when LandXML is asked for, see `DTM_MAX_CELLS_WEB_LANDXML`).

use std::path::Path;
use std::time::Duration;

use copc_core::{NeverCancel, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_copc_from_spill_with_fs_and_timings, CopcWriterParams, SpillWriter};
use js_sys::Array;
use pcv_core::crs::{crs_id_from_las_header, CrsId};
use pcv_core::dtm::{
    DtmJob, DtmRequest, DtmSurface, LandXmlOptions, DTM_MAX_CELLS_WEB, DTM_MAX_CELLS_WEB_LANDXML,
    DTM_MAX_PARTICLES_WEB,
};
use pcv_core::raster::output::missing_crs_warning;
use serde::Serialize;
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};
use web_time::Instant;

use crate::convert::handles_from_js_array;
use crate::extract::{open_source, Source};
use crate::opfs::OpfsScratchFs;
use crate::write_metadata::copc_write_metadata_from_source_header;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// Progress returned by `advance`.
#[derive(Serialize)]
pub struct DtmStepDto {
    /// 0 to 1 over the passes and the simulation.
    pub fraction: f32,
    /// Every point was read and classified (go on to `finish`).
    pub done: bool,
}

/// Returned by `info` (after `finish`).
#[derive(Serialize)]
pub struct DtmInfoDto {
    pub width: u32,
    pub height: u32,
    pub cell_size: f64,
    pub tin_points: usize,
    pub tin_triangles: usize,
    pub ground_points: u64,
    pub warnings: Vec<String>,
}

#[wasm_bindgen]
pub struct WasmDtm {
    reader: CopcReader<Source>,
    job: Option<DtmJob>,
    surface: Option<DtmSurface>,
    request: DtmRequest,
    epsg: Option<u32>,
    /// Name of the source, for the name of the LandXML surface.
    source_name: String,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    output_name: String,
    metadata: copc_writer::CopcWriteMetadata,
    params: CopcWriterParams,
    points_fed: u64,
    ground_points: u64,
    source_read_and_decode: Duration,
    spill_write: Duration,
    file_size_bytes: u64,
}

#[wasm_bindgen]
impl WasmDtm {
    /// `file` is the source COPC; `request` is the `DtmRequest` JSON (shape in `src/datasource/dtm.ts`, lengths in the
    /// file's unit). The scratch-file pool and output handle are the same ones the conversion uses.
    /// Fails before reading any point when the cloth or the grid is over its cap.
    #[wasm_bindgen(constructor)]
    pub fn new(
        file: File,
        request: JsValue,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmDtm, JsValue> {
        let request: DtmRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsValue::from_str(&format!("DTM の指定が正しくありません: {e}")))?;
        request.validate().map_err(to_js_error)?;
        let file_size_bytes = file.size() as u64;
        let source_name = file
            .name()
            .trim_end_matches(".laz")
            .trim_end_matches(".copc")
            .to_string();

        // Read the header (layout, output metadata, CRS) with `las`; no point data is read.
        let header_reader = las::Reader::new(open_source(file.clone()))
            .map_err(|e| JsValue::from_str(&format!("ヘッダーを読めませんでした: {e}")))?;
        let header = header_reader.header();
        let layout = StreamingLayout::from_las_header(header);
        let metadata = copc_write_metadata_from_source_header(header);
        let epsg = match crs_id_from_las_header(header) {
            CrsId::Epsg(code) => Some(code),
            _ => None,
        };
        drop(header_reader);

        let reader = CopcReader::open(open_source(file))
            .map_err(|e| JsValue::from_str(&format!("点群(COPC)として開けませんでした: {e}")))?;
        let max_cells = if request.output.landxml {
            DTM_MAX_CELLS_WEB_LANDXML
        } else {
            DTM_MAX_CELLS_WEB
        };
        let params = request.to_params(DTM_MAX_PARTICLES_WEB, max_cells);
        let job = DtmJob::new(&reader, epsg, &params).map_err(to_js_error)?;

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let spill = SpillWriter::create(&fs, layout, metadata.transform()).map_err(to_js_error)?;

        Ok(Self {
            reader,
            job: Some(job),
            surface: None,
            request,
            epsg,
            source_name,
            spill: Some(spill),
            fs,
            output_name,
            metadata,
            params: CopcWriterParams::new(max_points_per_node),
            points_fed: 0,
            ground_points: 0,
            source_read_and_decode: Duration::ZERO,
            spill_write: Duration::ZERO,
            file_size_bytes,
        })
    }

    /// Does a small piece of work and writes the classified points it made to the spill. Go to `finish` when `done`.
    pub fn advance(&mut self) -> Result<JsValue, JsValue> {
        let job = self
            .job
            .as_mut()
            .ok_or_else(|| JsValue::from_str("advanceはfinishの後には呼べない"))?;
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("advanceはfinishの後には呼べない"))?;

        let read_start = Instant::now();
        let progress = job.advance(&mut self.reader).map_err(to_js_error)?;
        let records = job.take_records();
        self.source_read_and_decode += read_start.elapsed();

        let push_start = Instant::now();
        for record in &records {
            spill.push(record).map_err(to_js_error)?;
            self.points_fed += 1;
        }
        self.spill_write += push_start.elapsed();

        serde_wasm_bindgen::to_value(&DtmStepDto {
            fraction: progress.fraction,
            done: progress.done,
        })
        .map_err(to_js_error)
    }

    /// Builds the octree and writes the OPFS output, then builds the TIN. Returns the same result as the conversion
    /// (`FinishResultDto`). Fails (writing nothing) when no point is ground.
    pub fn finish(&mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        let job = self
            .job
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        // The TIN first: with no ground point it fails before the (slow) COPC write.
        let ground_points = job.points_ground();
        let surface = job.finish().map_err(to_js_error)?;
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

        let warnings: Vec<String> = missing_crs_warning(self.epsg).into_iter().collect();
        self.surface = Some(surface);
        self.ground_points = ground_points;
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
            warnings,
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    /// `{ width, height, cell_size, tin_points, tin_triangles, ground_points, warnings }`. Call after `finish`.
    pub fn info(&self) -> Result<JsValue, JsValue> {
        let surface = self.surface()?;
        serde_wasm_bindgen::to_value(&DtmInfoDto {
            width: surface.grid().width,
            height: surface.grid().height,
            cell_size: surface.grid().cell_size,
            tin_points: surface.ground_cells(),
            tin_triangles: surface.triangle_count(),
            ground_points: self.ground_points,
            warnings: missing_crs_warning(self.epsg).into_iter().collect(),
        })
        .map_err(to_js_error)
    }

    /// The GeoTIFF bytes (`request.output.tiff`). Call after `finish`.
    pub fn geotiff(&self) -> Result<Vec<u8>, JsValue> {
        let mut bytes = Vec::new();
        self.surface()?
            .write_geotiff(&mut bytes, self.request.output.tiff)
            .map_err(to_js_error)?;
        Ok(bytes)
    }

    /// The LandXML bytes. `unix_seconds` is the time to write (the Worker reads the clock). Call after `finish`.
    pub fn landxml(&self, unix_seconds: f64) -> Result<Vec<u8>, JsValue> {
        let mut bytes = Vec::new();
        self.surface()?
            .write_landxml(
                &mut bytes,
                &LandXmlOptions {
                    name: &self.source_name,
                    unit: self.request.output.unit,
                    unix_seconds: unix_seconds as i64,
                },
            )
            .map_err(to_js_error)?;
        Ok(bytes)
    }
}

impl WasmDtm {
    fn surface(&self) -> Result<&DtmSurface, JsValue> {
        self.surface
            .as_ref()
            .ok_or_else(|| JsValue::from_str("finishの前には呼べない"))
    }
}
