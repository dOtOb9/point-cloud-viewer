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

import type { DataSource, OpenedCloud, PrepareOptions, PrepareOutcome } from "./DataSource";
import { isCopcFile } from "./copc-header";
import { extensionOfFileName } from "./file-name";
import { toConversionFailureOutcome, toPrepareOutcome } from "./prepare-outcome";
import { detectSourceFormatByName, multiSourceFormatLabel, needsPointMerge } from "./source-format";
import { toCloudInfo, toHierarchyNodeInfo } from "./copc-dto";
import {
  toConversionProgress,
  toConversionStageBreakdown,
  type ConversionOutcome,
  type ConversionProgress,
  type ConversionStageBreakdown,
} from "./conversion-dto";
import * as opfs from "./opfs";
import {
  estimatePointCountForE57File,
  estimatePointCountForLasFile,
  estimatePointCountForPcdFile,
  estimatePointCountForPlyFile,
} from "./point-count-estimate";
import {
  buildCloseRequest,
  buildConvertCancelRequest,
  buildConvertMultiStartRequest,
  buildConvertStartRequest,
  buildExtractStartRequest,
  buildRasterPreviewCloseRequest,
  buildRasterPreviewOpenRequest,
  buildRasterPreviewRenderRequest,
  buildRasterStartRequest,
  buildToolMergeStartRequest,
  buildOpenFileRequest,
  buildOpenUrlRequest,
  buildPointFileConvertStartRequest,
  buildReadNodeRequest,
  buildSectionLineStartRequest,
  buildSectionProfileRequest,
  classifyOpenPath,
  makeFileKey,
  type PointFileFormat,
  type RasterDoneResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./web-protocol";
import { StaleNodeRequestError } from "./stale-node-error";
import type { ExtractFilter, ToolOptions, ToolProgress, ToolResult } from "./tools";
import {
  decodePreviewImage,
  type RasterExportRequest,
  type RasterExportResult,
  type RasterPreviewImage,
  type RasterPreviewSession,
  type RasterRequest,
} from "./raster";
import { decodeSectionProfile, type SectionLineInput, type SectionPoints } from "./section-profile";
import { decodeSectionLine, type SectionGroundLine, type SectionLineRequest } from "./section-line";

type InsufficientSpaceWeb = Extract<ConversionOutcome, { kind: "insufficientSpaceWeb" }>;

/** What the Worker's `tool-done` carries (`ToolDoneResponse` in web-protocol.ts, without the type and id). */
interface ToolDone {
  outputName: string;
  pointCount: number;
  warnings: string[];
}

/** How the free-space check gets the point count of each raw point-file format (from its header). */
const POINT_COUNT_ESTIMATORS: Record<PointFileFormat, (file: File) => Promise<number | null>> = {
  lasLaz: estimatePointCountForLasFile,
  pcd: estimatePointCountForPcdFile,
  ply: estimatePointCountForPlyFile,
  e57: estimatePointCountForE57File,
};

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
): Promise<InsufficientSpaceWeb | null> {
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
 * M4-14: 複数ファイル版の`checkInsufficientSpace`。各ファイルの点数が
 * わかれば合計して見積もり、1つでも読めなければ(壊れたヘッダー等)安全側に
 * 倒してファイルサイズの合計から見積もる(単一ファイル版と同じ考え方。
 * 一部だけ点数で・残りをファイルサイズで見積もると係数の意味が食い違うため、
 * 「全部わかるか、全部わからないか」の二択にしている)。
 *
 * M4-17: `pointCountEstimator` is given per file because a mixed selection has files of several formats
 * (LAS merge: always the LAS estimator; point merge: the estimator of each file's own format).
 */
async function checkInsufficientSpaceMulti(
  files: File[],
  pointCountEstimator: (file: File) => Promise<number | null>,
): Promise<InsufficientSpaceWeb | null> {
  await opfs.ensurePersistentStorage(navigator.storage);

  const pointCounts = await Promise.all(files.map(pointCountEstimator));
  const allKnown = pointCounts.every((c): c is number => c !== null);
  const requiredBytes = allKnown
    ? opfs.requiredBytesForPointCount(pointCounts.reduce((sum, c) => sum + c, 0))
    : opfs.requiredScratchBytes(files.reduce((sum, f) => sum + f.size, 0));
  const estimate = await opfs.estimateQuota();
  if (opfs.hasEnoughQuota(estimate, requiredBytes)) return null;

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

type ProgressCallback = (progress: ConversionProgress) => void;

/** How a conversion ended, as the Worker says it (`convert-done` / `convert-failed`). */
type ConvertEnd =
  | {
      kind: "done";
      outputName: string;
      suggestedFileName: string;
      pointCount: number;
      stageTimings: ConversionStageBreakdown;
      warnings: string[];
    }
  | { kind: "failed"; message: string; cancelled: boolean };

/** What a `start*` method returns: a ready/failed outcome at once, or a running conversion with its end promise. */
type ConversionStarted = { kind: "converting"; end: Promise<ConvertEnd> };
type WebStart = Exclude<ConversionOutcome, { kind: "converting" }> | ConversionStarted;

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

  // M4-6b: waiters of running conversions, by request id. Unlike open/readNode (one request, one answer, the
  // `pending` map), one conversion gets several answers: `convert-progress` many times, then `convert-done` or
  // `convert-failed` once (see `handleResponse`).
  private readonly convertPending = new Map<
    number,
    { resolve: (end: ConvertEnd) => void; onProgress: ProgressCallback }
  >();
  /** Request id of the running conversion or tool (null if none). `cancelConversion` sends the cancel to it.
   *  One Worker runs one job at a time (ADR-0012: "one Worker first"). */
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

  /**
   * `DataSource.prepareToOpen` for the Web. One `File`: a COPC opens as it is, anything else goes to the
   * conversion route of its format. Several `File`s: the merge route. When a conversion starts, this waits for
   * the Worker's `convert-done` / `convert-failed`, reads the output back from OPFS and registers it.
   * `tempDir` is not used (OPFS has no temp directory setting).
   */
  async prepareToOpen(items: string[] | File[], options: PrepareOptions): Promise<PrepareOutcome> {
    const files: File[] = [];
    for (const item of items) {
      if (typeof item === "string") throw new Error("Web版ではFileだけを開けます");
      files.push(item);
    }
    const first = files[0];
    if (!first) throw new Error("開くファイルがありません");
    const isMulti = files.length > 1;
    const onProgress: ProgressCallback = (progress) => options.onProgress?.(progress);

    // M4-6b: decide by the header, not the extension (`copc-header.ts`, same idea as Rust
    // `copc_detect.rs`). A COPC opens as it is; raw LAS/LAZ is converted in OPFS on the Web too.
    if (!isMulti && (await isCopcFile(first))) {
      return { kind: "ready", path: this.registerFile(first), conversion: null };
    }
    // M4-9: decide the format first, then the conversion route. (A real-device bug: every non-COPC
    // file used to go to the LAS/LAZ route, so PCD was wrongly judged "not enough space".)
    // PCD, PLY and E57 share one route (R7); everything else goes to the LAS/LAZ route.
    // M4-17: several files take the LAS merge when all are LAS/LAZ (it keeps every attribute), and the point
    // merge when at least one is PLY/PCD/E57 (`needsPointMerge`).
    const format = detectSourceFormatByName(first.name);
    const names = files.map((f) => f.name);
    const usesPointFileRoute = isMulti
      ? needsPointMerge(names)
      : format === "pcd" || format === "ply" || format === "e57";
    const started = usesPointFileRoute
      ? await this.startPointFileConversion(files, options.isMobile, onProgress)
      : isMulti
        ? await this.startMultiConversion(files, options.isMobile, onProgress)
        : await this.startConversion(first, options.isMobile, onProgress);
    if (started.kind !== "converting") return toPrepareOutcome(started, isMulti);

    options.onConverting?.();
    const end = await started.end;
    if (end.kind === "failed") return toConversionFailureOutcome(end.message, end.cancelled);

    // Read the OPFS output back as a `File` and open it through the same route as a local file
    // (`registerFile` -> `open`). The download URL is made here too (OPFS content cannot be fetched from outside
    // the app); the caller revokes it if the layer cannot be opened.
    const file = await opfs.getConvertedFile(end.outputName);
    if (!file) {
      const text = "変換結果をOPFSから読み出せませんでした";
      return { kind: "failed", summary: text, details: text };
    }
    return {
      kind: "ready",
      path: this.registerFile(file),
      conversion: {
        outputName: end.suggestedFileName,
        platform: "web",
        // M4-14: several files have no single extension, so use the same wording as the desktop build.
        sourceFormat: end.stageTimings.inputFileCount > 1 ? multiSourceFormatLabel(names) : extensionOfFileName(first.name),
        stageTimings: end.stageTimings,
        warnings: end.warnings,
        download: { url: URL.createObjectURL(file), fileName: end.suggestedFileName },
      },
    };
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
      // Workerが割り当てた世代番号がそのままcloudId。readNode/closeに渡す。
      cloudId: response.generation,
      info: toCloudInfo(response.info),
      nodes: response.nodes.map(toHierarchyNodeInfo),
    };
  }

  async readNode(cloudId: number, key: string): Promise<ArrayBuffer> {
    const id = this.nextRequestId++;
    const response = await this.send(buildReadNodeRequest(id, key, cloudId));
    if (response.type === "readNode-stale") {
      // Worker側が「閉じた／知らないcloudId」と判定した。エラーではなく、呼び出し側（NodeLoader）が黙って捨てるべき
      // 結果なので、専用の型で伝える（stale-node-error.ts参照）。
      throw new StaleNodeRequestError(key);
    }
    if (response.type !== "readNode-result") {
      throw new Error(`readNode()に対して予期しない応答: ${response.type}`);
    }
    this.lastBytesRead = response.bytesRead;
    return response.buffer;
  }

  // --- G2: cross-section view ---
  /** Reads the points of an open cross-section layer (`cloudId` from `open()`) as `(s, z)` points, at most `cap` (0 = default). */
  async readSectionProfile(cloudId: number, line: SectionLineInput, cap: number): Promise<SectionPoints> {
    const response = await this.send(buildSectionProfileRequest(this.nextRequestId++, cloudId, line, cap));
    if (response.type !== "section-profile-result") {
      throw new Error(`readSectionProfile()に対して予期しない応答: ${response.type}`);
    }
    return decodeSectionProfile(response.buffer);
  }

  // --- G2: section line ---
  /** Waiters per section-line request id (own responses, see `web-protocol.ts`). */
  private readonly sectionLinePending = new Map<
    number,
    {
      resolve: (buffer: ArrayBuffer) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ToolProgress) => void;
    }
  >();

  /**
   * Computes the ground line of a cross section from the SOURCE layer (`cloudId`). Progress is reported as per mille
   * (`totalPoints` is 1000); `cancelConversion()` stops it (the error text is "キャンセルされました").
   */
  async computeSectionLine(
    cloudId: number,
    line: SectionLineInput,
    request: SectionLineRequest,
    options?: ToolOptions,
  ): Promise<SectionGroundLine> {
    const id = this.nextRequestId++;
    this.activeConvertId = id;
    try {
      const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        this.sectionLinePending.set(id, { resolve, reject, onProgress: options?.onProgress });
        this.worker.postMessage(buildSectionLineStartRequest(id, cloudId, line, request));
      });
      return decodeSectionLine(buffer);
    } finally {
      if (this.activeConvertId === id) this.activeConvertId = null;
    }
  }

  async close(cloudId: number): Promise<void> {
    const response = await this.send(buildCloseRequest(this.nextRequestId++, cloudId));
    if (response.type !== "close-result") {
      throw new Error(`close()に対して予期しない応答: ${response.type}`);
    }
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
   * M4-6b: start converting a raw LAS/LAZ to COPC. `prepareToOpen` calls this only after `isCopcFile`
   * (`copc-header.ts`) said the file is not a COPC yet (same division of work as the desktop
   * `start_las_conversion`).
   *
   * Returns the same branches as the desktop build (`src-tauri/src/conversion.rs`; `alreadyCopc` is decided
   * before this call), plus `opfsUnavailable` (a browser without OPFS), which only the Web build has.
   * `converting` carries `end`, the promise of the Worker's final answer.
   *
   * `isMobile` (M4-11) is decided on the main thread and passed in, because `matchMedia` is not available in
   * the Worker.
   */
  async startConversion(file: File, isMobile: boolean, onProgress: ProgressCallback): Promise<WebStart> {
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
    return this.beginConversion(id, buildConvertStartRequest(id, file, isMobile), onProgress);
  }

  /**
   * M4-9 / R7 / M4-17: start converting raw PCD, PLY or E57 files to COPC. One file is the single-file
   * conversion; several files (at least one of them PLY/PCD/E57, any LAS/LAZ mixed in) are merged into one
   * COPC by the point merge. Same division of work as `startConversion` (LAS/LAZ), but the free-space check
   * uses the point count from each file header (PCD `POINTS`, PLY `element vertex`, E57 `recordCount` in the
   * XML, LAS header) instead of the file size times 11, which comes from compressed LAZ and is far off for
   * uncompressed formats (a real-device bug). The formats come from `detectSourceFormatByName`.
   */
  async startPointFileConversion(files: File[], isMobile: boolean, onProgress: ProgressCallback): Promise<WebStart> {
    const isMulti = files.length > 1;
    const fingerprints = files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified }));

    const cached = isMulti
      ? await opfs.findCachedMultiOutput(fingerprints)
      : await opfs.findCachedOutput(fingerprints[0]);
    if (cached) {
      const key = this.registerFile(cached);
      return { kind: "cached", outputPath: key };
    }

    if (!(await opfs.isOpfsAvailable())) {
      return { kind: "opfsUnavailable" };
    }

    // Files are read in name order, so the output does not depend on the selection order (the same rule
    // as the desktop build and the cache key, `cacheKeyForMulti`).
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const formats: PointFileFormat[] = [];
    const formatOf = new Map<File, PointFileFormat>();
    for (const file of sorted) {
      const format = detectSourceFormatByName(file.name);
      // `prepareToOpen`'s caller refuses unknown extensions first; this is the safety net.
      if (format === "unknown") throw new Error(`対応していない形式のファイルです: ${file.name}`);
      formats.push(format);
      formatOf.set(file, format);
    }

    const estimator = (file: File) => POINT_COUNT_ESTIMATORS[formatOf.get(file) ?? "lasLaz"](file);
    const insufficient = isMulti
      ? await checkInsufficientSpaceMulti(sorted, estimator)
      : await checkInsufficientSpace(sorted[0], estimator);
    if (insufficient) return insufficient;

    const id = this.nextRequestId++;
    return this.beginConversion(id, buildPointFileConvertStartRequest(id, sorted, formats, isMobile), onProgress);
  }

  /**
   * M4-14: start merging several LAS/LAZ files into one COPC. Same division of work as `startConversion`,
   * but there is no `alreadyCopc` check: `prepareToOpen` sends one file to the single-file route, so there
   * are always two or more files here.
   */
  async startMultiConversion(files: File[], isMobile: boolean, onProgress: ProgressCallback): Promise<WebStart> {
    const fingerprints = files.map((f) => ({
      name: f.name,
      size: f.size,
      lastModified: f.lastModified,
    }));

    const cached = await opfs.findCachedMultiOutput(fingerprints);
    if (cached) {
      const key = this.registerFile(cached);
      return { kind: "cached", outputPath: key };
    }

    if (!(await opfs.isOpfsAvailable())) {
      return { kind: "opfsUnavailable" };
    }

    const insufficient = await checkInsufficientSpaceMulti(files, estimatePointCountForLasFile);
    if (insufficient) return insufficient;

    const id = this.nextRequestId++;
    return this.beginConversion(id, buildConvertMultiStartRequest(id, files, isMobile), onProgress);
  }

  /**
   * Registers the waiter for `id` BEFORE the request is posted (so no answer can be missed), then posts it.
   * `end` settles when the Worker answers `convert-done` or `convert-failed` for this id.
   */
  private beginConversion(id: number, request: WorkerRequest, onProgress: ProgressCallback): ConversionStarted {
    const end = new Promise<ConvertEnd>((resolve) => {
      this.convertPending.set(id, { resolve, onProgress });
    });
    this.activeConvertId = id;
    this.worker.postMessage(request);
    return { kind: "converting", end };
  }

  // --- L2-C: point-cloud tools (extraction, merge) ---

  /** Waiters per tool request id. Kept separate from conversion (`convertPending`): a tool result is
   *  not a conversion result (no breakdown, no download link; see `web-protocol.ts`). */
  private readonly toolPending = new Map<
    number,
    {
      resolve: (done: ToolDone) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ToolProgress) => void;
    }
  >();

  /** Looks up the registered `File` for a key ("file:N") passed to `open()`. */
  private fileForToolInput(path: string): File {
    const classified = classifyOpenPath(path);
    const file = classified.kind === "file" ? this.localFiles.get(classified.fileKey) : undefined;
    if (!file) {
      throw new Error(`ツールの入力は登録済みのファイルキーだけ対応しています: ${path}`);
    }
    return file;
  }

  /** Sends a tool request and waits for `tool-done` / `tool-failed`. The output is registered and returned as a key. */
  private async runTool(
    id: number,
    request: WorkerRequest,
    options: ToolOptions | undefined,
  ): Promise<ToolResult> {
    this.activeConvertId = id;
    try {
      const done = await new Promise<ToolDone>((resolve, reject) => {
        this.toolPending.set(id, { resolve, reject, onProgress: options?.onProgress });
        this.worker.postMessage(request);
      });
      const file = await opfs.getConvertedFile(done.outputName);
      if (!file) {
        throw new Error(`作った点群をOPFSから開けませんでした: ${done.outputName}`);
      }
      return {
        outputPath: this.registerFile(file),
        pointCount: done.pointCount,
        warnings: done.warnings,
      };
    } finally {
      if (this.activeConvertId === id) this.activeConvertId = null;
    }
  }

  /**
   * Creates a new COPC (on OPFS) from only the points of an open COPC (`path` = the key passed to `open()`)
   * that match `filter`. Passing the returned `outputPath` (a registered key) to `open()` makes a new layer.
   * With zero points it throws (the text is "選んだ範囲に点がありません", shown on screen as is). Cancel with `cancelConversion()`
   * (the error text is "キャンセルされました").
   */
  async extractToCopc(
    path: string,
    filter: ExtractFilter,
    options?: ToolOptions,
  ): Promise<ToolResult> {
    const file = this.fileForToolInput(path);
    if (!(await opfs.isOpfsAvailable())) {
      throw new Error("このブラウザでは点群ツールを使えません(OPFSが使えません)");
    }
    // The output is at most as large as the source, so estimate space from the source point count (safe side).
    const insufficient = await checkInsufficientSpace(file, estimatePointCountForLasFile);
    if (insufficient) throw new Error("空き容量が足りないため、点群ツールを実行できません");
    const id = this.nextRequestId++;
    return await this.runTool(
      id,
      buildExtractStartRequest(id, file, filter, `抽出: ${file.name}`),
      options,
    );
  }

  // --- G1: rasterize ---

  /** Waiters of the export (`raster-done`). Progress and failure use the `tool-*` messages with the same id. */
  private readonly rasterPending = new Map<
    number,
    {
      resolve: (done: RasterDoneResponse) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ToolProgress) => void;
    }
  >();

  /**
   * Reads the upper levels of an open COPC (`path` = the key passed to `open()`) and keeps them in the Worker while
   * the Rasterize window is open. Close with `closeRasterPreview`.
   */
  async openRasterPreview(path: string): Promise<RasterPreviewSession> {
    const file = this.fileForToolInput(path);
    const id = this.nextRequestId++;
    const response = await this.send(buildRasterPreviewOpenRequest(id, file));
    if (response.type !== "raster-preview-open-result") {
      throw new Error(`openRasterPreview()に対して予期しない応答: ${response.type}`);
    }
    return { id, info: response.info };
  }

  /** Draws the preview for `request` from the kept points (no file is read). */
  async renderRasterPreview(sessionId: number, request: RasterRequest): Promise<RasterPreviewImage> {
    const response = await this.send(buildRasterPreviewRenderRequest(this.nextRequestId++, sessionId, request));
    if (response.type !== "raster-preview-image") {
      throw new Error(`renderRasterPreview()に対して予期しない応答: ${response.type}`);
    }
    return decodePreviewImage(response.buffer);
  }

  /** Frees the kept points. Failures are only logged: the window is closing anyway. */
  async closeRasterPreview(sessionId: number): Promise<void> {
    try {
      await this.send(buildRasterPreviewCloseRequest(this.nextRequestId++, sessionId));
    } catch (e) {
      console.error("closeRasterPreview failed", e);
    }
  }

  /**
   * Exports the GeoTIFF of an open COPC (`path` = the key passed to `open()`): every point is read. The file is
   * returned as a download (`download`). Cancel with `cancelConversion()`.
   */
  async exportRasterGeoTiff(path: string, request: RasterExportRequest, options?: ToolOptions): Promise<RasterExportResult> {
    const file = this.fileForToolInput(path);
    const id = this.nextRequestId++;
    this.activeConvertId = id;
    try {
      const done = await new Promise<RasterDoneResponse>((resolve, reject) => {
        this.rasterPending.set(id, { resolve, reject, onProgress: options?.onProgress });
        this.worker.postMessage(buildRasterStartRequest(id, file, request));
      });
      const baseName = file.name.replace(/\.laz$/i, "").replace(/\.copc$/i, "");
      const url = URL.createObjectURL(new Blob([done.geotiff as BlobPart], { type: "image/tiff" }));
      return {
        width: done.width,
        height: done.height,
        warnings: done.warnings,
        path: null,
        download: { url, fileName: `${baseName}-raster.tif` },
      };
    } finally {
      if (this.activeConvertId === id) this.activeConvertId = null;
    }
  }
  // ---

  /**
   * Merges several open COPC files (keys passed to `open()`) into one COPC (on OPFS).
   * Files without a CRS are let through and the reason is returned in `warnings`. Throws if files that
   * both have a CRS differ.
   */
  async mergeCopcs(paths: string[], options?: ToolOptions & { isMobile?: boolean }): Promise<ToolResult> {
    if (paths.length < 2) throw new Error("合成するレイヤーが2つ未満です");
    const files = paths.map((p) => this.fileForToolInput(p));
    if (!(await opfs.isOpfsAvailable())) {
      throw new Error("このブラウザでは点群ツールを使えません(OPFSが使えません)");
    }
    const insufficient = await checkInsufficientSpaceMulti(files, estimatePointCountForLasFile);
    if (insufficient) throw new Error("空き容量が足りないため、合成を実行できません");
    const id = this.nextRequestId++;
    const label = `合成: ${opfs.multiDisplayNameFor(files.map((f) => f.name).sort())}`;
    return await this.runTool(
      id,
      buildToolMergeStartRequest(id, files, options?.isMobile ?? false, label),
      options,
    );
  }

  /**
   * Cancels the running conversion or tool. Does nothing if none is running. A fire-and-forget message: it
   * takes effect between read batches (it cannot interrupt the post-processing stage; see
   * crates/pcv-wasm/src/convert.rs). The answer comes as `convert-failed` with `cancelled: true`.
   */
  cancelConversion(): void {
    if (this.activeConvertId === null) return;
    this.worker.postMessage(buildConvertCancelRequest(this.activeConvertId));
  }

  private send(request: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  private handleResponse(response: WorkerResponse): void {
    if (response.type === "convert-progress") {
      this.convertPending.get(response.id)?.onProgress(toConversionProgress(response.progress));
      return;
    }
    if (response.type === "convert-done") {
      if (this.activeConvertId === response.id) this.activeConvertId = null;
      const waiting = this.convertPending.get(response.id);
      this.convertPending.delete(response.id);
      waiting?.resolve({
        kind: "done",
        outputName: response.outputName,
        suggestedFileName: response.suggestedFileName,
        pointCount: response.pointCount,
        stageTimings: toConversionStageBreakdown(response.stageTimings),
        warnings: response.warnings ?? [],
      });
      return;
    }
    // --- G2: section line ---
    if (response.type === "section-line-progress") {
      this.sectionLinePending.get(response.id)?.onProgress?.({
        pointsRead: Math.round(response.fraction * 1000),
        totalPoints: 1000,
      });
      return;
    }
    if (response.type === "section-line-done") {
      const waiting = this.sectionLinePending.get(response.id);
      this.sectionLinePending.delete(response.id);
      waiting?.resolve(response.buffer);
      return;
    }
    if (response.type === "section-line-failed") {
      const waiting = this.sectionLinePending.get(response.id);
      this.sectionLinePending.delete(response.id);
      waiting?.reject(new Error(response.message));
      return;
    }
    if (response.type === "tool-progress") {
      const progress = { pointsRead: response.pointsRead, totalPoints: response.totalPoints };
      this.toolPending.get(response.id)?.onProgress?.(progress);
      this.rasterPending.get(response.id)?.onProgress?.(progress); // G1
      return;
    }
    // --- G1: rasterize ---
    if (response.type === "raster-done") {
      const waiting = this.rasterPending.get(response.id);
      this.rasterPending.delete(response.id);
      waiting?.resolve(response);
      return;
    }
    // ---
    if (response.type === "tool-done") {
      const waiting = this.toolPending.get(response.id);
      this.toolPending.delete(response.id);
      waiting?.resolve({
        outputName: response.outputName,
        pointCount: response.pointCount,
        warnings: response.warnings,
      });
      return;
    }
    if (response.type === "tool-failed") {
      const waiting = this.toolPending.get(response.id);
      this.toolPending.delete(response.id);
      waiting?.reject(new Error(response.message));
      // --- G1: rasterize --- (the export fails with the same message)
      const rasterWaiting = this.rasterPending.get(response.id);
      this.rasterPending.delete(response.id);
      rasterWaiting?.reject(new Error(response.message));
      // ---
      return;
    }
    if (response.type === "convert-failed") {
      if (this.activeConvertId === response.id) this.activeConvertId = null;
      const waiting = this.convertPending.get(response.id);
      this.convertPending.delete(response.id);
      waiting?.resolve({ kind: "failed", message: response.message, cancelled: response.cancelled });
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
