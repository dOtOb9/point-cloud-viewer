//! M4-6b: Web版のLAS/LAZ→COPC変換。
//!
//! # なぜ「バッチを1つずつ呼ぶ」設計にしたか(キャンセルの制約)
//!
//! デスクトップ・Android版(M4-3、`crates/pcv-convert/src/streaming.rs`)は、
//! 変換を別スレッドで走らせ、UIスレッドが`Arc<AtomicBool>`を立てるだけで
//! いつでもキャンセルできる。Web版にはこの手段が無い:
//!
//! - Web WorkerはUIスレッドと別だが、**このWorker自身は1本しかなく**
//!   (ADR-0012「Web版はまずWorker1本」)、変換もこのWorkerの中で動かす
//! - `postMessage`で届く「キャンセルして」というメッセージは、Workerの
//!   JavaScriptイベントループが空いている時にしか処理されない。Rustの
//!   1回の長い同期呼び出し(`fill_points`を何百万回も回すような処理)の
//!   **途中では絶対に処理されない**(JavaScriptはシングルスレッドの
//!   イベントループなので、実行中の関数はメッセージ処理を横取りされない)
//! - `SharedArrayBuffer`+`Atomics.wait`を使えば、メインスレッドが直接
//!   共有メモリへ書き込むことでWorkerを本当の意味で「今すぐ」止められるが、
//!   これには`crossOriginIsolated`(COOP/COEPヘッダー)が要る。**GitHub Pages
//!   は静的ホスティングでレスポンスヘッダーをカスタマイズできない**ため、
//!   このプロジェクトのデプロイ先(`.github/workflows/pages.yml`)では使えない
//!
//! したがって、**読み込み段階をTypeScript側から小さなバッチ単位
//! (`feed`)で駆動する**ことで、バッチとバッチの間にWorkerのイベントループへ
//! 制御を返す機会を作る(`src/datasource/copc.worker.ts`が
//! `await`で明示的に譲る)。その隙間でなら`postMessage`によるキャンセル要求を
//! 処理できるので、**読み込み段階のキャンセルは実質的に即座に効く**。
//!
//! 一方、`finish`(octree構築・チャンク圧縮・書き出し)は`copc-writer`本体の
//! 1回の同期呼び出しであり、**この間はキャンセルを割り込ませられない**。
//! `finish`を呼ぶ前にキャンセル済みなら呼ばない(TypeScript側の責務)ことで
//! 「後処理が始まってしまったら、それが終わるまで待つしかない」という
//! 制約を最小化している。この制約は
//! `TaskSheets/ADR-0006-conversion-strategy.md`のWeb版の節に記録する。
//!
//! # 一時ファイルの後始末
//!
//! この構造体自身はOPFSファイルの削除・ハンドルのクローズを一切行わない。
//! ハンドル(`web_sys::FileSystemSyncAccessHandle`)はTypeScript側
//! (`src/datasource/opfs.ts`)が開いたものをそのまま借りているだけで、
//! 閉じる・OPFSから消す責務は呼び出し元(Worker、成功・失敗・キャンセルの
//! いずれでも同じ後始末を通す)にある。理由は`opfs.rs`のドキュメント参照。

use std::path::Path;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{write_copc_from_spill_with_fs, CopcWriterParams, SpillWriter};
use js_sys::Array;
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};

use crate::file_reader::FileRangeReader;
use crate::opfs::OpfsScratchFs;
use crate::stats::Stats;
use crate::write_metadata::copc_write_metadata_from_source_header;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// `js_sys::Array`(`FileSystemSyncAccessHandle`の配列)を`Vec`へ変換する。
fn handles_from_js_array(array: &Array) -> Result<Vec<FileSystemSyncAccessHandle>, JsValue> {
    let mut handles = Vec::with_capacity(array.length() as usize);
    for value in array.iter() {
        let handle: FileSystemSyncAccessHandle = value.dyn_into().map_err(|_| {
            JsValue::from_str("scratch_handlesの要素がFileSystemSyncAccessHandleではない")
        })?;
        handles.push(handle);
    }
    Ok(handles)
}

