// Web版のCOPC読込を行うWeb Worker本体。`pcv-wasm`(crates/pcv-wasm、pcv-coreの
// wasm-bindgenラッパー)をここでロードし、`WasmCopcFile`を1本だけ保持する。
//
// ## なぜWorkerでなければならないか
//
// `web_sys::FileReaderSync`と、同期モードの`XMLHttpRequest`はどちらも
// **Webワーカー専用のAPI**で、メインスレッドには存在しない(同期XHRはメイン
// スレッドでも動くが非推奨かつUIをブロックする)。`pcv-core`の`CopcFile`は
// 同期の`Read + Seek`の上で動く設計なので、この同期I/Oが使えるWorkerの中で
// 動かす必要がある(`TaskSheets/ADR-0012-web-worker-sync-io.md`参照)。
//
// ## 並列化について
//
// このWorkerは1本だけ生成される(`web.ts`の`createRealWorker`)。Tauri版は
// リーダーをプールして並列読み出ししている(ADR-0007)が、Web版はまず1本で
// 動かす方針(ADR-0012)。複数Workerでの並列化は必要になってから検討する。

import init, { WasmCopcFile } from "../wasm/pcv-wasm/pcv_wasm.js";
import type { CloudInfoDto, HierarchyNodeDto } from "./copc-dto";
import type { OpenSource, WorkerRequest, WorkerResponse } from "./web-protocol";

/**
 * `self`の型をDOM libとWebWorker libの衝突を避けつつ最小限だけ宣言する
 * (tsconfig.jsonのlibはDOM向けのままにしておきたいので、ここでは`self`の
 * 実際の使用箇所に必要な形だけをキャストで与える)。
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let wasmReady: Promise<void> | null = null;
let openFile: WasmCopcFile | null = null;

function ensureWasmReady(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  return wasmReady;
}

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    await ensureWasmReady();
    switch (request.type) {
      case "open":
        handleOpen(request.id, request.source);
        return;
      case "readNode":
        handleReadNode(request.id, request.key);
        return;
    }
  } catch (err) {
    scope.postMessage({
      type: "error",
      id: request.id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function handleOpen(id: number, source: OpenSource): void {
  openFile =
    source.kind === "file" ? WasmCopcFile.openFile(source.file) : WasmCopcFile.openUrl(source.url);

  const info = openFile.info() as CloudInfoDto;
  const nodes = openFile.hierarchy() as HierarchyNodeDto[];
  scope.postMessage({
    type: "open-result",
    id,
    ok: true,
    info,
    nodes,
    bytesRead: openFile.bytesRead(),
  });
}

function handleReadNode(id: number, key: string): void {
  if (!openFile) {
    throw new Error("readNodeが呼ばれたが、まだopenされていない");
  }
  const bytes = openFile.readNode(key);
  // wasm-bindgenが生成するグルーコードは`Vec<u8>`の戻り値をwasmのリニアメモリから
  // 既に`.slice()`でコピーしてある(pcv_wasm.jsのreadNode()参照)ので、`bytes.buffer`は
  // 他から参照されていない専有のArrayBuffer。そのままtransferできる
  // (もう1回コピーする必要はない)。node-format.tsの受け側はArrayBufferを
  // そのまま扱う設計になっている。
  const buffer = bytes.buffer as ArrayBuffer;
  scope.postMessage(
    {
      type: "readNode-result",
      id,
      ok: true,
      buffer,
      bytesRead: openFile.bytesRead(),
    },
    [buffer],
  );
}
