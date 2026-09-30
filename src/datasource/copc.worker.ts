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

import init, { opfsScratchPoolSize, WasmConverter, WasmCopcFile } from "../wasm/pcv-wasm/pcv_wasm.js";
import type { CloudInfoDto, HierarchyNodeDto } from "./copc-dto";
import * as opfs from "./opfs";
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

// M4-6b: 変換のキャンセル要求。読み込みバッチの合間にこのフラグを見る
// (`handleConvertStart`参照)。後処理(finish)の間はチェックできない
// (`crates/pcv-wasm/src/convert.rs`のドキュメント参照)。1本のWorkerでは
// 同時に1件しか変換しない前提なので、進行中のリクエストidだけを覚えておけば
// 「自分宛てのキャンセルか」を判定できる。
let activeConvertId: number | null = null;
let convertCancelRequested = false;

function ensureWasmReady(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  return wasmReady;
}

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: WorkerRequest): Promise<void> {
  // convertCancelは応答を返さないfire-and-forgetで、かつ進行中の変換の
  // 読み込みループが次のバッチに進む前に処理されて初めて意味を持つ
  // (`convertCancelRequested`をここで即座に立てる。ensureWasmReady()の
  // awaitやtryの外で処理することで、他の処理を待たされずに反映される)。
  if (request.type === "convertCancel") {
    if (request.id === activeConvertId) convertCancelRequested = true;
    return;
  }
  try {
    await ensureWasmReady();
    switch (request.type) {
      case "open":
        handleOpen(request.id, request.source);
        return;
      case "readNode":
        handleReadNode(request.id, request.key);
        return;
      case "convertStart":
        await handleConvertStart(request.id, request.file, request.maxPointsPerNode);
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

// M4-6b: `WasmConverter::feed`が返すDTO(`crates/pcv-wasm/src/dto.rs`の
// `FeedResultDto`。serdeのデフォルトなのでsnake_case)。
interface FeedResultDto {
  points_read: number;
  total_points: number;
  done: boolean;
}

// `WasmConverter::finish`が返すDTO(同`FinishResultDto`)。
interface FinishResultDto {
  point_count: number;
}

/** 1回の`feed`呼び出しで読むバッチサイズ。デスクトップ版
 *  (`crates/pcv-convert/src/streaming.rs`の`READ_BATCH_SIZE`)と同じ桁にして、
 *  進捗の粒度・キャンセルの反応速度を揃える。 */
const CONVERT_BATCH_SIZE = 64 * 1024;

/** マイクロタスクではなくマクロタスクとして1回イベントループへ制御を返す。
 *  Workerの`onmessage`(postMessageの配送)はマクロタスクとして処理されるため、
 *  `Promise.resolve()`だけの`await`(マイクロタスク)では、送信済みの
 *  `convertCancel`メッセージがまだ処理されないことがある
 *  (`crates/pcv-wasm/src/convert.rs`のドキュメント参照)。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 元のファイル名から、ダウンロード時に提案する分かりやすい名前を作る。 */
function suggestedFileNameFor(sourceFileName: string): string {
  const withoutExtension = sourceFileName.replace(/\.(laz|las)$/i, "");
  return `${withoutExtension}.copc.laz`;
}

async function handleConvertStart(id: number, file: File, maxPointsPerNode: number): Promise<void> {
  activeConvertId = id;
  convertCancelRequested = false;

  const fingerprint = { name: file.name, size: file.size, lastModified: file.lastModified };
  const outputName = opfs.outputFileNameFor(fingerprint);
  const startedAt = performance.now();
  const elapsedSecs = () => (performance.now() - startedAt) / 1000;

  let scratchHandles: FileSystemSyncAccessHandle[] = [];
  let outputHandle: FileSystemSyncAccessHandle | null = null;
  let converter: WasmConverter | null = null;
  let succeeded = false;

  try {
    const poolSize = opfsScratchPoolSize();
    scratchHandles = await opfs.createScratchPool(poolSize);
    outputHandle = await opfs.createOutputHandle(outputName);

    converter = new WasmConverter(file, scratchHandles, outputHandle, outputName, maxPointsPerNode);

    // 読み込み段階: バッチごとにWorkerのイベントループへ制御を返し、その隙間で
    // convertCancelを受け取れるようにする(モジュール冒頭のコメント参照)。
    for (;;) {
      if (convertCancelRequested) {
        scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
        return;
      }
      const result = converter.feed(CONVERT_BATCH_SIZE) as FeedResultDto;
      scope.postMessage({
        type: "convert-progress",
        id,
        progress: {
          phase: "reading",
          points_read: result.points_read,
          total_points: result.total_points,
          elapsed_secs: elapsedSecs(),
        },
      });
      if (result.done) break;
      await yieldToEventLoop();
    }

    if (convertCancelRequested) {
      scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
      return;
    }

    // 後処理段階(octree構築・チャンク圧縮・書き出し): copc-writer本体の
    // 1回の同期呼び出しで、この間はconvertCancelを反映できない
    // (`crates/pcv-wasm/src/convert.rs`のドキュメント参照)。
    scope.postMessage({
      type: "convert-progress",
      id,
      progress: { phase: "post_processing", elapsed_secs: elapsedSecs() },
    });
    // `finish()`は呼ばれた時点(成功・例外どちらでも)でRust側のオブジェクトを
    // 消費・解放する(wasm-bindgenの生成コードが`finish()`本体の実行前に
    // ポインタを0にする。`src/wasm/pcv-wasm/pcv_wasm.js`の`finish()`参照)。
    // そのため呼び出しの成否によらず、直後に`converter`をnullへ倒して
    // 下のfinallyブロックの`converter?.free()`が二重解放しないようにする。
    let finishResult: FinishResultDto;
    try {
      finishResult = converter.finish() as FinishResultDto;
    } finally {
      converter = null;
    }

    if (convertCancelRequested) {
      // 後処理中に来たキャンセルは、終わった後に無かったことにする
      // (途中で止められないため。モジュールドキュメント参照)。
      scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
      return;
    }

    await opfs.writeCacheMeta(fingerprint, outputName);
    succeeded = true;
    scope.postMessage({
      type: "convert-done",
      id,
      outputName,
      suggestedFileName: suggestedFileNameFor(file.name),
      pointCount: finishResult.point_count,
    });
  } catch (err) {
    scope.postMessage({
      type: "convert-failed",
      id,
      message: err instanceof Error ? err.message : String(err),
      cancelled: false,
    });
  } finally {
    // 受け入れ条件: 成功・失敗・キャンセルのいずれでも一時ファイルを必ず消す。
    converter?.free();
    opfs.closeHandles(scratchHandles);
    if (outputHandle) opfs.closeHandles([outputHandle]);
    await opfs.removeScratchDir();
    if (!succeeded) {
      await opfs.removeOutputFile(outputName);
    }
    if (activeConvertId === id) activeConvertId = null;
  }
}