#[wasm_bindgen]
pub struct WasmConverter {
    reader: las::Reader,
    point_data: las::PointData,
    /// spillへの書き込みが終わったら`finish`が`take`する。`feed`は
    /// `finish`が呼ばれた後には使えない(`None`ならエラーを返す)。
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    total_points: u64,
    points_fed: u64,
    output_name: String,
    metadata: copc_writer::CopcWriteMetadata,
    params: CopcWriterParams,
}

#[wasm_bindgen]
impl WasmConverter {
    /// `file`は変換元のLAS/LAZ。`scratch_handles`は事前に開いた一時ファイルの
    /// プール(`opfs.rs`のドキュメント参照)、`output_handle`は出力先として
    /// 事前に開いたハンドル、`output_name`は`ScratchFs::create_output`へ渡す
    /// 識別名(OPFS向け実装は内容の確定にファイル名を使わないため、
    /// ログ・デバッグ用途以上の意味は持たない)。
    #[wasm_bindgen(constructor)]
    pub fn new(
        file: File,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmConverter, JsValue> {
        let stats = Stats::new();
        let source = FileRangeReader::new(file, stats);
        let reader = las::Reader::new(source).map_err(to_js_error)?;

        let layout = StreamingLayout::from_las_header(reader.header());
        let metadata = copc_write_metadata_from_source_header(reader.header());
        let total_points = reader.header().number_of_points();
        let point_data = las::PointDataBuilder::new()
            .for_header(reader.header())
            .build();

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let spill = SpillWriter::create(&fs, layout).map_err(to_js_error)?;

        Ok(Self {
            reader,
            point_data,
            spill: Some(spill),
            fs,
            total_points,
            points_fed: 0,
            output_name,
            metadata,
            params: CopcWriterParams::new(max_points_per_node),
        })
    }

    /// 最大`batch_size`点を読み、spillへ書く。呼び出し側
    /// (`src/datasource/copc.worker.ts`)はこれを繰り返し呼び、呼び出しの
    /// 合間に`await`でWorkerのイベントループへ制御を返す
    /// (キャンセル要求を受け取れるようにするため。モジュールドキュメント参照)。
    ///
    /// 戻り値(`dto::FeedResultDto`)の`done`が`true`になったら、これ以上
    /// `feed`を呼ばず`finish`へ進む。
    #[wasm_bindgen(js_name = feed)]
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("feedはfinishの後には呼べない"))?;

        let count = self
            .reader
            .fill_points(u64::from(batch_size), &mut self.point_data)
            .map_err(to_js_error)?;
        if count > 0 {
            for result in self.point_data.points() {
                let point = result.map_err(to_js_error)?;
                spill
                    .push(&LasPointRecord::from_las_point(&point))
                    .map_err(to_js_error)?;
                self.points_fed += 1;
            }
        }

        let dto = crate::dto::FeedResultDto {
            points_read: self.points_fed,
            total_points: self.total_points,
            done: count == 0,
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    /// 読み込みを終え、octreeを構築してOPFSの出力ハンドルへ書き出す。
    /// この呼び出しの間はキャンセルできない(モジュールドキュメント参照)。
    /// 呼び出し元はこれを呼ぶ前に、直近の`feed`で`done: true`が返っている
    /// ことを確認すること(このメソッド自身は`feed`が尽きたかを検証しない。
    /// spillに一部の点しか無い状態でも変換自体は成立してしまうため、
    /// 呼び出し順の誤りは検出しない設計にしてある。単純さを優先した)。
    #[wasm_bindgen(js_name = finish)]
    pub fn finish(mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        let reader = spill.finalize().map_err(to_js_error)?;
        write_copc_from_spill_with_fs(
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
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }
}
