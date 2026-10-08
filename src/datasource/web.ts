// DataSourceのWeb版実装。COPCの読込そのものはWeb Worker(`copc.worker.ts`)の中で
// pcv-wasm(pcv-coreのwasm-bindgenラッパー)を使って行う。このファイル自身は
// Tauriのnpmパッケージは一切importしない(規約2はtauri.ts専用の制約だが、
// Web版のバンドルにTauriのAPIを引き込まないことも受け入れ条件になっている)。
// 設計の経緯は `TaskSheets/ADR-0012-web-worker-sync-io.md` を参照。
//
// ## `open(path)`の`path`の意味
//
// `DataSource.open(path: string)`のシグネチャは変えていないが、Web版には
// 「ファイルパス」という概念がない。かわりに:
// - ローカルファイル: 先に`registerFile(file)`を呼び、返ってきたキー
//   (`"file:<連番>"`)を`open()`に渡す。ファイル選択UIがこの2段階を行う。
// - URL: `open()`にhttp(s)のURLをそのまま渡す。
//
// 分類は`web-protocol.ts`の`classifyOpenPath`(純粋関数、テスト対象)が行う。

import type { DataSource, OpenedCloud } from "./DataSource";
import { toCloudInfo, toHierarchyNodeInfo } from "./copc-dto";
import { toConversionProgress, type ConversionOutcome, type ConversionProgress } from "./conversion-dto";
import * as opfs from "./opfs";
import { estimatePointCountForLasFile, estimatePointCountForPcdFile } from "./point-count-estimate";
import {
  buildConvertCancelRequest,
  buildConvertStartRequest,
  buildOpenFileRequest,
  buildOpenUrlRequest,
  buildPcdConvertStartRequest,
  buildReadNodeRequest,
  classifyOpenPath,
  makeFileKey,
  type WorkerRequest,
  type WorkerResponse,
} from "./web-protocol";
import { StaleNodeRequestError } from "./stale-node-error";

/**
 * M4-9追記(`TaskSheets/M4-import-and-conversion.md`): 容量の事前確認。
 * `pointCountEstimator`(形式ごとのヘッダー読み取り、`point-count-estimate.ts`)
 * で点数が読めればそれを根拠に見積もり、読めなければファイルサイズからの
 * フォールバックに倒す(壊れたヘッダー等でも変換を試みる機会は残す。安全側に
 * 「大きめに見積もって弾く」方向のフォールバックなので、誤って変換を
 * 始めてしまう心配は無い)。足りていれば`null`、足りなければ
 * `ConversionOutcome`の`insufficientSpaceWeb`を返す。
 *
 * M4-6追記: 見積もりの前に、まだ永続化されていなければ`persist()`を求める
 * (受け入れ条件「変換の前に永続的な保存を求める」)。ブラウザによっては
 * 永続化すると割り当てられる上限自体が変わる(`opfs.ts`の
 * `ensurePersistentStorage`のドキュメント参照)ため、`estimateQuota`は
 * この後で(やり直す形で)呼ぶ。
 */
async function checkInsufficientSpace(
  file: File,
  pointCountEstimator: (file: File) => Promise<number | null>,
): Promise<ConversionOutcome | null> {
  await opfs.ensurePersistentStorage(navigator.storage);

  const pointCount = await pointCountEstimator(file);
  const requiredBytes =
    pointCount !== null ? opfs.requiredBytesForPointCount(pointCount) : opfs.requiredScratchBytes(file.size);
  const estimate = await opfs.estimateQuota();
  if (opfs.hasEnoughQuota(estimate, requiredBytes)) return null;

  // 空き容量が足りない。所有者が「空けるにはどうすればいいか」を画面で
  // 判断できるよう、OPFSの使用量の内訳(消せるもの)と永続化の状態を
  // 併せて返す(`useCopcViewer.ts`が`opfs.describeInsufficientSpaceWeb`で
  // 文言化する。受け入れ条件「容量不足の表示が空ける方法を示す」)。
  const breakdown = await opfs.getOpfsUsageBreakdown();
  const persisted = await opfs.isPersisted();
  return {
    kind: "insufficientSpaceWeb",
    requiredBytes,
    quotaBytes: estimate.quota,
    usageBytes: estimate.usage,
    persisted,
    reclaimableBytes: breakdown.cachedConversionsTotalBytes + breakdown.staleScratchTotalBytes,
  };
}

