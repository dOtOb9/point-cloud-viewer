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
  buildFilterStartRequest,
  buildDtmStartRequest,
  buildThinStartRequest,
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
  type DtmDoneFiles,
  type PointFileFormat,
  type RasterDoneResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./web-protocol";
import { StaleNodeRequestError } from "./stale-node-error";
import type { ExtractFilter, ToolOptions, ToolProgress, ToolResult } from "./tools";
import type { FilterRequest, ThinRequest } from "./thin-filter";
import type { DtmFile, DtmRequest, DtmResult } from "./dtm";
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

interface ToolDone {
  outputName: string;
  pointCount: number;
  warnings: string[];
  dtm?: DtmDoneFiles;
}

const POINT_COUNT_ESTIMATORS: Record<PointFileFormat, (file: File) => Promise<number | null>> = {
  lasLaz: estimatePointCountForLasFile,
  pcd: estimatePointCountForPcdFile,
  ply: estimatePointCountForPlyFile,
  e57: estimatePointCountForE57File,
};

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

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  terminate?(): void;
}

function createRealWorker(): WorkerLike {
  return new Worker(new URL("./copc.worker.ts", import.meta.url), {
    type: "module",
  });
}

type ProgressCallback = (progress: ConversionProgress) => void;

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

  private readonly convertPending = new Map<
    number,
    { resolve: (end: ConvertEnd) => void; onProgress: ProgressCallback }
  >();
  private activeConvertId: number | null = null;

  constructor(createWorker: () => WorkerLike = createRealWorker) {
    this.worker = createWorker();
    this.worker.onmessage = (event) => this.handleResponse(event.data);
  }

  registerFile(file: File): string {
    const key = makeFileKey(this.nextFileSequence++);
    this.localFiles.set(key, file);
    return key;
  }

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

    if (!isMulti && (await isCopcFile(first))) {
      return { kind: "ready", path: this.registerFile(first), conversion: null };
    }
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
      cloudId: response.generation,
      info: toCloudInfo(response.info),
      nodes: response.nodes.map(toHierarchyNodeInfo),
    };
  }

  async readNode(cloudId: number, key: string): Promise<ArrayBuffer> {
    const id = this.nextRequestId++;
    const response = await this.send(buildReadNodeRequest(id, key, cloudId));
    if (response.type === "readNode-stale") {
      throw new StaleNodeRequestError(key);
    }
    if (response.type !== "readNode-result") {
      throw new Error(`readNode()に対して予期しない応答: ${response.type}`);
    }
    this.lastBytesRead = response.bytesRead;
    return response.buffer;
  }

  async readSectionProfile(cloudId: number, line: SectionLineInput, cap: number): Promise<SectionPoints> {
    const response = await this.send(buildSectionProfileRequest(this.nextRequestId++, cloudId, line, cap));
    if (response.type !== "section-profile-result") {
      throw new Error(`readSectionProfile()に対して予期しない応答: ${response.type}`);
    }
    return decodeSectionProfile(response.buffer);
  }

  private readonly sectionLinePending = new Map<
    number,
    {
      resolve: (buffer: ArrayBuffer) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ToolProgress) => void;
    }
  >();

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

  getLastBytesRead(): number {
    return this.lastBytesRead;
  }

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

    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const formats: PointFileFormat[] = [];
    const formatOf = new Map<File, PointFileFormat>();
    for (const file of sorted) {
      const format = detectSourceFormatByName(file.name);
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

  private beginConversion(id: number, request: WorkerRequest, onProgress: ProgressCallback): ConversionStarted {
    const end = new Promise<ConvertEnd>((resolve) => {
      this.convertPending.set(id, { resolve, onProgress });
    });
    this.activeConvertId = id;
    this.worker.postMessage(request);
    return { kind: "converting", end };
  }

  private readonly toolPending = new Map<
    number,
    {
      resolve: (done: ToolDone) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ToolProgress) => void;
    }
  >();

  private fileForToolInput(path: string): File {
    const classified = classifyOpenPath(path);
    const file = classified.kind === "file" ? this.localFiles.get(classified.fileKey) : undefined;
    if (!file) {
      throw new Error(`ツールの入力は登録済みのファイルキーだけ対応しています: ${path}`);
    }
    return file;
  }

  private async runTool(
    id: number,
    request: WorkerRequest,
    options: ToolOptions | undefined,
  ): Promise<ToolResult & { dtm?: DtmDoneFiles }> {
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
        dtm: done.dtm,
      };
    } finally {
      if (this.activeConvertId === id) this.activeConvertId = null;
    }
  }

  async extractToCopc(
    path: string,
    filter: ExtractFilter,
    options?: ToolOptions,
  ): Promise<ToolResult> {
    const file = this.fileForToolInput(path);
    if (!(await opfs.isOpfsAvailable())) {
      throw new Error("このブラウザでは点群ツールを使えません(OPFSが使えません)");
    }
    const insufficient = await checkInsufficientSpace(file, estimatePointCountForLasFile);
    if (insufficient) throw new Error("空き容量が足りないため、点群ツールを実行できません");
    const id = this.nextRequestId++;
    return await this.runTool(
      id,
      buildExtractStartRequest(id, file, filter, `抽出: ${file.name}`),
      options,
    );
  }

  async thinCopc(path: string, request: ThinRequest, options?: ToolOptions): Promise<ToolResult> {
    const file = await this.checkedToolInput(path);
    const id = this.nextRequestId++;
    return await this.runTool(id, buildThinStartRequest(id, file, request, `間引き: ${file.name}`), options);
  }

  async filterCopc(path: string, request: FilterRequest, options?: ToolOptions): Promise<ToolResult> {
    const file = await this.checkedToolInput(path);
    const id = this.nextRequestId++;
    return await this.runTool(id, buildFilterStartRequest(id, file, request, `フィルタ: ${file.name}`), options);
  }

  private async checkedToolInput(path: string): Promise<File> {
    const file = this.fileForToolInput(path);
    if (!(await opfs.isOpfsAvailable())) {
      throw new Error("このブラウザでは点群ツールを使えません(OPFSが使えません)");
    }
    const insufficient = await checkInsufficientSpace(file, estimatePointCountForLasFile);
    if (insufficient) throw new Error("空き容量が足りないため、点群ツールを実行できません");
    return file;
  }

  async dtmCopc(path: string, request: DtmRequest, options?: ToolOptions): Promise<DtmResult> {
    const file = await this.checkedToolInput(path);
    const id = this.nextRequestId++;
    const done = await this.runTool(id, buildDtmStartRequest(id, file, request, `DTM: ${file.name}`), options);
    const files = done.dtm;
    if (!files) throw new Error("DTM の結果が返りませんでした");
    const baseName = file.name.replace(/\.laz$/i, "").replace(/\.copc$/i, "");
    const download = (bytes: Uint8Array | null, type: string, extension: string): DtmFile | null =>
      bytes === null
        ? null
        : {
            fileName: `${baseName}-dtm.${extension}`,
            path: null,
            downloadUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type })),
          };
    return {
      outputPath: done.outputPath,
      pointCount: done.pointCount,
      warnings: done.warnings,
      dtm: {
        cellSize: files.cellSize,
        width: files.width,
        height: files.height,
        tinPoints: files.tinPoints,
        tinTriangles: files.tinTriangles,
        groundPoints: files.groundPoints,
        geotiff: download(files.geotiff, "image/tiff", "tif"),
        landxml: download(files.landxml, "application/xml", "xml"),
      },
    };
  }

  private readonly rasterPending = new Map<
    number,
    {
      resolve: (done: RasterDoneResponse) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ToolProgress) => void;
    }
  >();

  async openRasterPreview(path: string): Promise<RasterPreviewSession> {
    const file = this.fileForToolInput(path);
    const id = this.nextRequestId++;
    const response = await this.send(buildRasterPreviewOpenRequest(id, file));
    if (response.type !== "raster-preview-open-result") {
      throw new Error(`openRasterPreview()に対して予期しない応答: ${response.type}`);
    }
    return { id, info: response.info };
  }

  async renderRasterPreview(sessionId: number, request: RasterRequest): Promise<RasterPreviewImage> {
    const response = await this.send(buildRasterPreviewRenderRequest(this.nextRequestId++, sessionId, request));
    if (response.type !== "raster-preview-image") {
      throw new Error(`renderRasterPreview()に対して予期しない応答: ${response.type}`);
    }
    return decodePreviewImage(response.buffer);
  }

  async closeRasterPreview(sessionId: number): Promise<void> {
    try {
      await this.send(buildRasterPreviewCloseRequest(this.nextRequestId++, sessionId));
    } catch (e) {
      console.error("closeRasterPreview failed", e);
    }
  }

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
      this.rasterPending.get(response.id)?.onProgress?.(progress);
      return;
    }
    if (response.type === "raster-done") {
      const waiting = this.rasterPending.get(response.id);
      this.rasterPending.delete(response.id);
      waiting?.resolve(response);
      return;
    }
    if (response.type === "tool-done") {
      const waiting = this.toolPending.get(response.id);
      this.toolPending.delete(response.id);
      waiting?.resolve({
        outputName: response.outputName,
        pointCount: response.pointCount,
        warnings: response.warnings,
        dtm: response.dtm,
      });
      return;
    }
    if (response.type === "tool-failed") {
      const waiting = this.toolPending.get(response.id);
      this.toolPending.delete(response.id);
      waiting?.reject(new Error(response.message));
      const rasterWaiting = this.rasterPending.get(response.id);
      this.rasterPending.delete(response.id);
      rasterWaiting?.reject(new Error(response.message));
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
