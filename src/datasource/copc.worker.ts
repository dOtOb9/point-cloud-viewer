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
// ## 並列化について(COPCの読込)
//
// このWorkerは1本だけ生成される(`web.ts`の`createRealWorker`)。Tauri版は
// リーダーをプールして並列読み出ししている(ADR-0007)が、Web版はまず1本で
// 動かす方針(ADR-0012)。複数Workerでの並列化は必要になってから検討する。
// ※これはCOPCを**開く**(ノード読出し)側の話。**変換**(LAS/LAZ→COPC)の
// LAZ展開は下記M4-7で複数Workerに分担させるようにした(開く側とは別の経路)。
//
// ## M4-7: 変換のLAZ展開を複数Workerへ分担させる
//
// `crates/pcv-wasm/src/convert.rs`のモジュールドキュメント参照。この
// Worker(変換用)は、自分の`WasmConverter`(spillへの書き込みを1本で担う)は
// そのまま持ちつつ、読み込み段階だけを`laz-decompress.worker.ts`の
// インスタンス複数個に分担させる(`decompressWorkerCountFor`が1を返す
// 小さい入力・低コア環境では、今までどおり`WasmConverter.feed`の
// 逐次バッチループにフォールバックする)。

import init, {
  init_panic_hook as initPanicHook,
  opfsScratchPoolSize,
  WasmConverter,
  WasmCopcFile,
} from "../wasm/pcv-wasm/pcv_wasm.js";
import type { CloudInfoDto, HierarchyNodeDto } from "./copc-dto";
import { decompressWorkerCountFor, pointRangesFor } from "./decompress-partition";
import type { DecompressRequest, DecompressResponse } from "./laz-decompress.worker";
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

// ファイル切り替え時の不具合の修正（TaskSheets/M4-import-and-conversion.md参照）。
//
// このWorkerはメインスレッドからのメッセージをFIFOで順番に処理する。「open」で
// `openFile`を差し替えた後は、それより前に受け取った「readNode」(旧ファイル宛て)
// は既に処理済みのはずに思えるが、実際には「open」を待っている間
// （`WebSource.open()`のPromiseがまだ解決していない間）も、レンダラのrAFループは
// 止まらず、旧hierarchyに基づいて`NodeLoader`が新しい「readNode」をこのWorkerへ
// 送り続けている。これらは「open」より後に送信されるため、Workerに届く頃には
// 既に`openFile`が新しいファイルに差し替わっており、旧ファイルのキーを新しい
// ファイルのhierarchyに対して検索することになる（キーが存在しなければエラー、
// 運悪く存在すれば新しいファイルのバイト列が旧キーの結果として返ってしまう）。
//
// `openGeneration`は「open」のたびに進む通し番号。`WebSource`は`open-result`で
// 受け取った値を覚えておき、以後の「readNode」に含めて送り返す
// （`ReadNodeRequest.generation`）。ここで一致を確認し、違えば実際の読み出しを
// 行わずに`ReadNodeStaleResponse`を返す。
let openGeneration = 0;

// M4-6b: 変換のキャンセル要求。読み込みバッチの合間にこのフラグを見る
// (`handleConvertStart`参照)。後処理(finish)の間はチェックできない
// (`crates/pcv-wasm/src/convert.rs`のドキュメント参照)。1本のWorkerでは
// 同時に1件しか変換しない前提なので、進行中のリクエストidだけを覚えておけば
// 「自分宛てのキャンセルか」を判定できる。
let activeConvertId: number | null = null;
let convertCancelRequested = false;

// M4-7: 進行中の展開Workerとその`reject`(キャンセルされたときに、
// 待っているPromiseをすぐ解決させるために呼ぶ)。`convertCancel`の
// ハンドラから直接参照して即座に`terminate()`するため、
// `runParallelReadPhase`の外(モジュールスコープ)に置く。
let activeDecompressWorkers: Array<{ worker: Worker; reject: (err: Error) => void }> = [];

/** キャンセルされたことを表す、`runParallelReadPhase`専用のエラー。 */
class ParallelReadCancelledError extends Error {}