/**
 * `Worker`から実際に使うメソッドだけを切り出した最小限のインターフェース。
 * テストでは本物の`Worker`(wasmやWorkerスレッドを必要とする)の代わりに、
 * これを満たす偽物を注入できる(`WebSource`のコンストラクタ引数参照)。
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  terminate?(): void;
}

function createRealWorker(): WorkerLike {
  // `type: "module"`でないとWorker内でESM importが使えない(pcv-wasmの生成物がESM)。
  return new Worker(new URL("./copc.worker.ts", import.meta.url), {
    type: "module",
  });
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

export class WebSource implements DataSource {
  private readonly worker: WorkerLike;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly localFiles = new Map<string, File>();
  private nextRequestId = 1;
  private nextFileSequence = 0;
  private lastBytesRead = 0;
  /** ファイル切り替え時の不具合の修正: Workerが`open-result`で返した、現在
   *  開いているファイルの世代番号。`readNode`リクエストに含めて送り返し、
   *  Worker側（`copc.worker.ts`）が切り替え後に届いた古いリクエストを
   *  見分けられるようにする。まだ`open`を呼んでいない間は0
   *  （Worker側はこの値を見る前に「まだopenされていない」を検出して
   *  エラーを投げるため実害は無い。`copc.worker.ts`参照）。 */
  private currentGeneration = 0;

  // M4-6b: 変換(生LAS/LAZ→COPC)の進捗・完了・失敗を購読するリスナー。
  // open/readNodeの「1リクエスト1応答」(`pending`マップ)とは違い、1回の
  // 変換に対して複数の応答(進捗が何度も、最後に完了かfailedが1回)が来るため、
  // 別の仕組みにしてある(`handleResponse`参照)。
  private readonly convertProgressListeners = new Set<(progress: ConversionProgress) => void>();
  private readonly convertDoneListeners = new Set<
    (outputName: string, suggestedFileName: string, pointCount: number) => void
  >();
  private readonly convertFailedListeners = new Set<(message: string, cancelled: boolean) => void>();
  /** 進行中の変換のリクエストid(無ければnull)。`cancelConversion`が
   *  どのidへキャンセルを送るかに使う。1本のWorkerでは同時に1件しか
   *  変換しない前提(ADR-0012「Web版はまずWorker1本」)。 */
  private activeConvertId: number | null = null;

  /**
   * `createWorker`はテストのために差し替えられるようにしてある
   * (通常の利用では省略し、既定の`createRealWorker`が本物のWorkerを起動する)。
   */
  constructor(createWorker: () => WorkerLike = createRealWorker) {
    this.worker = createWorker();
    this.worker.onmessage = (event) => this.handleResponse(event.data);
  }

  /**
   * ドラッグ&ドロップ/`<input type="file">`で得た`File`を登録し、
   * `open()`にそのまま渡せるキーを返す。
   */
  registerFile(file: File): string {
    const key = makeFileKey(this.nextFileSequence++);
    this.localFiles.set(key, file);
    return key;
  }

  async open(path: string): Promise<OpenedCloud> {
    const classified = classifyOpenPath(path);
    const id = this.nextRequestId++;

    let request;
    if (classified.kind === "file") {
      const file = this.localFiles.get(classified.fileKey);
      if (!file) {
        throw new Error(
          `未登録のファイルキー: ${classified.fileKey}(先にregisterFile(file)を呼ぶこと)`,
        );
      }
      request = buildOpenFileRequest(id, file);
    } else {
      request = buildOpenUrlRequest(id, classified.url);
    }

    const response = await this.send(request);
    if (response.type !== "open-result") {
      throw new Error(`open()に対して予期しない応答: ${response.type}`);
    }
    this.lastBytesRead = response.bytesRead;
    this.currentGeneration = response.generation;
    return {
      info: toCloudInfo(response.info),
      nodes: response.nodes.map(toHierarchyNodeInfo),
    };
  }

  async readNode(key: string): Promise<ArrayBuffer> {
    const id = this.nextRequestId++;
    const response = await this.send(buildReadNodeRequest(id, key, this.currentGeneration));
    if (response.type === "readNode-stale") {
      // ファイル切り替え時の不具合の修正: Worker側が「古い世代のリクエスト」と
      // 判定した。エラーではなく、呼び出し側（NodeLoader）が黙って捨てるべき
      // 結果なので、専用の型で伝える（stale-node-error.ts参照）。
      throw new StaleNodeRequestError(key);
    }
    if (response.type !== "readNode-result") {
      throw new Error(`readNode()に対して予期しない応答: ${response.type}`);
    }
    this.lastBytesRead = response.bytesRead;
    return response.buffer;
  }

  /**
   * M0時点のTauri版ベンチ(`fetchBenchViaInvoke`との比較用)はTauriの`invoke`と
   * カスタムプロトコルの転送速度差を測るためのものだった。Web版には比較対象の
   * 2経路が無い(fetchが1つあるだけ)ので、Workerを介さずダミーバッファを
   * 返すだけにしてある。
   */
  async fetchBench(sizeBytes: number): Promise<ArrayBuffer> {
    return new ArrayBuffer(sizeBytes);
  }

  /**
   * 直近のopen/readNodeまでにWorkerが実際に読んだ合計バイト数。
   * 「ファイル全体を読んでいないこと」をブラウザのdevtoolsやUIから確認する
   * 手がかりとして公開している(DataSourceインターフェースの一部ではない)。
   */
  getLastBytesRead(): number {
    return this.lastBytesRead;
  }

  /**
   * M4-6b: 生LAS/LAZ→COPCの変換を始める。呼び出し側
   * (`src/state/useCopcViewer.ts`)は、先に`copc-header.ts`の`isCopcFile`で
   * 「既にCOPCではない」ことを確かめてからこれを呼ぶ想定(デスクトップ版の
   * `startLasConversion`と同じ役割分担: 既にCOPCの場合はこの関数を経由しない)。
   *
   * デスクトップ版(`src-tauri/src/conversion.rs`)と同じ4分岐
   * (`alreadyCopc`はWeb側では呼び出し前に済んでいるため出さない)に加え、
   * Web版だけの`opfsUnavailable`(OPFSが使えないブラウザ)を返しうる。
   *
   * `isMobile`はM4-11(`TaskSheets/M4-import-and-conversion.md`)で追加した
   * 引数。呼び出し側(`src/state/useCopcViewer.ts`、`defaultRenderSettings`
   * から既に求めてある値)がメインスレッドで判定した結果をそのまま渡す
   * (Worker内では`matchMedia`が使えずタッチUIの判定ができないため)。
   */
  async startConversion(file: File, isMobile: boolean): Promise<ConversionOutcome> {
    const fingerprint = { name: file.name, size: file.size, lastModified: file.lastModified };

    const cached = await opfs.findCachedOutput(fingerprint);
    if (cached) {
      const key = this.registerFile(cached);
      return { kind: "cached", outputPath: key };
    }

    if (!(await opfs.isOpfsAvailable())) {
      return { kind: "opfsUnavailable" };
    }

    const insufficient = await checkInsufficientSpace(file, estimatePointCountForLasFile);
    if (insufficient) return insufficient;

    const id = this.nextRequestId++;
    this.activeConvertId = id;
    this.worker.postMessage(buildConvertStartRequest(id, file, isMobile));
    return { kind: "converting" };
  }

  /**
   * M4-9追記(`TaskSheets/M4-import-and-conversion.md`): 生PCD→COPCの変換を
   * 始める。`startConversion`(LAS/LAZ)とほぼ同じ役割分担だが、容量の見積もりを
   * PCDヘッダーの`POINTS`から求める点が違う(旧来のファイルサイズ×11という
   * 見積もりはLAZ(圧縮)の実測から来ており、非圧縮・f64のPCDでは大きく外れ、
   * 実機で「空き容量不足」と誤判定される不具合があった)。呼び出し側
   * (`src/state/useCopcViewer.ts`)は、`source-format.ts`の
   * `detectSourceFormatByName`でPCDと判定してからこれを呼ぶ。
   */
  async startPcdConversion(file: File, isMobile: boolean): Promise<ConversionOutcome> {
    const fingerprint = { name: file.name, size: file.size, lastModified: file.lastModified };

    const cached = await opfs.findCachedOutput(fingerprint);
    if (cached) {
      const key = this.registerFile(cached);
      return { kind: "cached", outputPath: key };
    }

    if (!(await opfs.isOpfsAvailable())) {
      return { kind: "opfsUnavailable" };
    }

    const insufficient = await checkInsufficientSpace(file, estimatePointCountForPcdFile);
    if (insufficient) return insufficient;

    const id = this.nextRequestId++;
    this.activeConvertId = id;
    this.worker.postMessage(buildPcdConvertStartRequest(id, file, isMobile));
    return { kind: "converting" };
  }

  /** 進行中の変換をキャンセルする。進行中の変換が無ければ何もしない
   *  (デスクトップ版`cancelLasConversion`は失敗するが、Web版はfire-and-forgetの
   *  メッセージなので「送る意味が無い」だけで区別する理由が無い)。 */
  cancelConversion(): void {
    if (this.activeConvertId === null) return;
    this.worker.postMessage(buildConvertCancelRequest(this.activeConvertId));
  }

  /** 読み込み段階の進捗を購読する。戻り値の関数を呼ぶと購読を解除する
   *  (`src/datasource/tauri.ts`の`onConversionProgress`と同じ形にしてある)。 */
  onConvertProgress(callback: (progress: ConversionProgress) => void): () => void {
    this.convertProgressListeners.add(callback);
    return () => this.convertProgressListeners.delete(callback);
  }

  /** 変換完了を購読する。`outputName`はOPFS内部の名前(`registerFile`済みの
   *  Fileを取得するのに使う場合は呼び出し側が`opfs.getConvertedFile`で
   *  取得すること)、`suggestedFileName`はダウンロード用の分かりやすい名前。 */
  onConvertDone(
    callback: (outputName: string, suggestedFileName: string, pointCount: number) => void,
  ): () => void {
    this.convertDoneListeners.add(callback);
    return () => this.convertDoneListeners.delete(callback);
  }

  /** 変換の失敗・キャンセルを購読する。 */
  onConvertFailed(callback: (message: string, cancelled: boolean) => void): () => void {
    this.convertFailedListeners.add(callback);
    return () => this.convertFailedListeners.delete(callback);
  }

  private send(request: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  private handleResponse(response: WorkerResponse): void {
    if (response.type === "convert-progress") {
      const progress = toConversionProgress(response.progress);
      this.convertProgressListeners.forEach((listener) => listener(progress));
      return;
    }
    if (response.type === "convert-done") {
      this.activeConvertId = null;
      this.convertDoneListeners.forEach((listener) =>
        listener(response.outputName, response.suggestedFileName, response.pointCount),
      );
      return;
    }
    if (response.type === "convert-failed") {
      this.activeConvertId = null;
      this.convertFailedListeners.forEach((listener) => listener(response.message, response.cancelled));
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      // 対応するリクエストが無い応答は無視する(万一の重複配送等への保険)。
      return;
    }
    this.pending.delete(response.id);
    if (response.type === "error") {
      pending.reject(new Error(response.message));
      return;
    }
    pending.resolve(response);
  }
}
