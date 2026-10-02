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
//!
//! # 読み込みのバッファリング(2026-10-01、実機不具合の修正)
//!
//! `FileRangeReader`(`file_reader.rs`)の`Read::read`は、呼ばれるたびに
//! `File.slice`→`FileReaderSync::new()`→`read_as_array_buffer`→JSから
//! wasmへのコピー、という重い処理を行う(バッファを持たない)。`las::Reader`
//! は(LAZ非圧縮の生のLASでは)点を1件ずつ、点ごとの生レコード長(フォーマットに
//! よるが20〜38バイト程度)だけ読むため、**`FileRangeReader`を直接渡すと
//! 1点ごとにこの重い処理が1回走る。** 所有者の実機(Chrome)で、数万点を読む
//! 前に進捗が一度も出ないまま止まって見えるという不具合として実際に踏んだ
//! (`TaskSheets/M4-import-and-conversion.md`のM4-6b追記参照)。
//!
//! COPCを開く経路(`WasmCopcFile`、ADR-0012)は1ノード分のLAZチャンクを
//! まとめて読むため、この問題が表に出なかった(1回の`read`呼び出しが
//! 数万〜数十万バイト単位になる)。変換の経路だけがこの問題を持っていた。
//!
//! **対処**: `FileRangeReader`を`std::io::BufReader`(`READ_BUFFER_BYTES`、
//! 4MiB)で包んでから`las::Reader::new`に渡す。変換は入力の先頭から順に
//! (シークせず)読むだけなので、先読みがそのまま効く。`BufReader<R>`は
//! `R: Seek`なら`Seek`も実装する(`std::io::BufReader`の標準実装)ため、
//! `las::Reader::new`が要求する`Read + Seek + Send + Sync + 'static`を
//! 満たす(`FileRangeReader`は既に`unsafe impl Send`/`Sync`済み。
//! `file_reader.rs`参照)。
//!
//! **4MiBという値の根拠**: 読み込みは`feed(batch_size)`単位
//! (既定64Ki点、`src/datasource/copc.worker.ts`の`CONVERT_BATCH_SIZE`)で
//! 駆動する(モジュール冒頭「なぜ「バッチを1つずつ呼ぶ」設計にしたか」参照)。
//! LASの点フォーマットのうち本アプリが対象とする範囲で最大のものは
//! point format 7(RGB+GPS時刻、36バイト)相当で、64Ki点だと
//! 65,536 × 36 ≈ 2.36MiB。4MiBはこれに余裕を持たせた値で、
//! **1回の`feed`呼び出しがほぼ1回のバッファ補充(=1回の重い`FileRangeReader::read`
//! 呼び出し)で収まる**ように選んだ。回帰テストは
//! `crates/pcv-wasm/tests/buffered_file_reader_reduces_read_calls.rs`参照
//! (`FileRangeReader`と同じ「呼ばれるたびに重い」形の疑似リーダーで、
//! バッファの有無による下位`read`呼び出し回数の差を確認する)。
//!
//! # M4-7: LAZ展開の並列化(複数Worker)
//!
//! デスクトップ・Android(`crates/pcv-convert/src/streaming.rs`)は`las`クレートの
//! `laz-parallel`フィーチャ(`rayon`使用)でLAZ展開をスレッドプールに分担させた。
//! **Web版では`rayon`(スレッド)が使えない。** `rayon`はOSスレッドか
//! `wasm32`の`atomics`(`SharedArrayBuffer`)のどちらかを要求するが、GitHub Pages
//! は静的ホスティングでCOOP/COEPヘッダーを設定できないため`crossOriginIsolated`に
//! ならず、`SharedArrayBuffer`は使えない(`TaskSheets/ADR-0012-web-worker-sync-io.md`・
//! `TaskSheets/ADR-0006-conversion-strategy.md`のWeb版の節が既に確認済みの制約)。
//!
//! 代わりに、**独立したWeb Workerを複数立ててチャンク範囲を分担する**
//! (`src/datasource/laz-decompress.worker.ts`、新設)。Workerはメモリを共有しない
//! JSのグローバルなので、`SharedArrayBuffer`なしで真の並列実行になる。
//!
//! - 各展開Workerは、変換対象の`File`(構造化クローンで複製。`File`は不変な
//!   スナップショットなので複数Workerで同時に読んでも競合しない)と、
//!   自分が担当する点インデックスの範囲`[start_index, start_index+count)`を
//!   受け取る
//! - 展開Workerは**この変換専用の`WasmConverter`とは別の、独立した
//!   `las::Reader`**を自分の`File`に対して開く(`decompress_laz_range`)。
//!   `las::Reader::seek`でチャンクテーブルを辿って`start_index`近くまで
//!   直接ジャンプしてから(全点を先頭から読み直さない)、`count`点を
//!   読み進める
//! - 読んだ点は`copc_core::serialize_le`で、spillと同じ固定長バイト列に
//!   シリアライズしてから返す。**`copc_core`は`vendor/copc-writer`とは別の
//!   公開クレートで、どちらの担当エージェントも自由に使ってよい共通の
//!   シリアライズ形式を持っている**ため、新しい通信フォーマットを
//!   発明する必要が無かった
//! - 変換用Worker(メインの`WasmConverter`を持つ側)は、展開Workerから届いた
//!   バイト列を受け取るたびに`push_serialized_records`で`deserialize_le`→
//!   `SpillWriter::push`する。**spillへの書き込みは今までどおり1本の
//!   `WasmConverter`だけが行う**(`SpillWriter`はWorkerをまたいで共有できない
//!   ため、これ以外の設計は無い)
//!
//! ## 点の順序について
//!
//! `src/datasource/copc.worker.ts`の`runParallelReadPhase`は、担当範囲
//! (点インデックスの昇順)の順で結果を取り出して`pushSerializedRecords`に
//! 渡す(到着順ではない。全Workerは`postMessage`直後に並行して動き始める
//! ため、取り出す順序を決め打ちにしても並列度は落ちない)。そのため
//! 実際にはWeb版でも点の順序は保たれるが、**順序の保存は本質的な要件では
//! ない**: `SpillWriter::push`に渡す順序が変わっても、`copc-writer`の検証
//! (`validate_spill_record`)・統計(`PointStats`)はどちらも1点ごとに閉じた
//! 計算(範囲チェック・min/max・ヒストグラム)で、順序に依存しないことを
//! ソースで確認済み(vendor/copc-writerは読むだけで変更していない)。
//! そのためoctree構築の結果(最終的な点の集合・空間分割)にも影響しない。
//!
//! ## キャンセルと進捗
//!
//! キャンセルは、変換用Workerが展開Worker全員に対して`Worker.terminate()`を
//! 呼ぶ(TypeScript側、`src/datasource/copc.worker.ts`参照)。`terminate()`は
//! Workerの実行位置に関わらず即座に止まるため、従来の「バッチの合間に
//! `postMessage`を処理させる」方式より反応は悪くならない。進捗は、各展開
//! Workerが一定点数ごとに進捗を`postMessage`し、変換用Workerが全Worker分を
//! 合算してからUIへ転送する(`src/datasource/copc.worker.ts`の
//! `handleConvertStartParallel`参照)。

