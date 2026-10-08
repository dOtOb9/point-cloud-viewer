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
import type { ConversionProgressDto, ConversionStageBreakdownDto } from "./conversion-dto";

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
  /** ファイル切り替え時の不具合の修正: `open`時にWorkerが返した世代番号
   *  （`OpenResponse.generation`）をそのまま送り返す。Worker側
   *  （`copc.worker.ts`）は、これが今開いているファイルの世代と違えば
   *  `ReadNodeStaleResponse`を返し、実際の読み出しは行わない
   *  （`src/datasource/stale-node-error.ts`参照）。 */
  generation: number;
}

/**
 * M4-6b: 生LAS/LAZ→COPC変換の開始。`open`/`readNode`と違い、この1つの
 * リクエストに対して複数の応答が返る(`convert-progress`が何度も、最後に
 * `convert-done`か`convert-failed`のどちらか1回)。`WebSource`側は
 * `pending`マップ(1リクエスト1応答)とは別の経路でこれを扱う
 * (`web.ts`参照)。
 */
export interface ConvertStartRequest {
  type: "convertStart";
  id: number;
  file: File;
  maxPointsPerNode: number;
  /** M4-11(`TaskSheets/M4-import-and-conversion.md`): モバイルでは展開用
   *  Workerの数を抑える(`decompress-partition.ts`の`decompressWorkerCountFor`
   *  参照)。メインスレッド(`matchMedia`が使える)で判定した値をそのまま
   *  渡す(WorkerにはタッチUIの判定手段=`matchMedia`が無いため、Worker内で
   *  再判定できない)。 */
  isMobile: boolean;
}

/**
 * M4-9追記(`TaskSheets/M4-import-and-conversion.md`): 生PCD→COPCの変換の開始。
 * `ConvertStartRequest`(LAS/LAZ)と同じ役割だが、Worker側
 * (`copc.worker.ts`)はPCD専用の`WasmPcdConverter`(`crates/pcv-wasm/src/
 * pcd_import.rs`)を使う別の経路(`handlePcdConvertStart`)で処理する
 * (PCDの読み込みはLAZのような並列展開の仕組み(M4-7)を持たないため、
 * LAS/LAZ版の複雑さを持ち込まずに済む)。応答(`convert-progress`/
 * `convert-done`/`convert-failed`)はLAS/LAZ版と共通の型を使う。
 */
export interface PcdConvertStartRequest {
  type: "pcdConvertStart";
  id: number;
  file: File;
  maxPointsPerNode: number;
  isMobile: boolean;
}

/**
 * 進行中の変換のキャンセルを要求する。応答は無い(fire-and-forget)。
 * Workerが読み込みバッチの合間にこのメッセージを処理できたときだけ
 * 効く(`crates/pcv-wasm/src/convert.rs`のドキュメント参照。後処理段階
 * (finish)の間はこのメッセージ自体は届くが、反映は後処理が終わった後になる)。
 */
export interface ConvertCancelRequest {
  type: "convertCancel";
  id: number;
}

export type WorkerRequest =
  | OpenRequest
  | ReadNodeRequest
  | ConvertStartRequest
  | PcdConvertStartRequest
  | ConvertCancelRequest;

export interface OpenResponse {
  type: "open-result";
  id: number;
  ok: true;
  info: CloudInfoDto;
  nodes: HierarchyNodeDto[];
  /** そのopen呼び出し時点までにWorkerが読んだ合計バイト数(統計・受け入れ確認用)。 */
  bytesRead: number;
  /** ファイル切り替え時の不具合の修正: このファイルに割り当てられた世代番号
   *  （`copc.worker.ts`の`openGeneration`）。`WebSource`が覚えておき、以後の
   *  `readNode`リクエストに含めて送り返す。 */
  generation: number;
}

export interface ReadNodeResponse {
  type: "readNode-result";
  id: number;
  ok: true;
  /** `postMessage`のtransferable listに載せてコピーせず渡す。 */
  buffer: ArrayBuffer;
  bytesRead: number;
}

