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
import {
  buildConvertCancelRequest,
  buildConvertStartRequest,
  buildOpenFileRequest,
  buildOpenUrlRequest,
  buildReadNodeRequest,
  classifyOpenPath,
  makeFileKey,
  type WorkerRequest,
  type WorkerResponse,
} from "./web-protocol";

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
    return {
      info: toCloudInfo(response.info),
      nodes: response.nodes.map(toHierarchyNodeInfo),
    };
  }

  async readNode(key: string): Promise<ArrayBuffer> {
    const id = this.nextRequestId++;
    const response = await this.send(buildReadNodeRequest(id, key));
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
   */
  async startConversion(file: File): Promise<ConversionOutcome> {
    const fingerprint = { name: file.name, size: file.size, lastModified: file.lastModified };

    const cached = await opfs.findCachedOutput(fingerprint);
    if (cached) {
      const key = this.registerFile(cached);
      return { kind: "cached", outputPath: key };
    }

    if (!(await opfs.isOpfsAvailable())) {
      return { kind: "opfsUnavailable" };
    }

    const estimate = await opfs.estimateQuota();
    if (!opfs.hasEnoughQuota(estimate, file.size)) {
      return {
        kind: "insufficientSpace",
        requiredBytes: opfs.requiredScratchBytes(file.size),
        availableBytes: estimate.quota - estimate.usage,
      };
    }

    const id = this.nextRequestId++;
    this.activeConvertId = id;
    this.worker.postMessage(buildConvertStartRequest(id, file));
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
