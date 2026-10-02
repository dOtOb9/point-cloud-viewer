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
// `decompress_laz_range`参照)を分担させることで、真の並列実行を得る。
//
// ## このWorkerの役目(単純に保つ)
//
// 1つの変換対象`File`と、自分が担当する点インデックスの範囲
// `[startIndex, startIndex + count)`を受け取り、`decompressLazRange`で
// 展開し、`copc_core::serialize_le`形式のバイト列を1回のメッセージで返す。
// 範囲の途中で進捗を細かく報告する仕組みは持たない(`decompressLazRange`の
// 1回の呼び出しは、このWorker自身にとっては唯一の仕事であり、呼び出し中は
// ブロックするが、他のWorkerや変換用Workerのメインスレッドをブロックしない)。
// キャンセルは変換用Worker側が`Worker.terminate()`で行う(このWorker自身は
// キャンセルメッセージを受け取らない。`terminate()`は実行位置に関わらず
// 即座に止まるため、これで十分)。

import init, { decompressLazRange } from "../wasm/pcv-wasm/pcv_wasm.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<DecompressRequest>) => void) | null;
  postMessage(message: DecompressResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** 変換用Worker(`copc.worker.ts`)からの唯一のリクエスト。 */
export interface DecompressRequest {
  id: number;
  file: File;
  startIndex: number;
  count: number;
}

export type DecompressResponse =
  | { type: "decompress-done"; id: number; bytes: ArrayBuffer }
  | { type: "decompress-failed"; id: number; message: string };

let wasmReady: Promise<void> | null = null;
function ensureWasmReady(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  return wasmReady;
}

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: DecompressRequest): Promise<void> {
  try {
    await ensureWasmReady();
    const bytes = decompressLazRange(request.file, request.startIndex, request.count);
    // wasm-bindgenが生成するグルーコードは`Vec<u8>`の戻り値を、wasmの
    // リニアメモリから既に`.slice()`でコピーしてある(`copc.worker.ts`の
    // `readNode`と同じ理由)ので、`bytes.buffer`は他から参照されていない
    // 専有のArrayBuffer。そのままtransferできる。
    const buffer = bytes.buffer as ArrayBuffer;
    scope.postMessage({ type: "decompress-done", id: request.id, bytes: buffer }, [buffer]);
  } catch (err) {
    scope.postMessage({
      type: "decompress-failed",
      id: request.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