/**
 * ファイル切り替え時の不具合の修正: `ReadNodeRequest.generation`が、Worker側が
 * 今開いているファイルの世代と違った場合の応答。`error`（本当の失敗）とは区別し、
 * `WebSource`はこれを`StaleNodeRequestError`に変換する
 * （`src/datasource/stale-node-error.ts`参照。`NodeLoader`はこれを
 * エラーバナーに出さず黙って捨てる）。
 */
export interface ReadNodeStaleResponse {
  type: "readNode-stale";
  id: number;
}

export interface ErrorResponse {
  type: "error";
  id: number;
  ok: false;
  message: string;
}

/** M4-6b: 読み込み段階の進捗。デスクトップ版(M4-3)と同じ`ConversionProgressDto`
 *  の形をそのまま使い、見せ方を揃える(`src/state/useCopcViewer.ts`参照)。 */
export interface ConvertProgressResponse {
  type: "convert-progress";
  id: number;
  progress: ConversionProgressDto;
}

/** M4-6b: 変換完了。`outputName`はOPFS上の出力ファイル名
 *  (`opfs.ts`の`outputFileNameFor`が決めたもの)、`suggestedFileName`は
 *  ダウンロード時に提案するファイル名(元のファイル名から組み立てる。
 *  `outputName`はハッシュ由来で人が読める名前ではないため)。
 *  `stageTimings`はM4-12(`TaskSheets/M4-import-and-conversion.md`)で追加した、
 *  段階ごとの所要時間(`crates/pcv-wasm/src/dto.rs`の`FinishResultDto.
 *  stage_timings`をそのまま運ぶ。Rust側のフィールド名のままsnake_case)。 */
export interface ConvertDoneResponse {
  type: "convert-done";
  id: number;
  outputName: string;
  suggestedFileName: string;
  pointCount: number;
  stageTimings: ConversionStageBreakdownDto;
}

/** M4-6b: 変換の失敗・キャンセル。デスクトップ版のonConversionFailedと
 *  同じ形(message, cancelled)。 */
export interface ConvertFailedResponse {
  type: "convert-failed";
  id: number;
  message: string;
  cancelled: boolean;
}

export type WorkerResponse =
  | OpenResponse
  | ReadNodeResponse
  | ReadNodeStaleResponse
  | ErrorResponse
  | ConvertProgressResponse
  | ConvertDoneResponse
  | ConvertFailedResponse;

export function buildOpenFileRequest(id: number, file: File): OpenRequest {
  return { type: "open", id, source: { kind: "file", file } };
}

export function buildOpenUrlRequest(id: number, url: string): OpenRequest {
  return { type: "open", id, source: { kind: "url", url } };
}

export function buildReadNodeRequest(id: number, key: string, generation: number): ReadNodeRequest {
  return { type: "readNode", id, key, generation };
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

/** `copc-writer`の既定(`CopcWriterParams::default`)と揃える。デスクトップ版
 *  (`src-tauri/src/conversion.rs`)も同じ値を使っている。 */
export const DEFAULT_MAX_POINTS_PER_NODE = 100_000;

export function buildConvertStartRequest(
  id: number,
  file: File,
  isMobile: boolean,
  maxPointsPerNode: number = DEFAULT_MAX_POINTS_PER_NODE,
): ConvertStartRequest {
  return { type: "convertStart", id, file, maxPointsPerNode, isMobile };
}

export function buildConvertCancelRequest(id: number): ConvertCancelRequest {
  return { type: "convertCancel", id };
}

export function buildPcdConvertStartRequest(
  id: number,
  file: File,
  isMobile: boolean,
  maxPointsPerNode: number = DEFAULT_MAX_POINTS_PER_NODE,
): PcdConvertStartRequest {
  return { type: "pcdConvertStart", id, file, maxPointsPerNode, isMobile };
}