function ensureWasmReady(): Promise<void> {
  // M4-6: `init_panic_hook`は`crates/pcv-wasm/src/lib.rs`で`#[wasm_bindgen(start)]`
  // 付きで定義されているため、`init()`が解決した時点でwasm-bindgenの生成コード
  // (`__wbindgen_start`)が自動的に1回呼んでいる(`src/wasm/pcv-wasm/pcv_wasm.js`の
  // `__wbg_finalize_init`参照)。ここで明示的にもう一度呼ぶのは、「変換用の
  // Workerでpanicフックが有効になっている」ことをこのファイルを読むだけで
  // 確認できるようにするため(`#[wasm_bindgen(start)]`の自動呼び出しは、
  // この.tsファイルを読んだだけでは分からない)。`set_hook`を複数回呼んでも
  // 副作用はない(最後に設定したものに置き換わるだけ)ので安全。
  wasmReady ??= init().then(() => {
    initPanicHook();
  });
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
    if (request.id === activeConvertId) {
      convertCancelRequested = true;
      // M4-7: 並列読み込み中なら、展開Workerを今すぐ止める。`terminate()`は
      // 実行位置に関わらず即座に止まるが、`Promise.all`で待っている側は
      // `terminate()`されたWorkerからの応答を永遠に受け取れないため、
      // 対応する`reject`も合わせて呼び、待ちを即座に解消する
      // (`runParallelReadPhase`参照)。
      for (const { worker, reject } of activeDecompressWorkers) {
        worker.terminate();
        reject(new ParallelReadCancelledError("キャンセルされました"));
      }
      activeDecompressWorkers = [];
    }
    return;
  }
  try {
    await ensureWasmReady();
    switch (request.type) {
      case "open":
        handleOpen(request.id, request.source);
        return;
      case "readNode":
        handleReadNode(request.id, request.key, request.generation);
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
  // 呼ぶたびに1つ進む通し番号。同じファイルを開き直した場合も新しい世代になる
  // （「古い世代を無効化する」という目的に対しては同じファイルかどうかを
  // 気にする必要が無いため、単純な方が良い。Tauri側`src-tauri/src/copc_state.rs`の
  // `OpenedFile`と同じ考え方）。
  openGeneration += 1;

  const info = openFile.info() as CloudInfoDto;
  const nodes = openFile.hierarchy() as HierarchyNodeDto[];
  scope.postMessage({
    type: "open-result",
    id,
    ok: true,
    info,
    nodes,
    bytesRead: openFile.bytesRead(),
    generation: openGeneration,
  });
}

function handleReadNode(id: number, key: string, generation: number): void {
  if (!openFile) {
    throw new Error("readNodeが呼ばれたが、まだopenされていない");
  }
  if (generation !== openGeneration) {
    // ファイル切り替え時の不具合の修正: 切り替え前に送られた、古い世代の
    // リクエスト。実際の読み出しは行わず、専用の応答で知らせる
    // （モジュール冒頭の`openGeneration`のコメント参照）。
    scope.postMessage({ type: "readNode-stale", id });
    return;
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

/** `laz-decompress.worker.ts`のインスタンスを1つ立てる。 */
function spawnDecompressWorker(): Worker {
  return new Worker(new URL("./laz-decompress.worker.ts", import.meta.url), { type: "module" });
}

/**
 * M4-7: 読み込み段階を`workerCount`個の展開Workerに分担させる。
 * `pointRangesFor`で点インデックスを均等に分け、各Workerへ`File`
 * (構造化クローン。`File`は不変なスナップショットなので複数Workerで
 * 同時に読んでも競合しない)と担当範囲を渡す。
 *
 * 進捗はWorker単位の粗い粒度になる(1つのWorkerが担当範囲を丸ごと展開
 * し終えるたびに更新)。デスクトップ版(`feed`を4096点ごとに刻む)より
 * 粒度は粗いが、キャンセルの即時性は`Worker.terminate()`により損なわれ
 * ない(`handleRequest`の`convertCancel`ハンドラ参照)。
 *
 * 展開し終えたバイト列は、担当範囲の順(`entries`の並び、=点インデックスの
 * 昇順)に`converter`へpushする(到着順ではない)。全Workerは`postMessage`
 * 直後に並行して動き始めるため、これは並列度を落とさない
 * (後続の範囲が先に終わっていても、そのWorker自身は待たされず計算を
 * 続けられる。単に「結果を取り出す順序」を決めているだけ)。順序を
 * 決め打ちにしたのは、spillへ書く点の並びを実行のたびに変えないため
 * (`crates/pcv-wasm/src/convert.rs`のモジュールドキュメント「M4-7」の
 * とおり、そもそも順序が変わってもoctree構築の結果には影響しないので
 * 必須ではないが、デバッグ時の再現性のために揃えた)。
 */
async function runParallelReadPhase(
  converter: WasmConverter,
  file: File,
  totalPoints: number,
  workerCount: number,
  onProgress: (pointsRead: number) => void,
): Promise<"done" | "cancelled"> {
  const ranges = pointRangesFor(totalPoints, workerCount);
  const entries = ranges.map((range, index) => {
    const worker = spawnDecompressWorker();
    const promise = new Promise<ArrayBuffer>((resolve, reject) => {
      activeDecompressWorkers.push({ worker, reject });
      worker.onmessage = (event: MessageEvent<DecompressResponse>) => {
        const response = event.data;
        if (response.type === "decompress-done") {
          resolve(response.bytes);
        } else {
          reject(new Error(response.message));
        }
      };
      worker.onerror = (event) => {
        reject(new Error(event.message || "展開Workerでエラーが発生しました"));
      };
      const request: DecompressRequest = {
        id: index,
        file,
        startIndex: range.startIndex,
        count: range.count,
      };
      worker.postMessage(request);
    });
    return { worker, range, promise };
  });

  let pointsCompleted = 0;
  try {
    for (const entry of entries) {
      const bytes = await entry.promise;
      pointsCompleted += entry.range.count;
      onProgress(pointsCompleted);
      if (bytes.byteLength > 0) {
        converter.pushSerializedRecords(new Uint8Array(bytes));
      }
      // 大きいバイト列をpushし終えるたびに、キャンセル要求を反映できる
      // 機会を与える(読み込み段階のキャンセルという既存の性質を保つ)。
      await yieldToEventLoop();
      if (convertCancelRequested) return "cancelled";
    }
    return "done";
  } catch (err) {
    if (err instanceof ParallelReadCancelledError) return "cancelled";
    throw err;
  } finally {
    for (const entry of entries) entry.worker.terminate();
    activeDecompressWorkers = [];
  }
}

/** 元のファイル名から、ダウンロード時に提案する分かりやすい名前を作る。 */
function suggestedFileNameFor(sourceFileName: string): string {
  const withoutExtension = sourceFileName.replace(/\.(laz|las)$/i, "");
  return `${withoutExtension}.copc.laz`;
}

/**
 * 変換を1つに限る。Web Locks(`opfs.withConversionLock`)が取れなければ、
 * 実際の変換(`runConversion`)は一切始めず「別のタブで変換中です」と知らせる
 * (実機不具合の修正: 複数タブが同時にOPFSの一時ファイルを掴み合うと
 * `createSyncAccessHandle`が「Access Handles cannot be created if there is
 * another open Access Handle...」で失敗していた)。
 */
async function handleConvertStart(id: number, file: File, maxPointsPerNode: number): Promise<void> {
  const outcome = await opfs.withConversionLock(navigator.locks, () =>
    runConversion(id, file, maxPointsPerNode),
  );
  if (outcome.kind === "busy") {
    scope.postMessage({
      type: "convert-failed",
      id,
      message: "別のタブ(またはウィンドウ)で変換が進行中です。そちらが終わるまでお待ちください。",
      cancelled: false,
    });
  }
}

async function runConversion(id: number, file: File, maxPointsPerNode: number): Promise<void> {
  activeConvertId = id;
  convertCancelRequested = false;

  const fingerprint = { name: file.name, size: file.size, lastModified: file.lastModified };
  const outputName = opfs.outputFileNameFor(fingerprint);
  const startedAt = performance.now();
  const elapsedSecs = () => (performance.now() - startedAt) / 1000;

  let scratchDirName: string | null = null;
  let scratchHandles: FileSystemSyncAccessHandle[] = [];
  let outputHandle: FileSystemSyncAccessHandle | null = null;
  let converter: WasmConverter | null = null;
  let succeeded = false;

  try {
    // 前回までの後始末が走らなかった残骸(タブを閉じた・クラッシュした等)を
    // 掃除してから始める。ロックの中で呼ぶため、他のタブが同時に新しい
    // ディレクトリを作り始めている途中を誤って消す心配がない
    // (`opfs.cleanupStaleScratchDirs`のドキュメント参照)。掃除自体が
    // 失敗しても変換は試みる。
    try {
      await opfs.cleanupStaleScratchDirs();
    } catch {
      // 失敗しても変換自体は試みる。
    }

    const poolSize = opfsScratchPoolSize();
    const pool = await opfs.createScratchPool(poolSize);
    scratchDirName = pool.dirName;
    scratchHandles = pool.handles;
    outputHandle = await opfs.createOutputHandle(outputName);

    converter = new WasmConverter(file, scratchHandles, outputHandle, outputName, maxPointsPerNode);

    // 読み込み段階: 入力が大きく、コアが複数あれば展開Workerに分担させる
    // (M4-7)。それ以外は今までどおり`feed`の逐次バッチループ
    // (小さい入力・単一コア環境ではWorker起動のオーバーヘッドの方が
    // 大きいため。`decompressWorkerCountFor`のドキュメント参照)。
    const totalPoints = converter.totalPoints();
    const workerCount = decompressWorkerCountFor(totalPoints, {
      hardwareConcurrency:
        typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
    });
    const reportReadingProgress = (pointsRead: number) => {
      scope.postMessage({
        type: "convert-progress",
        id,
        progress: { phase: "reading", points_read: pointsRead, total_points: totalPoints, elapsed_secs: elapsedSecs() },
      });
    };

    if (workerCount > 1) {
      const outcome = await runParallelReadPhase(converter, file, totalPoints, workerCount, reportReadingProgress);
      if (outcome === "cancelled") {
        scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
        return;
      }
    } else {
      // バッチごとにWorkerのイベントループへ制御を返し、その隙間で
      // convertCancelを受け取れるようにする(モジュール冒頭のコメント参照)。
      for (;;) {
        if (convertCancelRequested) {
          scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
          return;
        }
        const result = converter.feed(CONVERT_BATCH_SIZE) as FeedResultDto;
        reportReadingProgress(result.points_read);
        if (result.done) break;
        await yieldToEventLoop();
      }
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
    if (scratchDirName) await opfs.removeScratchDir(scratchDirName);
    if (!succeeded) {
      await opfs.removeOutputFile(outputName);
    }
    if (activeConvertId === id) activeConvertId = null;
  }
}
