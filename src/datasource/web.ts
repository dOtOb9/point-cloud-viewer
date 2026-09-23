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
import {
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

  private send(request: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  private handleResponse(response: WorkerResponse): void {
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
