// WebSource(メインスレッド) <-> copc.worker.ts(Worker) 間のメッセージ定義。
//
// Workerの実体やpcv-wasm(wasm-bindgen)には一切依存しない、ただのデータ形と
// それを組み立てる純粋関数だけをここに置く。こうすることで、Workerを実際に
// 起動できないvitest環境でも「メッセージの組み立てが正しいか」をテストできる
// (TaskSheets/ADR-0012-web-worker-sync-io.md の受け入れ条件)。
//
// 実際のWorker起動・pcv-wasm呼び出しは`copc.worker.ts`、メインスレッド側の
// 送受信は`web.ts`が行う。

import type { CloudInfoDto, HierarchyNodeDto } from "./copc-dto";

/** ローカルファイルかURLか。`WebSource.open(path)`の`path`から組み立てる。 */
export type OpenSource = { kind: "file"; file: File } | { kind: "url"; url: string };

export interface OpenRequest {
  type: "open";
  id: number;
  source: OpenSource;
}

export interface ReadNodeRequest {
  type: "readNode";
  id: number;
  key: string;
}

export type WorkerRequest = OpenRequest | ReadNodeRequest;

export interface OpenResponse {
  type: "open-result";
  id: number;
  ok: true;
  info: CloudInfoDto;
  nodes: HierarchyNodeDto[];
  /** そのopen呼び出し時点までにWorkerが読んだ合計バイト数(統計・受け入れ確認用)。 */
  bytesRead: number;
}

export interface ReadNodeResponse {
  type: "readNode-result";
  id: number;
  ok: true;
  /** `postMessage`のtransferable listに載せてコピーせず渡す。 */
  buffer: ArrayBuffer;
  bytesRead: number;
}

export interface ErrorResponse {
  type: "error";
  id: number;
  ok: false;
  message: string;
}

export type WorkerResponse = OpenResponse | ReadNodeResponse | ErrorResponse;

export function buildOpenFileRequest(id: number, file: File): OpenRequest {
  return { type: "open", id, source: { kind: "file", file } };
}

export function buildOpenUrlRequest(id: number, url: string): OpenRequest {
  return { type: "open", id, source: { kind: "url", url } };
}

export function buildReadNodeRequest(id: number, key: string): ReadNodeRequest {
  return { type: "readNode", id, key };
}

/**
 * `WebSource.open(path)`の`path`を`OpenSource`の元になる種別へ分類する。
 * ローカルファイルは文字列として渡せないので、`registerFile`が返した
 * `"file:<連番>"`というキーで表す。それ以外は http(s) URLとして扱う。
 */
export function classifyOpenPath(path: string): { kind: "file"; fileKey: string } | { kind: "url"; url: string } {
  const FILE_KEY_PREFIX = "file:";
  if (path.startsWith(FILE_KEY_PREFIX)) {
    return { kind: "file", fileKey: path };
  }
  return { kind: "url", url: path };
}

export function makeFileKey(sequence: number): string {
  return `file:${sequence}`;
}
