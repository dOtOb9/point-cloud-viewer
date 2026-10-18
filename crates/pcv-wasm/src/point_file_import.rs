//! R7 (`TaskSheets/R7-web-ply-e57.md`), M4-17 (`TaskSheets/M4-17-merge-any-format.md`):
//! PLY / PCD / E57 (and, in a mixed merge, LAS/LAZ) to COPC on the Web.
//!
//! `WasmPointFileConverter` is the one converter class the Worker uses for every non-LAS
//! conversion. It has the same shape as `WasmConverter` (`convert.rs`): `new` / `totalPoints` /
//! `feed(batch)` / `finish`, so the Worker's progress and cancel loop is the same for every format.
//!
//! It takes a LIST of files. One file is the normal single-file conversion; several files are
//! read one after another into the same spill (`MergedPoints` in `point_merge.rs`). The format
//! specific part is only "give me the next point" (`PointStream` in `point_merge.rs`:
//! `PlyStream`, `PcdStream`, `E57Stream`, `LasStream`). Everything after that (spill, octree,
//! OPFS output, timings) is the same code path for all of them.
//!
//! # Why PLY / PCD / E57 are copies of `crates/pcv-convert`
//!
//! See the long comment on the `pcd-rs` dependency in `crates/pcv-wasm/Cargo.toml`.
//! In short, this crate cannot depend on `pcv-convert` (workspace clash, and rayon would leak
//! into wasm32), so the readers are written again here. A fix in one place must be made in the
//! other (`ply_import.rs` and `e57_import.rs` say so in their headers).
//!
//! # Memory
//!
//! Nothing here holds a number of points that depends on the files. `feed` keeps at most
//! `batch_size` records, and the sources keep one row / one E57 packet / one LAS batch.

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
use crate::stats::Stats;

/// Same value and reason as `READ_BUFFER_BYTES` in `convert.rs` (fewer JS round trips).
const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;

/// One point as the sources produce it. No scale, no COPC details.
/// Color is `[0, 0, 0]` when the file has none, intensity is `0` when it has none
/// (whether the file has color at all is `has_color`, asked once before the first point).
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

/// The values taken out of the constructor's JS arrays (all three have the same length).
struct JsInputs {
    infos: Vec<InputInfo>,
    formats: Vec<PointFormat>,
    files: Vec<File>,
}

/// Turn the two JS arrays of the constructor into Rust values: the info of each input and the
/// `File` objects. `formats[i]` is the format of `files[i]`.
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

/// Web PLY / PCD / E57 / LAS to COPC converter (one or several files). Used by
/// `runPointFileConversion` in `src/datasource/copc.worker.ts`.
#[wasm_bindgen]
pub struct WasmPointFileConverter {
    points: MergedPoints<FileReader>,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    /// The progress denominator: the sum of the declared point counts of all files.
    declared_points: u64,
    points_fed: u64,
    output_name: String,
    params: CopcWriterParams,
    /// WKT of the output CRS (from the LAS/LAZ inputs, if any).
    wkt_crs: Option<String>,
    warnings: Vec<String>,
    input_file_count: u64,
    /// Same idea as in `WasmConverter` (`convert.rs`): `Instant::now()` once per batch,
    /// never once per point.
    source_read_and_decode: Duration,
    spill_write: Duration,
    /// The sum of the sizes of all input files.
    file_size_bytes: u64,
}

#[wasm_bindgen]
impl WasmPointFileConverter {
    /// `formats[i]` is the format of `files[i]`: `"lasLaz"`, `"ply"`, `"pcd"` or `"e57"` (as
    /// `detectSourceFormatByName` returns it). The files are read in the given order, so the
    /// caller sorts them by name first (the output must not depend on the selection order).
    ///
    /// The constructor does the header pass: it opens every file once to learn whether it has
    /// color, how many points it declares, and its CRS. A CRS conflict between LAS/LAZ files is
    /// an error here, before any point is read.
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

        // Opens file number `i`; `MergedPoints` calls it for the header pass and again when a
        // file's turn comes. A `File` clone is cheap (a reference to the same browser file).
        let open: OpenFile<FileReader> = Box::new(move |i| {
            let (Some(format), Some(file)) = (parsed_formats.get(i), parsed_files.get(i)) else {
                return Err(format!("ファイル番号{i}が範囲外"));
            };
            let source = FileRangeReader::new(file.clone(), Stats::new());
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

    /// The point count the file headers declare, summed over all files (the progress
    /// denominator). E57 can yield fewer points than declared (missing grid slots are skipped).
    #[wasm_bindgen(js_name = totalPoints)]
    pub fn total_points(&self) -> f64 {
        self.declared_points as f64
    }

    /// Read at most `batch_size` points and write them to the spill. The points of all files
    /// come as one stream; `points_read` counts over all files so far.
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

    /// Build the octree and write the COPC to the OPFS output handle.
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
        // PLY / PCD / E57 carry no CRS (E57 may have one, but the reader does not pass it on,
        // same as `pcv-convert`, ADR-0008). The CRS comes only from LAS/LAZ inputs in a merge
        // (`plan_merge`); with none, `wkt_crs` stays `None` rather than guessing.
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
