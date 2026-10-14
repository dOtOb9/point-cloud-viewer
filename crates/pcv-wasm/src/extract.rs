//! L2-C: Web版の「COPCから条件に合う点だけを新しいCOPCに書く」(点の選択・断面)。
//!
//! デスクトップ(`crates/pcv-convert/src/extract.rs`)と同じ読み出し部
//! (`pcv_core::extract::ExtractPoints`。条件と交わるノードだけを読み、同時に抱える点は
//! 1ノード分だけ)を使い、書き出しはWeb版の変換(`convert.rs`)と同じ
//! `SpillWriter` → `write_copc_from_spill_with_fs_and_timings`(OPFS上の一時ファイルと出力)。
//! 新しいoctree/writerは書いていない。
//!
//! キャンセルの扱いも変換と同じ(`convert.rs`冒頭の説明): 呼び出し側(TypeScriptのWorker)が
//! `feed`を小さなバッチで繰り返し呼び、合間にイベントループへ制御を返す。`finish`
//! (octree構築〜書き出し)の間はキャンセルできない。
//!
//! 0点のときは、`finish`が書き出しを始める前にエラー(「選んだ範囲に点がありません」)にする。

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

/// 点を読む側の先読みバッファ。1ノード(LAZの1チャンク)を1回で読めれば足りるので小さめ。
const READ_BUFFER_BYTES: usize = 256 * 1024;

/// デスクトップ(`ExtractError::EmptySelection`)と同じ本文。
const EMPTY_SELECTION_MESSAGE: &str = "選んだ範囲に点がありません";

type Source = BufReader<FileRangeReader>;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// `feed`が返す進捗。
#[derive(Serialize)]
pub struct ExtractFeedDto {
    /// ここまでに読んだ点数。
    pub points_scanned: u64,
    /// 読む予定のノードの点数の合計(進捗の分母)。
    pub candidate_points: u64,
    /// 条件に合って書いた点数。
    pub points_matched: u64,
    /// 読み終えた(`finish`へ進める)。
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

fn open_source(file: File) -> Source {
    BufReader::with_capacity(READ_BUFFER_BYTES, FileRangeReader::new(file, Stats::new()))
}

#[wasm_bindgen]
impl WasmExtractor {
    /// `file`は元のCOPC、`filter`は`ExtractFilter`のJSON(`src/datasource/tools.ts`の形)。
    /// 一時ファイルのプールと出力ハンドルは変換(`WasmConverter`)と同じもの。
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

        // ヘッダー(レイアウトと出力のメタデータ)は`las`で読む。点データは読まない。
        let header_reader = las::Reader::new(open_source(file.clone())).map_err(|e| {
            JsValue::from_str(&format!("ヘッダーを読めませんでした: {e}"))
        })?;
        let layout = StreamingLayout::from_las_header(header_reader.header());
        let metadata = copc_write_metadata_from_source_header(header_reader.header());
        drop(header_reader);

        let copc_reader = CopcReader::open(open_source(file)).map_err(|e| {
            JsValue::from_str(&format!("点群(COPC)として開けませんでした: {e}"))
        })?;
        let points = ExtractPoints::new(copc_reader, filter).map_err(to_js_error)?;

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let spill = SpillWriter::create(&fs, layout).map_err(to_js_error)?;

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

    /// 最大`batch_size`点を取り出してspillへ書く。`done`になったら`finish`へ。
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

    /// octreeを構築してOPFSの出力へ書く。0点ならエラー(何も書かない)。
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