use std::io::BufReader;
use std::path::Path;

use copc_core::{deserialize_le, serialize_le, LasPointRecord, NeverCancel, StreamingLayout};
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

/// `FileRangeReader`を包む先読みバッファのサイズ。根拠はモジュール冒頭の
/// 「読み込みのバッファリング」参照。
const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;

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
    /// M4-7: 並列展開Workerが`copc_core::serialize_le`で作ったバイト列を
    /// `push_serialized_records`で読み戻すのに使う。`feed`が内部で使う
    /// レイアウトと同一であること(=同じファイルの同じヘッダーから導いた
    /// 値であること)が前提(モジュールドキュメント「M4-7」参照)。
    layout: StreamingLayout,
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
        // 読み込みのバッファリング(モジュール冒頭のドキュメント参照):
        // FileRangeReaderを直接渡すと、lasクレートが点ごとに行う小さい
        // read呼び出し1回ごとに重いJS往復が発生し、実機で進捗が出る前に
        // 止まって見えるほど遅くなる不具合があった。
        let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
        let reader = las::Reader::new(buffered).map_err(to_js_error)?;

        let layout = StreamingLayout::from_las_header(reader.header());
        let metadata = copc_write_metadata_from_source_header(reader.header());
        let total_points = reader.header().number_of_points();
        let point_data = las::PointDataBuilder::new()
            .for_header(reader.header())
            .build();

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let spill = SpillWriter::create(&fs, layout.clone()).map_err(to_js_error)?;

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
            layout,
        })
    }

    /// 入力の総点数(ヘッダーの申告値)。TypeScript側
    /// (`src/datasource/copc.worker.ts`)が、並列展開Workerへ割り振る
    /// 点インデックスの範囲を決めるために使う(M4-7)。
    #[wasm_bindgen(js_name = totalPoints)]
    pub fn total_points(&self) -> f64 {
        // JSのNumberはf64。2^53未満なら誤差無く表現できる(`bytesRead`等と同じ変換)。
        self.total_points as f64
    }

    /// spillの1レコードあたりのバイト数。並列展開Workerが返すバイト列は
    /// この幅ちょうどの倍数になるため、TypeScript側は
    /// `buffer.byteLength / recordWidth()`で点数を逆算できる(M4-7、
    /// 戻り値を別途やり取りする手間を省くため)。
    #[wasm_bindgen(js_name = recordWidth)]
    pub fn record_width(&self) -> u32 {
        self.layout.record_width() as u32
    }

    /// M4-7: 並列展開Worker(`decompress_laz_range`)が返したバイト列を
    /// spillへ書く。バイト列は`recordWidth()`ちょうどの倍数の長さを持つ、
    /// `copc_core::serialize_le`形式のレコードが連続したものであること。
    ///
    /// 展開Worker側で独立に`StreamingLayout::from_las_header`を計算して
    /// いるため(同じファイルの同じヘッダーから導くので値は一致するはずだが、
    /// 保険として)、渡されたバイト列の長さが`recordWidth()`の倍数で
    /// ないときはエラーにする(値が合わなければ即座に気づけるようにする。
    /// 黙って余りを捨てない)。
    #[wasm_bindgen(js_name = pushSerializedRecords)]
    pub fn push_serialized_records(&mut self, bytes: Vec<u8>) -> Result<(), JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("pushSerializedRecordsはfinishの後には呼べない"))?;

        let width = self.layout.record_width();
        if !bytes.len().is_multiple_of(width) {
            return Err(JsValue::from_str(&format!(
                "展開Workerから受け取ったバイト列({} バイト)がrecordWidth({width})の倍数ではない",
                bytes.len()
            )));
        }
        for chunk in bytes.chunks_exact(width) {
            let record = deserialize_le(chunk, &self.layout).map_err(to_js_error)?;
            spill.push(&record).map_err(to_js_error)?;
            self.points_fed += 1;
        }
        Ok(())
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

