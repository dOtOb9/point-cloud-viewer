// M4-7: LAZ展開専用のWeb Worker。`copc.worker.ts`(変換用Worker)が、自分の
// 担当範囲(点インデックスの区間)を割り振って複数個スポーンする。
//
// ## なぜ専用のWorkerが要るか(SharedArrayBufferが使えない制約)
//
// デスクトップ・Android(`crates/pcv-convert/src/streaming.rs`)は`las`クレートの
// `laz-parallel`フィーチャ(`rayon`、OSスレッド)でLAZ展開を並列化した。
// Web版では`rayon`が使えない。`rayon`はOSスレッドか`wasm32`の`atomics`
// (`SharedArrayBuffer`)のどちらかを要求するが、GitHub Pagesは静的ホスティングで
// COOP/COEPヘッダーを設定できず`crossOriginIsolated`にならないため、
// `SharedArrayBuffer`は使えない(`TaskSheets/ADR-0012-web-worker-sync-io.md`参照)。
//
// 代わりに、メモリを共有しない独立したWeb Workerを複数立てて、チャンク範囲
// (実際には点インデックスの範囲。中身はLAZチャンクだが、チャンク境界を
// JSから意識する必要は無い。`crates/pcv-wasm/src/convert.rs`の
// `LazRangeDecompressor`参照)を分担させることで、真の並列実行を得る。
//
// ## M4-7追記(2026-10-07、緊急修正): バッチ単位で返す(pull型プロトコル)
//
// 以前は担当範囲**全体**を1回のメッセージで返す設計だったため、Worker1個の
// メモリ使用量が担当範囲の点数に比例してしまい、数千万点の入力でwasm32の
// 4GiB上限を超えて「変換に失敗しました: unreachable」の一因になっていた
// (`decompress-partition.ts`のドキュメント、`TaskSheets/
// M4-import-and-conversion.md`のM4-7追記参照)。
//
// 代わりに、このWorkerは**変換用Workerから要求されたときだけ**
// (`requestBatch`)、次のバッチ(最大`decompress-partition.ts`の
// `DECOMPRESS_BATCH_POINTS`点)を`LazRangeDecompressor::feed`で読んで返す
// (pull型)。次の要求が来るまでは何もしない(=展開Workerが「待たされる」
// ことで背圧がかかる。変換用Worker側の制御は`copc.worker.ts`の
// `BoundedBatchFlow`参照)。これにより、同時にメモリ上に存在するバイト数は
// 「バッチサイズ×Worker数×パイプライン段数」程度に収まり、担当範囲の
// 点数には比例しない。

import init, { LazRangeDecompressor } from "../wasm/pcv-wasm/pcv_wasm.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<DecompressRequest>) => void) | null;
  postMessage(message: DecompressResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** 変換用Worker(`copc.worker.ts`)からのリクエスト。 */
export type DecompressRequest =
  // 担当範囲を割り振る、最初の1回だけのメッセージ。
  | { type: "init"; id: number; file: File; startIndex: number; count: number }
  // 次のバッチを1つ要求する(pull型)。`init`の後、`done`が返るまで繰り返し送る。
  | { type: "requestBatch"; id: number; batchSize: number };

export type DecompressResponse =
  // `init`が成功し、次の`requestBatch`を送ってよいことを知らせる。
  | { type: "decompress-ready"; id: number }
  // `requestBatch`に応えて1バッチ分のバイト列を返す(1点以上)。
  | { type: "decompress-batch"; id: number; bytes: ArrayBuffer }
  // 担当範囲を読み終えた(これ以上`requestBatch`を送らない)。
  | { type: "decompress-done"; id: number }
  | { type: "decompress-failed"; id: number; message: string };

let wasmReady: Promise<void> | null = null;
function ensureWasmReady(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  return wasmReady;
}

/** `init`で作った展開器。このWorkerは生涯で1つの範囲しか担当しないため、
 *  リクエストidごとに複数持つ必要はない(`copc.worker.ts`は1範囲につき
 *  Workerを1つスポーンし、使い終わったら`terminate()`する設計のまま)。 */
let decompressor: LazRangeDecompressor | null = null;

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: DecompressRequest): Promise<void> {
  try {
    await ensureWasmReady();
    if (request.type === "init") {
      decompressor = new LazRangeDecompressor(request.file, request.startIndex, request.count);
      scope.postMessage({ type: "decompress-ready", id: request.id });
      return;
    }
    // requestBatch
    if (!decompressor) {
      throw new Error("requestBatchが呼ばれたが、initがまだ呼ばれていない");
    }
    const bytes = decompressor.feed(request.batchSize);
    if (bytes.length === 0) {
      scope.postMessage({ type: "decompress-done", id: request.id });
      return;
    }
    // wasm-bindgenが生成するグルーコードは`Vec<u8>`の戻り値を、wasmの
    // リニアメモリから既に`.slice()`でコピーしてある(`copc.worker.ts`の
    // `readNode`と同じ理由)ので、`bytes.buffer`は他から参照されていない
    // 専有のArrayBuffer。そのままtransferできる。
    const buffer = bytes.buffer as ArrayBuffer;
    scope.postMessage({ type: "decompress-batch", id: request.id, bytes: buffer }, [buffer]);
  } catch (err) {
    scope.postMessage({
      type: "decompress-failed",
      id: request.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
