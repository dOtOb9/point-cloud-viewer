//! R7 (`TaskSheets/R7-web-ply-e57.md`): PLY / E57 to COPC conversion on the Web.
//!
//! `WasmPointFileConverter` is the one converter class the Worker uses for PLY and E57.
//! It has the same shape as `WasmPcdConverter` (`pcd_import.rs`) and `WasmConverter`
//! (`convert.rs`): `new` / `totalPoints` / `feed(batch)` / `finish`, so the Worker's
//! progress and cancel loop is the same for every format.
//!
//! The format specific part is only "give me the next point": `PlyStream` (`ply_import.rs`)
//! and `E57Stream` (`e57_import.rs`). Everything after that (spill, octree, OPFS output,
//! timings) is the same code path as the PCD converter. PCD keeps its own class on purpose:
//! R7 did not touch it (the owner asked to avoid refactoring working code).
//!
//! # Why PLY and E57 are copies of `crates/pcv-convert`
//!
//! See the long comment on the `pcd-rs` dependency in `crates/pcv-wasm/Cargo.toml`.
//! In short, this crate cannot depend on `pcv-convert` (workspace clash, and rayon would leak
//! into wasm32), so the readers are written again here. A fix in one place must be made in the
//! other (`ply_import.rs` and `e57_import.rs` say so in their headers).
//!
//! # Memory
//!
//! Nothing here holds a number of points that depends on the file. `feed` keeps at most
//! `batch_size` records, and the sources keep one row / one E57 packet.

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
use crate::e57_import::E57Stream;
use crate::file_reader::FileRangeReader;
use crate::opfs::OpfsScratchFs;
use crate::ply_import::PlyStream;
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

/// The format specific reader. A plain enum instead of a trait object: there are two
/// variants and every method is a two-arm `match`.
enum PointStream {
    Ply(PlyStream<FileReader>),
    // Boxed: the E57 reader is much larger than the PLY one (clippy::large_enum_variant).
    E57(Box<E57Stream<FileReader>>),
}

impl PointStream {
    fn has_color(&self) -> bool {
        match self {
            PointStream::Ply(s) => s.has_color(),
            PointStream::E57(s) => s.has_color(),
        }
    }

    fn declared_point_count(&self) -> u64 {
        match self {
            PointStream::Ply(s) => s.declared_point_count(),
            PointStream::E57(s) => s.declared_point_count(),
        }
    }

    fn next_point(&mut self) -> Result<Option<RawPoint>, String> {
        match self {
            PointStream::Ply(s) => s.next_point(),
            PointStream::E57(s) => s.next_point(),
        }
    }
}

/// Web PLY / E57 to COPC converter. Used by `runPointFileConversion` in
/// `src/datasource/copc.worker.ts`.
#[wasm_bindgen]
pub struct WasmPointFileConverter {
    stream: PointStream,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    declared_points: u64,
    points_fed: u64,
    output_name: String,
    params: CopcWriterParams,
    /// Same idea as in `WasmConverter` (`convert.rs`): `Instant::now()` once per batch,
    /// never once per point.
    source_read_and_decode: Duration,
    spill_write: Duration,
    file_size_bytes: u64,
}

#[wasm_bindgen]
impl WasmPointFileConverter {
    /// `format` is `"ply"` or `"e57"` (lower case, as `detectSourceFormatByName` returns it).
    #[wasm_bindgen(constructor)]
    pub fn new(
        format: String,
        file: File,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmPointFileConverter, JsValue> {
        let file_size_bytes = file.size() as u64;
        let source = FileRangeReader::new(file, Stats::new());
        let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
        let stream = match format.as_str() {
            "ply" => PointStream::Ply(PlyStream::open(buffered).map_err(to_js_error)?),
            "e57" => PointStream::E57(Box::new(E57Stream::open(buffered).map_err(to_js_error)?)),
            other => return Err(to_js_error(format!("Webで変換できない形式: {other}"))),
        };
        let declared_points = stream.declared_point_count();

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let layout = StreamingLayout {
            point_format: 0,
            has_gps: false,
            has_color: stream.has_color(),
            has_nir: false,
            has_waveform: false,
            extra_bytes: 0,
            extra_bytes_descriptors: Vec::new(),
        };
        let spill = SpillWriter::create(&fs, layout, None).map_err(to_js_error)?;

        Ok(Self {
            stream,
            spill: Some(spill),
            fs,
            declared_points,
            points_fed: 0,
            output_name,
            params: CopcWriterParams::new(max_points_per_node),
            source_read_and_decode: Duration::ZERO,
            spill_write: Duration::ZERO,
            file_size_bytes,
        })
    }

    /// The point count the file header declares (the progress denominator). E57 can yield
    /// fewer points than declared (missing grid slots are skipped).
    #[wasm_bindgen(js_name = totalPoints)]
    pub fn total_points(&self) -> f64 {
        self.declared_points as f64
    }

    /// Read at most `batch_size` points and write them to the spill.
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
            match self.stream.next_point().map_err(to_js_error)? {
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

    /// Build the octree and write the COPC to the OPFS output handle
    /// (same steps as `WasmPcdConverter::finish`).
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
        // PLY has no CRS. E57 may have one, but the reader does not pass it on (same as
        // `pcv-convert`, ADR-0008): `wkt_crs` stays `None` rather than guessing.

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
                1, // One file at a time, as for PCD.
            ),
            warnings: Vec::new(),
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }
}