/// M4-7: 展開専用Worker(`src/datasource/laz-decompress.worker.ts`)から呼ぶ。
/// `file`の点インデックス`[start_index, start_index + count)`の範囲を展開し、
/// `copc_core::serialize_le`形式(`WasmConverter::recordWidth()`ちょうどの
/// 幅)の固定長レコードを連結したバイト列を返す。
///
/// `WasmConverter`とは完全に独立したインスタンス(自分専用の`las::Reader`)を
/// 開く。Web Workerはメモリを共有しないグローバルなので、これは「1つの
/// `File`を複数のWorkerがそれぞれ自分のReaderで読む」ことになるが、
/// `File`は不変なスナップショットであり、読み出しは`FileRangeReader`経由の
/// 範囲読み(`File.slice`)なので競合しない。
///
/// `start_index`が`total_points`以上、または末尾付近で`count`点に
/// 満たない場合は、実際に読めた点数ぶんだけの(`recordWidth()`の倍数の)
/// バイト列を返す(エラーにしない。呼び出し側がファイル全体を
/// `hardwareConcurrency`等分するときに、割り切れない端数が出ても
/// そのまま渡せるようにするため)。
#[wasm_bindgen(js_name = decompressLazRange)]
pub fn decompress_laz_range(file: File, start_index: f64, count: f64) -> Result<Vec<u8>, JsValue> {
    let stats = Stats::new();
    let source = FileRangeReader::new(file, stats);
    let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
    decompress_point_range(buffered, start_index as u64, count as u64).map_err(to_js_error)
}

/// `decompress_laz_range`の中身(wasm-bindgen/`web_sys::File`に依存しない
/// 部分)。`R`を一般化してあるのは、ネイティブの`cargo test`から
/// `Cursor<Vec<u8>>`や`std::fs::File`を渡してロジックを検証できるように
/// するため(`web_sys::File`はネイティブのテストでは作れない。
/// `range_math.rs`と同じ考え方)。
fn decompress_point_range<R>(source: R, start_index: u64, count: u64) -> Result<Vec<u8>, String>
where
    R: std::io::Read + std::io::Seek + Send + Sync + 'static,
{
    let mut reader = las::Reader::new(source).map_err(|e| e.to_string())?;

    // `StreamingLayout`はヘッダーだけから決まる値なので、`WasmConverter::new`が
    // 同じファイルに対して計算するものと一致する(モジュールドキュメント
    // 「M4-7」参照)。
    let layout = StreamingLayout::from_las_header(reader.header());
    let total_points = reader.header().number_of_points();
    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();

    if start_index >= total_points {
        return Ok(Vec::new());
    }
    reader.seek(start_index).map_err(|e| e.to_string())?;

    let remaining = total_points - start_index;
    let to_read = remaining.min(count);
    let record_width = layout.record_width();
    let mut out = Vec::with_capacity(
        usize::try_from(to_read)
            .unwrap_or(usize::MAX)
            .saturating_mul(record_width),
    );
    let mut scratch = vec![0u8; record_width];

    let mut remaining_to_read = to_read;
    while remaining_to_read > 0 {
        let batch = remaining_to_read.min(READ_BATCH_SIZE);
        let n = reader
            .fill_points(batch, &mut point_data)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break; // ヘッダーの申告点数より実データが少なかった(壊れたファイル)。
        }
        for result in point_data.points() {
            let point = result.map_err(|e| e.to_string())?;
            let record = LasPointRecord::from_las_point(&point);
            serialize_le(&record, &layout, &mut scratch).map_err(|e| e.to_string())?;
            out.extend_from_slice(&scratch);
        }
        remaining_to_read -= n;
    }

    Ok(out)
}

