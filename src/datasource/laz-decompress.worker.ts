import init, { LazRangeDecompressor } from "../wasm/pcv-wasm/pcv_wasm.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<DecompressRequest>) => void) | null;
  postMessage(message: DecompressResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

export type DecompressRequest =
  | { type: "init"; id: number; file: File; startIndex: number; count: number }
  | { type: "requestBatch"; id: number; batchSize: number };

export type DecompressResponse =
  | { type: "decompress-ready"; id: number }
  | { type: "decompress-batch"; id: number; bytes: ArrayBuffer }
  | { type: "decompress-done"; id: number }
  | { type: "decompress-failed"; id: number; message: string };

let wasmReady: Promise<void> | null = null;
function ensureWasmReady(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  return wasmReady;
}

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
    if (!decompressor) {
      throw new Error("requestBatchが呼ばれたが、initがまだ呼ばれていない");
    }
    const bytes = decompressor.feed(request.batchSize);
    if (bytes.length === 0) {
      scope.postMessage({ type: "decompress-done", id: request.id });
      return;
    }
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
