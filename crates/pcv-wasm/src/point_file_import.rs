use std::io::BufReader;
use std::path::Path;
use std::time::Duration;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs_and_timings, CopcWriteMetadata, CopcWriterParams, SpillWriter,
};
use js_sys::Array;
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};
use web_time::Instant;

use crate::convert::handles_from_js_array;
use crate::file_reader::FileRangeReader;
use crate::opfs::OpfsScratchFs;
use crate::point_merge::{InputInfo, MergedPoints, OpenFile, PointFormat, PointStream};
use crate::stats::BytesReadCounter;

const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct RawPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub color: [u16; 3],
    pub intensity: u16,
}

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

type FileReader = BufReader<FileRangeReader>;

struct JsInputs {
    infos: Vec<InputInfo>,
    formats: Vec<PointFormat>,
    files: Vec<File>,
}

fn inputs_from_js(formats: &Array, files: &Array) -> Result<JsInputs, JsValue> {
    if formats.length() != files.length() || files.length() == 0 {
        return Err(to_js_error("formatsとfilesの個数が合わない、または空"));
    }
    let mut infos = Vec::new();
    let mut parsed_formats = Vec::new();
    let mut parsed_files = Vec::new();
    for (format, file) in formats.iter().zip(files.iter()) {
        let format_name = format
            .as_string()
            .ok_or_else(|| to_js_error("formatsの要素が文字列ではない"))?;
        let format = PointFormat::from_name(&format_name).map_err(to_js_error)?;
        let file: File = file
            .dyn_into()
            .map_err(|_| to_js_error("filesの要素がFileではない"))?;
        infos.push(InputInfo {
            name: file.name(),
            format,
            file_size_bytes: file.size() as u64,
        });
        parsed_formats.push(format);
        parsed_files.push(file);
    }
    Ok(JsInputs {
        infos,
        formats: parsed_formats,
        files: parsed_files,
    })
}

#[wasm_bindgen]
pub struct WasmPointFileConverter {
    points: MergedPoints<FileReader>,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    declared_points: u64,
    points_fed: u64,
    output_name: String,
    params: CopcWriterParams,
    wkt_crs: Option<String>,
    warnings: Vec<String>,
    input_file_count: u64,
    source_read_and_decode: Duration,
    spill_write: Duration,
    file_size_bytes: u64,
}

#[wasm_bindgen]
impl WasmPointFileConverter {
    #[wasm_bindgen(constructor)]
    pub fn new(
        formats: Array,
        files: Array,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmPointFileConverter, JsValue> {
        let JsInputs {
            infos: inputs,
            formats: parsed_formats,
            files: parsed_files,
        } = inputs_from_js(&formats, &files)?;
        let input_file_count = inputs.len() as u64;

        let open: OpenFile<FileReader> = Box::new(move |i| {
            let (Some(format), Some(file)) = (parsed_formats.get(i), parsed_files.get(i)) else {
                return Err(format!("ファイル番号{i}が範囲外"));
            };
            let source = FileRangeReader::new(file.clone(), BytesReadCounter::new());
            let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
            PointStream::open(*format, buffered)
        });
        let (points, plan) = MergedPoints::start(inputs, open).map_err(to_js_error)?;

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let layout = StreamingLayout {
            point_format: 0,
            has_gps: false,
            has_color: plan.output_has_color,
            has_nir: false,
            has_waveform: false,
            extra_bytes: 0,
            extra_bytes_descriptors: Vec::new(),
        };
        let spill = SpillWriter::create(&fs, layout, None).map_err(to_js_error)?;

        Ok(Self {
            points,
            spill: Some(spill),
            fs,
            declared_points: plan.total_points,
            points_fed: 0,
            output_name,
            params: CopcWriterParams::new(max_points_per_node),
            wkt_crs: plan.wkt_crs,
            warnings: plan.warnings,
            input_file_count,
            source_read_and_decode: Duration::ZERO,
            spill_write: Duration::ZERO,
            file_size_bytes: plan.total_file_size_bytes,
        })
    }

    #[wasm_bindgen(js_name = totalPoints)]
    pub fn total_points(&self) -> f64 {
        self.declared_points as f64
    }

    #[wasm_bindgen(js_name = feed)]
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("feedはfinishの後には呼べない"))?;

        let read_start = Instant::now();
        let mut records = Vec::with_capacity(batch_size as usize);
        let mut done = false;
        while records.len() < batch_size as usize {
            match self.points.next_point().map_err(to_js_error)? {
                Some(p) => records.push(LasPointRecord {
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    intensity: p.intensity,
                    red: p.color[0],
                    green: p.color[1],
                    blue: p.color[2],
                    ..LasPointRecord::default()
                }),
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

        let dto = crate::dto::FeedResultDto {
            points_read: self.points_fed,
            total_points: self.declared_points,
            done,
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = finish)]
    pub fn finish(mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        let reader = spill.finalize().map_err(to_js_error)?;
        let bounds = reader.bounds();
        let (scale, offset) = crate::pcd_import::choose_scale_offset(bounds.min, bounds.max);

        let mut metadata = CopcWriteMetadata::default();
        metadata.scale = Some(scale);
        metadata.offset = Some(offset);
        metadata.wkt_crs = self.wkt_crs.take();

        let post_timings = write_copc_from_spill_with_fs_and_timings(
            &self.fs,
            Path::new(&self.output_name),
            reader,
            &self.params,
            &NeverCancel,
            &metadata,
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
                self.input_file_count,
            ),
            warnings: std::mem::take(&mut self.warnings),
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }
}