/// `decompress_laz_range`が1回の`fill_points`で読むバッチサイズ。
/// `WasmConverter::feed`とは別の経路(展開Worker)なので独自に持つが、
/// 値自体はデスクトップ版(`crates/pcv-convert/src/streaming.rs`の
/// `READ_BATCH_SIZE`)と揃えてある(進捗確認の頻度を同程度にするため)。
/// Web版はこのバッチをまたいだ並列展開はしない(1つの展開Worker=1スレッド
/// なので`rayon`のような1呼び出し内の並列化は無く、並列化は複数Worker
/// そのものが担う。モジュールドキュメント「M4-7」参照)ため、デスクトップ版の
/// ようにバッチサイズを大きくしてチャンクをまたがせる必要が無い。
const READ_BATCH_SIZE: u64 = 64 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 複数チャンク(LAZの既定チャンクサイズはおよそ5万点)にまたがる
    /// 合成LAZを、メモリ上の`Vec<u8>`として作る。`las::Writer`はパス越しの
    /// 拡張子で圧縮するかを決める(`Writer::from_path`)ため、ここでは
    /// 一時ファイルを経由する(`tempfile`はdev-dependencyとして既にある)。
    fn synthetic_multi_chunk_laz_bytes(point_count: u32) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.laz");

        let mut builder = las::Builder::from((1, 4));
        builder.point_format = las::point::Format::new(6).expect("format 6");
        let header = builder.into_header().expect("valid header");
        let mut writer = las::Writer::from_path(&path, header).expect("LAS writerの作成に失敗");
        for i in 0..point_count {
            let point = las::Point {
                x: f64::from(i),
                y: f64::from(i) * 2.0,
                z: f64::from(i) * 3.0,
                gps_time: Some(0.0), // point format 6はGPS時刻が必須
                ..Default::default()
            };
            writer.write_point(point).expect("点の書き込みに失敗");
        }
        writer.close().expect("LAS writerのクローズに失敗");

        std::fs::read(&path).expect("書いたLAZを読み戻せなかった")
    }

    /// `decompress_point_range`を複数の範囲に分けて呼び、結果を連結したものが、
    /// 1回で全点を読んだ結果と**バイト単位で一致する**ことを確認する
    /// (M4-7の受け入れ条件: 並列展開Workerが担当範囲を分担しても、
    /// 各範囲を順番どおりに連結すれば逐次読みと同じ結果になること)。
    /// `crates/pcv-convert/tests/parallel_laz_decompression.rs`(ネイティブの
    /// `laz-parallel`、点の集合が一致することを確認)とは別の並列化経路
    /// (Web、複数Worker)に対する、こちらは「連結結果がバイト単位で一致する」
    /// というより強い確認になっている(範囲が重ならず連結順も決まっているため)。
    #[test]
    fn concatenated_ranges_match_a_single_full_range_read() {
        const POINT_COUNT: u32 = 300_000; // 約6チャンク分
        let bytes = synthetic_multi_chunk_laz_bytes(POINT_COUNT);

        let full = decompress_point_range(Cursor::new(bytes.clone()), 0, u64::from(POINT_COUNT))
            .expect("全体の展開に失敗した");

        // 3つの範囲に分ける(チャンク境界と揃っていなくてよいことを確かめるため、
        // わざと均等でない区切りにする)。
        let boundaries = [0u64, 70_000, 180_000, u64::from(POINT_COUNT)];
        let mut concatenated = Vec::new();
        for window in boundaries.windows(2) {
            let (start, end) = (window[0], window[1]);
            let part = decompress_point_range(Cursor::new(bytes.clone()), start, end - start)
                .unwrap_or_else(|e| panic!("範囲[{start}, {end})の展開に失敗した: {e}"));
            concatenated.extend_from_slice(&part);
        }

        assert_eq!(
            full.len(),
            concatenated.len(),
            "全体読みと分割読みの合計バイト数が一致しない"
        );
        assert_eq!(
            full, concatenated,
            "全体読みと、範囲に分けて連結した結果がバイト単位で一致しない"
        );
    }

    #[test]
    fn range_starting_past_total_points_returns_empty() {
        const POINT_COUNT: u32 = 1_000;
        let bytes = synthetic_multi_chunk_laz_bytes(POINT_COUNT);

        let out = decompress_point_range(Cursor::new(bytes), 10_000, 100)
            .expect("範囲外の開始でもエラーにしない設計のはず");
        assert!(out.is_empty());
    }
}
