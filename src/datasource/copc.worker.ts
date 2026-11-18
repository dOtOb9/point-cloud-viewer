import init, {
  init_panic_hook as initPanicHook,
  inspectLasHeaderSummary,
  lastAllocationFailureMessage,
  opfsScratchPoolSize,
  WasmConverter,
  WasmExtractor,
  WasmRasterizer,
  WasmRasterPreview,
  WasmSectionLine,
  WasmCopcFile,
  WasmPointFileConverter,
  WasmThinFilter,
  WasmDtm,
} from "../wasm/pcv-wasm/pcv_wasm.js";
import type { CloudInfoDto, HierarchyNodeDto } from "./copc-dto";
import type { RasterPreviewInfo } from "./raster";
import type { ConversionStageBreakdownDto, PreparingStepDto } from "./conversion-dto";
import {
  BoundedBatchFlow,
  decompressWorkerCountFor,
  pointRangesFor,
  DECOMPRESS_BATCH_POINTS,
  MAX_IN_FLIGHT_BATCHES_PER_WORKER,
} from "./decompress-partition";
import type { PointRange } from "./decompress-partition";
import type { DecompressRequest, DecompressResponse } from "./laz-decompress.worker";
import * as opfs from "./opfs";
import { DEFAULT_MAX_POINTS_PER_NODE } from "./web-protocol";
import type {
  ConvertMultiStartRequest,
  ExtractStartRequest,
  FilterStartRequest,
  DtmStartRequest,
  ThinStartRequest,
  OpenSource,
  PointFileConvertStartRequest,
  PointFileFormat,
  SectionProfileRequest,
  RasterStartRequest,
  RasterPreviewOpenRequest,
  RasterPreviewRenderRequest,
  RasterPreviewCloseRequest,
  SectionLineStartRequest,
  WorkerRequest,
  WorkerResponse,
} from "./web-protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}
const rawScope = self as unknown as WorkerScope;

const toolRequestIds = new Set<number>();

function translateForTool(message: WorkerResponse): WorkerResponse | null {
  if (!("id" in message) || !toolRequestIds.has(message.id)) return message;
  switch (message.type) {
    case "convert-progress":
      return message.progress.phase === "reading"
        ? {
            type: "tool-progress",
            id: message.id,
            pointsRead: message.progress.points_read,
            totalPoints: message.progress.total_points,
          }
        : null;
    case "convert-done":
      toolRequestIds.delete(message.id);
      return {
        type: "tool-done",
        id: message.id,
        outputName: message.outputName,
        pointCount: message.pointCount,
        warnings: message.warnings ?? [],
      };
    case "convert-failed":
      toolRequestIds.delete(message.id);
      return {
        type: "tool-failed",
        id: message.id,
        message: message.message,
        cancelled: message.cancelled,
      };
    default:
      return message;
  }
}

const scope = {
  set onmessage(handler: WorkerScope["onmessage"]) {
    rawScope.onmessage = handler;
  },
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void {
    const translated = translateForTool(message);
    if (translated) rawScope.postMessage(translated, transfer);
  },
};

let wasmReady: Promise<void> | null = null;
const openFiles = new Map<number, WasmCopcFile>();

let openGeneration = 0;

let activeConvertId: number | null = null;
let convertCancelRequested = false;

let activeDecompressWorkers: Array<{ worker: Worker; reject: (err: Error) => void }> = [];

class ParallelReadCancelledError extends Error {}

function ensureWasmReady(): Promise<void> {
  wasmReady ??= init().then(() => {
    initPanicHook();
  });
  return wasmReady;
}

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: WorkerRequest): Promise<void> {
  if (request.type === "convertCancel") {
    if (request.id === activeConvertId) {
      convertCancelRequested = true;
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
      case "close":
        handleClose(request.id, request.cloudId);
        return;
      case "sectionLineStart":
        await handleSectionLineStart(request);
        return;
      case "sectionProfile":
        handleSectionProfile(request);
        return;
      case "convertStart":
        await handleConvertStart(request.id, request.file, request.maxPointsPerNode, request.isMobile);
        return;
      case "convertMultiStart":
        await handleConvertMultiStart(request);
        return;
      case "pointFileConvertStart":
        await handlePointFileConvertStart(request);
        return;
      case "extractStart":
        await handleExtractStart(request);
        return;
      case "thinStart":
        await handleThinStart(request);
        return;
      case "filterStart":
        await handleFilterStart(request);
        return;
      case "dtmStart":
        await handleDtmStart(request);
        return;
      case "rasterPreviewOpen":
        await handleRasterPreviewOpen(request);
        return;
      case "rasterPreviewRender":
        handleRasterPreviewRender(request);
        return;
      case "rasterPreviewClose":
        handleRasterPreviewClose(request);
        return;
      case "rasterStart":
        await handleRasterStart(request);
        return;
      case "toolMergeStart":
        toolRequestIds.add(request.id);
        await handleConvertMultiStart({
          type: "convertMultiStart",
          id: request.id,
          files: request.files,
          maxPointsPerNode: DEFAULT_MAX_POINTS_PER_NODE,
          isMobile: request.isMobile,
        });
        return;
    }
  } catch (err) {
    scope.postMessage({
      type: "error",
      id: request.id,
      ok: false,
      message: describeConversionFailure(err),
    });
  }
}

function handleOpen(id: number, source: OpenSource): void {
  const openFile =
    source.kind === "file" ? WasmCopcFile.openFile(source.file) : WasmCopcFile.openUrl(source.url);
  openGeneration += 1;
  openFiles.set(openGeneration, openFile);

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
  const openFile = openFiles.get(generation);
  if (!openFile) {
    scope.postMessage({ type: "readNode-stale", id });
    return;
  }
  const bytes = openFile.readNode(key);
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

function handleSectionProfile(request: SectionProfileRequest): void {
  const openFile = openFiles.get(request.cloudId);
  if (!openFile) {
    throw new Error("断面のレイヤーが閉じられています");
  }
  const bytes = openFile.readSectionProfile(request.line, request.cap);
  const buffer = bytes.buffer as ArrayBuffer;
  scope.postMessage({ type: "section-profile-result", id: request.id, ok: true, buffer }, [buffer]);
}

const SECTION_LINE_SLICE_MS = 30;

async function handleSectionLineStart(request: SectionLineStartRequest): Promise<void> {
  const { id } = request;
  const fail = (message: string, cancelled: boolean) =>
    scope.postMessage({ type: "section-line-failed", id, message, cancelled });
  const openFile = openFiles.get(request.cloudId);
  if (!openFile) {
    fail("断面線の元になるレイヤーが閉じられています", false);
    return;
  }
  activeConvertId = id;
  convertCancelRequested = false;
  let job: WasmSectionLine | null = null;
  try {
    job = new WasmSectionLine(openFile, request.line, request.request);
    while (!job.isDone()) {
      const sliceStart = performance.now();
      let fraction = 0;
      while (!job.isDone() && performance.now() - sliceStart < SECTION_LINE_SLICE_MS) {
        fraction = job.advance(openFile);
      }
      scope.postMessage({ type: "section-line-progress", id, fraction });
      if (convertCancelRequested) {
        fail("キャンセルされました", true);
        return;
      }
      await yieldToEventLoop();
      if (convertCancelRequested) {
        fail("キャンセルされました", true);
        return;
      }
    }
    const bytes = job.finish();
    const buffer = bytes.buffer as ArrayBuffer;
    scope.postMessage({ type: "section-line-done", id, buffer }, [buffer]);
  } catch (err) {
    fail(describeConversionFailure(err), false);
  } finally {
    job?.free();
    if (activeConvertId === id) activeConvertId = null;
  }
}

function handleClose(id: number, cloudId: number): void {
  const file = openFiles.get(cloudId);
  if (file) {
    openFiles.delete(cloudId);
    file.free();
  }
  scope.postMessage({ type: "close-result", id, ok: true });
}

interface FeedResultDto {
  points_read: number;
  total_points: number;
  done: boolean;
}

interface FinishResultDto {
  point_count: number;
  stage_timings: ConversionStageBreakdownDto;
  warnings?: string[];
}

const CONVERT_BATCH_SIZE = 64 * 1024;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function describeConversionFailure(err: unknown): string {
  const baseMessage = err instanceof Error ? err.message : String(err);
  const looksLikeWasmTrap = /unreachable/i.test(baseMessage) || /RuntimeError/i.test(baseMessage);
  if (!looksLikeWasmTrap) return baseMessage;

  let allocationFailureMessage: string | null | undefined;
  try {
    allocationFailureMessage = lastAllocationFailureMessage();
  } catch {
    allocationFailureMessage = undefined;
  }
  if (allocationFailureMessage) {
    return `${baseMessage}(${allocationFailureMessage})`;
  }
  return `${baseMessage}(メモリ不足の可能性があります。詳しい情報がブラウザの開発者ツールのConsoleに出ている場合があるので確認してください)`;
}

function spawnDecompressWorker(): Worker {
  return new Worker(new URL("./laz-decompress.worker.ts", import.meta.url), { type: "module" });
}

async function runParallelReadPhase(
  converter: WasmConverter,
  file: File,
  totalPoints: number,
  workerCount: number,
  onProgress: (pointsRead: number) => void,
  onWorkerStarting?: (started: number) => void,
): Promise<"done" | "cancelled"> {
  const ranges = pointRangesFor(totalPoints, workerCount);
  const recordWidth = converter.recordWidth();
  const estimatedBatchBytes = DECOMPRESS_BATCH_POINTS * recordWidth;
  const flow = new BoundedBatchFlow({
    maxInFlightBatches: workerCount * MAX_IN_FLIGHT_BATCHES_PER_WORKER,
    maxInFlightBytes: workerCount * MAX_IN_FLIGHT_BATCHES_PER_WORKER * estimatedBatchBytes,
  });

  const workers = ranges.map(() => spawnDecompressWorker());
  let pointsCompleted = 0;
  let cancelled = false;

  function runWorkerLoop(worker: Worker, range: PointRange, index: number) {
    return new Promise<void>((resolve, reject) => {
      let nextRequestId = 0;
      let batchRequestPending = false;
      activeDecompressWorkers.push({ worker, reject });

      worker.onerror = (event) => {
        reject(new Error(event.message || "展開Workerでエラーが発生しました"));
      };

      async function requestNextBatch(): Promise<void> {
        if (cancelled || convertCancelRequested) {
          resolve();
          return;
        }
        while (!flow.canAcquire()) {
          await yieldToEventLoop();
          if (cancelled || convertCancelRequested) {
            resolve();
            return;
          }
        }
        flow.acquire(estimatedBatchBytes);
        batchRequestPending = true;
        const request: DecompressRequest = {
          type: "requestBatch",
          id: nextRequestId++,
          batchSize: DECOMPRESS_BATCH_POINTS,
        };
        worker.postMessage(request);
      }

      worker.onmessage = (event: MessageEvent<DecompressResponse>) => {
        const response = event.data;
        switch (response.type) {
          case "decompress-ready":
            void requestNextBatch();
            return;
          case "decompress-batch": {
            batchRequestPending = false;
            const actualBytes = response.bytes.byteLength;
            flow.adjustBytes(estimatedBatchBytes, actualBytes);
            converter.pushSerializedRecords(new Uint8Array(response.bytes));
            flow.release(actualBytes);
            pointsCompleted += actualBytes / recordWidth;
            onProgress(pointsCompleted);
            if (convertCancelRequested) {
              cancelled = true;
              resolve();
              return;
            }
            void requestNextBatch();
            return;
          }
          case "decompress-done":
            if (batchRequestPending) {
              flow.release(estimatedBatchBytes);
              batchRequestPending = false;
            }
            resolve();
            return;
          case "decompress-failed":
            if (batchRequestPending) {
              flow.release(estimatedBatchBytes);
              batchRequestPending = false;
            }
            reject(new Error(response.message));
            return;
        }
      };

      const initRequest: DecompressRequest = {
        type: "init",
        id: index,
        file,
        startIndex: range.startIndex,
        count: range.count,
      };
      worker.postMessage(initRequest);
    });
  }

  try {
    await Promise.all(workers.map((worker, index) => {
      onWorkerStarting?.(index + 1);
      return runWorkerLoop(worker, ranges[index], index);
    }));
    return cancelled ? "cancelled" : "done";
  } catch (err) {
    if (err instanceof ParallelReadCancelledError) return "cancelled";
    throw err;
  } finally {
    for (const worker of workers) worker.terminate();
    activeDecompressWorkers = [];
  }
}

function suggestedFileNameFor(sourceFileName: string): string {
  const withoutExtension = sourceFileName.replace(/\.(laz|las|pcd|ply|e57)$/i, "");
  return `${withoutExtension}.copc.laz`;
}

function reportPreparing(id: number, preparing: PreparingStepDto): void {
  scope.postMessage({
    type: "convert-progress",
    id,
    progress: { phase: "preparing", preparing },
  });
}

async function handleConvertStart(
  id: number,
  file: File,
  maxPointsPerNode: number,
  isMobile: boolean,
): Promise<void> {
  reportPreparing(id, { step: "acquiring_lock" });
  const outcome = await opfs.withConversionLock(navigator.locks, () =>
    runConversion(id, file, maxPointsPerNode, isMobile),
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

async function runConversion(
  id: number,
  file: File,
  maxPointsPerNode: number,
  isMobile: boolean,
): Promise<void> {
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
    reportPreparing(id, { step: "cleaning_stale_scratch" });
    await opfs.cleanupStaleScratchDirsWithoutStoppingTheJob();

    const poolSize = opfsScratchPoolSize();
    const pool = await opfs.createScratchPool(poolSize, (opened, total) => {
      reportPreparing(id, { step: "opening_scratch_files", opened, total });
    });
    scratchDirName = pool.dirName;
    scratchHandles = pool.handles;
    reportPreparing(id, { step: "opening_output_file" });
    outputHandle = await opfs.createOutputHandle(outputName);

    reportPreparing(id, { step: "reading_header" });
    converter = new WasmConverter(file, scratchHandles, outputHandle, outputName, maxPointsPerNode);

    const totalPoints = converter.totalPoints();
    const workerCount = decompressWorkerCountFor(totalPoints, {
      hardwareConcurrency:
        typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
      isMobile,
    });
    const reportReadingProgress = (pointsRead: number) => {
      scope.postMessage({
        type: "convert-progress",
        id,
        progress: { phase: "reading", points_read: pointsRead, total_points: totalPoints, elapsed_secs: elapsedSecs() },
      });
    };

    if (workerCount > 1) {
      const reportWorkerStarting = (started: number) => {
        reportPreparing(id, { step: "starting_decompress_workers", started, total: workerCount });
      };
      const outcome = await runParallelReadPhase(
        converter,
        file,
        totalPoints,
        workerCount,
        reportReadingProgress,
        reportWorkerStarting,
      );
      if (outcome === "cancelled") {
        scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
        return;
      }
    } else {
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

    scope.postMessage({
      type: "convert-progress",
      id,
      progress: { phase: "post_processing", elapsed_secs: elapsedSecs() },
    });
    let finishResult: FinishResultDto;
    try {
      finishResult = converter.finish() as FinishResultDto;
    } finally {
      converter = null;
    }

    if (convertCancelRequested) {
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
      stageTimings: finishResult.stage_timings,
      warnings: finishResult.warnings ?? [],
    });
  } catch (err) {
    scope.postMessage({
      type: "convert-failed",
      id,
      message: describeConversionFailure(err),
      cancelled: false,
    });
  } finally {
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

interface HeaderSummaryDto {
  declared_points: number;
  layout_key: string;
  crs_label: string;
  file_size_bytes: number;
}

async function handleConvertMultiStart(request: ConvertMultiStartRequest): Promise<void> {
  const { id, files, maxPointsPerNode, isMobile } = request;
  reportPreparing(id, { step: "acquiring_lock" });
  const outcome = await opfs.withConversionLock(navigator.locks, () =>
    runMultiConversion(id, files, maxPointsPerNode, isMobile),
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

async function runMultiConversion(
  id: number,
  files: File[],
  maxPointsPerNode: number,
  isMobile: boolean,
): Promise<void> {
  activeConvertId = id;
  convertCancelRequested = false;

  const fingerprints = files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified }));
  const outputName = opfs.outputFileNameForMulti(fingerprints);
  const startedAt = performance.now();
  const elapsedSecs = () => (performance.now() - startedAt) / 1000;

  let scratchDirName: string | null = null;
  let scratchHandles: FileSystemSyncAccessHandle[] = [];
  let outputHandle: FileSystemSyncAccessHandle | null = null;
  let converter: WasmConverter | null = null;
  let succeeded = false;

  try {
    reportPreparing(id, { step: "cleaning_stale_scratch" });
    await opfs.cleanupStaleScratchDirsWithoutStoppingTheJob();

    reportPreparing(id, { step: "reading_header" });
    const summaries: HeaderSummaryDto[] = files.map(
      (file) => inspectLasHeaderSummary(file) as HeaderSummaryDto,
    );
    const first = summaries[0];
    const NO_CRS = "Missing";
    const firstKnownCrs = summaries.findIndex((s) => s.crs_label !== NO_CRS);
    for (let i = 1; i < summaries.length; i++) {
      if (summaries[i].layout_key !== first.layout_key) {
        throw new Error(
          `${files[i].name}: 点フォーマットが${files[0].name}と異なるため、まとめて変換できません`,
        );
      }
      if (
        summaries[i].crs_label !== NO_CRS &&
        firstKnownCrs >= 0 &&
        summaries[i].crs_label !== summaries[firstKnownCrs].crs_label
      ) {
        throw new Error(
          `${files[i].name}: CRS(座標系)が${files[firstKnownCrs].name}と異なるため、まとめて変換できません`,
        );
      }
    }
    const totalPoints = summaries.reduce((sum, s) => sum + s.declared_points, 0);
    const totalFileSizeBytes = summaries.reduce((sum, s) => sum + s.file_size_bytes, 0);

    const poolSize = opfsScratchPoolSize();
    const pool = await opfs.createScratchPool(poolSize, (opened, total) => {
      reportPreparing(id, { step: "opening_scratch_files", opened, total });
    });
    scratchDirName = pool.dirName;
    scratchHandles = pool.handles;
    reportPreparing(id, { step: "opening_output_file" });
    outputHandle = await opfs.createOutputHandle(outputName);

    converter = new WasmConverter(files[0], scratchHandles, outputHandle, outputName, maxPointsPerNode);
    converter.setDeclaredTotals(totalPoints, totalFileSizeBytes);

    let pointsCompletedBeforeCurrentFile = 0;
    const reportReadingProgress = (pointsReadInCurrentFile: number) => {
      scope.postMessage({
        type: "convert-progress",
        id,
        progress: {
          phase: "reading",
          points_read: pointsCompletedBeforeCurrentFile + pointsReadInCurrentFile,
          total_points: totalPoints,
          elapsed_secs: elapsedSecs(),
        },
      });
    };

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      if (fileIndex > 0) {
        converter.openNextFile(files[fileIndex]);
      }
      const fileTotalPoints = summaries[fileIndex].declared_points;
      const workerCount = decompressWorkerCountFor(fileTotalPoints, {
        hardwareConcurrency:
          typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
        isMobile,
      });

      if (workerCount > 1) {
        const reportWorkerStarting = (started: number) => {
          reportPreparing(id, { step: "starting_decompress_workers", started, total: workerCount });
        };
        const phaseOutcome = await runParallelReadPhase(
          converter,
          files[fileIndex],
          fileTotalPoints,
          workerCount,
          reportReadingProgress,
          reportWorkerStarting,
        );
        if (phaseOutcome === "cancelled") {
          scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
          return;
        }
      } else {
        for (;;) {
          if (convertCancelRequested) {
            scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
            return;
          }
          const result = converter.feed(CONVERT_BATCH_SIZE) as FeedResultDto;
          reportReadingProgress(result.points_read - pointsCompletedBeforeCurrentFile);
          if (result.done) break;
          await yieldToEventLoop();
        }
      }

      if (convertCancelRequested) {
        scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
        return;
      }
      pointsCompletedBeforeCurrentFile += fileTotalPoints;
    }

    scope.postMessage({
      type: "convert-progress",
      id,
      progress: { phase: "post_processing", elapsed_secs: elapsedSecs() },
    });
    let finishResult: FinishResultDto;
    try {
      finishResult = converter.finish() as FinishResultDto;
    } finally {
      converter = null;
    }

    if (convertCancelRequested) {
      scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
      return;
    }

    await opfs.writeMultiCacheMeta(fingerprints, outputName);
    succeeded = true;
    const sortedNames = files.map((f) => f.name).sort();
    scope.postMessage({
      type: "convert-done",
      id,
      outputName,
      suggestedFileName: `${opfs.multiDisplayNameFor(sortedNames)}.copc.laz`,
      pointCount: finishResult.point_count,
      stageTimings: finishResult.stage_timings,
      warnings: finishResult.warnings ?? [],
    });
  } catch (err) {
    scope.postMessage({
      type: "convert-failed",
      id,
      message: describeConversionFailure(err),
      cancelled: false,
    });
  } finally {
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

async function handleExtractStart(request: ExtractStartRequest): Promise<void> {
  const { id, file, filter, label } = request;
  const outcome = await opfs.withConversionLock(navigator.locks, () =>
    runExtract(id, file, filter, label),
  );
  if (outcome.kind === "busy") {
    scope.postMessage({
      type: "tool-failed",
      id,
      message: "別のタブ(またはウィンドウ)で変換が進行中です。そちらが終わるまでお待ちください。",
      cancelled: false,
    });
  }
}

async function runExtract(
  id: number,
  file: File,
  filter: ExtractStartRequest["filter"],
  label: string,
): Promise<void> {
  activeConvertId = id;
  convertCancelRequested = false;

  const outputName = opfs.toolOutputName();
  let scratchDirName: string | null = null;
  let scratchHandles: FileSystemSyncAccessHandle[] = [];
  let outputHandle: FileSystemSyncAccessHandle | null = null;
  let extractor: WasmExtractor | null = null;
  let succeeded = false;
  const cancelled = () =>
    scope.postMessage({ type: "tool-failed", id, message: "キャンセルされました", cancelled: true });

  try {
    await opfs.cleanupStaleScratchDirsWithoutStoppingTheJob();
    const pool = await opfs.createScratchPool(opfsScratchPoolSize(), () => {});
    scratchDirName = pool.dirName;
    scratchHandles = pool.handles;
    outputHandle = await opfs.createOutputHandle(outputName);

    extractor = new WasmExtractor(
      file,
      filter,
      scratchHandles,
      outputHandle,
      outputName,
      DEFAULT_MAX_POINTS_PER_NODE,
    );

    for (;;) {
      if (convertCancelRequested) {
        cancelled();
        return;
      }
      const result = extractor.feed(CONVERT_BATCH_SIZE) as {
        points_scanned: number;
        candidate_points: number;
        done: boolean;
      };
      scope.postMessage({
        type: "tool-progress",
        id,
        pointsRead: result.points_scanned,
        totalPoints: result.candidate_points,
      });
      if (result.done) break;
      await yieldToEventLoop();
    }
    if (convertCancelRequested) {
      cancelled();
      return;
    }

    let finishResult: FinishResultDto;
    try {
      finishResult = extractor.finish() as FinishResultDto;
    } finally {
      extractor = null;
    }
    if (convertCancelRequested) {
      cancelled();
      return;
    }

    await opfs.writeToolOutputMeta(outputName, label);
    succeeded = true;
    scope.postMessage({
      type: "tool-done",
      id,
      outputName,
      pointCount: finishResult.point_count,
      warnings: finishResult.warnings ?? [],
    });
  } catch (err) {
    scope.postMessage({
      type: "tool-failed",
      id,
      message: describeConversionFailure(err),
      cancelled: false,
    });
  } finally {
    extractor?.free();
    opfs.closeHandles(scratchHandles);
    if (outputHandle) opfs.closeHandles([outputHandle]);
    if (scratchDirName) await opfs.removeScratchDir(scratchDirName);
    if (!succeeded) {
      await opfs.removeOutputFile(outputName);
    }
    if (activeConvertId === id) activeConvertId = null;
  }
}

async function handleThinStart(request: ThinStartRequest): Promise<void> {
  const { id, file, label } = request;
  await handleThinFilter(id, label, (scratchHandles, outputHandle, outputName) =>
    WasmThinFilter.forThin(file, request.request, scratchHandles, outputHandle, outputName, DEFAULT_MAX_POINTS_PER_NODE),
  );
}

async function handleFilterStart(request: FilterStartRequest): Promise<void> {
  const { id, file, label } = request;
  await handleThinFilter(id, label, (scratchHandles, outputHandle, outputName) =>
    WasmThinFilter.forFilter(file, request.request, scratchHandles, outputHandle, outputName, DEFAULT_MAX_POINTS_PER_NODE),
  );
}

async function handleThinFilter(
  id: number,
  label: string,
  create: (
    scratchHandles: FileSystemSyncAccessHandle[],
    outputHandle: FileSystemSyncAccessHandle,
    outputName: string,
  ) => WasmThinFilter,
): Promise<void> {
  const outcome = await opfs.withConversionLock(navigator.locks, () => runThinFilter(id, label, create));
  if (outcome.kind === "busy") {
    scope.postMessage({
      type: "tool-failed",
      id,
      message: "別のタブ(またはウィンドウ)で変換が進行中です。そちらが終わるまでお待ちください。",
      cancelled: false,
    });
  }
}

async function runThinFilter(
  id: number,
  label: string,
  create: (
    scratchHandles: FileSystemSyncAccessHandle[],
    outputHandle: FileSystemSyncAccessHandle,
    outputName: string,
  ) => WasmThinFilter,
): Promise<void> {
  activeConvertId = id;
  convertCancelRequested = false;

  const outputName = opfs.toolOutputName();
  let scratchDirName: string | null = null;
  let scratchHandles: FileSystemSyncAccessHandle[] = [];
  let outputHandle: FileSystemSyncAccessHandle | null = null;
  let job: WasmThinFilter | null = null;
  let succeeded = false;
  const cancelled = () =>
    scope.postMessage({ type: "tool-failed", id, message: "キャンセルされました", cancelled: true });

  try {
    await opfs.cleanupStaleScratchDirsWithoutStoppingTheJob();
    const pool = await opfs.createScratchPool(opfsScratchPoolSize(), () => {});
    scratchDirName = pool.dirName;
    scratchHandles = pool.handles;
    outputHandle = await opfs.createOutputHandle(outputName);

    job = create(scratchHandles, outputHandle, outputName);

    for (;;) {
      if (convertCancelRequested) {
        cancelled();
        return;
      }
      const step = job.advance() as { points_read: number; total_points: number; points_kept: number; done: boolean };
      scope.postMessage({ type: "tool-progress", id, pointsRead: step.points_read, totalPoints: step.total_points });
      if (step.done) break;
      await yieldToEventLoop();
    }
    if (convertCancelRequested) {
      cancelled();
      return;
    }

    let finishResult: FinishResultDto;
    try {
      finishResult = job.finish() as FinishResultDto;
    } finally {
      job = null;
    }
    if (convertCancelRequested) {
      cancelled();
      return;
    }

    await opfs.writeToolOutputMeta(outputName, label);
    succeeded = true;
    scope.postMessage({
      type: "tool-done",
      id,
      outputName,
      pointCount: finishResult.point_count,
      warnings: finishResult.warnings ?? [],
    });
  } catch (err) {
    scope.postMessage({
      type: "tool-failed",
      id,
      message: describeConversionFailure(err),
      cancelled: false,
    });
  } finally {
    job?.free();
    opfs.closeHandles(scratchHandles);
    if (outputHandle) opfs.closeHandles([outputHandle]);
    if (scratchDirName) await opfs.removeScratchDir(scratchDirName);
    if (!succeeded) {
      await opfs.removeOutputFile(outputName);
    }
    if (activeConvertId === id) activeConvertId = null;
  }
}

async function handleDtmStart(request: DtmStartRequest): Promise<void> {
  const { id, file, label } = request;
  const outcome = await opfs.withConversionLock(navigator.locks, () => runDtm(id, label, file, request));
  if (outcome.kind === "busy") {
    scope.postMessage({
      type: "tool-failed",
      id,
      message: "別のタブ(またはウィンドウ)で変換が進行中です。そちらが終わるまでお待ちください。",
      cancelled: false,
    });
  }
}

async function runDtm(id: number, label: string, file: File, request: DtmStartRequest): Promise<void> {
  activeConvertId = id;
  convertCancelRequested = false;

  const outputName = opfs.toolOutputName();
  let scratchDirName: string | null = null;
  let scratchHandles: FileSystemSyncAccessHandle[] = [];
  let outputHandle: FileSystemSyncAccessHandle | null = null;
  let job: WasmDtm | null = null;
  let succeeded = false;
  const cancelled = () =>
    scope.postMessage({ type: "tool-failed", id, message: "キャンセルされました", cancelled: true });

  try {
    await opfs.cleanupStaleScratchDirsWithoutStoppingTheJob();
    const pool = await opfs.createScratchPool(opfsScratchPoolSize(), () => {});
    scratchDirName = pool.dirName;
    scratchHandles = pool.handles;
    outputHandle = await opfs.createOutputHandle(outputName);

    job = new WasmDtm(file, request.request, scratchHandles, outputHandle, outputName, DEFAULT_MAX_POINTS_PER_NODE);

    for (;;) {
      if (convertCancelRequested) {
        cancelled();
        return;
      }
      const step = job.advance() as { fraction: number; done: boolean };
      scope.postMessage({ type: "tool-progress", id, pointsRead: Math.round(step.fraction * 1000), totalPoints: 1000 });
      if (step.done) break;
      await yieldToEventLoop();
    }
    if (convertCancelRequested) {
      cancelled();
      return;
    }

    const finishResult = job.finish() as FinishResultDto;
    if (convertCancelRequested) {
      cancelled();
      return;
    }
    const info = job.info() as {
      width: number;
      height: number;
      cell_size: number;
      tin_points: number;
      tin_triangles: number;
      ground_points: number;
      warnings: string[];
    };
    const geotiff = request.request.output.geotiff ? job.geotiff() : null;
    const landxml = request.request.output.landxml ? job.landxml(Date.now() / 1000) : null;

    await opfs.writeToolOutputMeta(outputName, label);
    succeeded = true;
    const transfer: ArrayBuffer[] = [];
    if (geotiff) transfer.push(geotiff.buffer as ArrayBuffer);
    if (landxml) transfer.push(landxml.buffer as ArrayBuffer);
    scope.postMessage(
      {
        type: "tool-done",
        id,
        outputName,
        pointCount: finishResult.point_count,
        warnings: finishResult.warnings ?? [],
        dtm: {
          geotiff,
          landxml,
          width: info.width,
          height: info.height,
          cellSize: info.cell_size,
          tinPoints: info.tin_points,
          tinTriangles: info.tin_triangles,
          groundPoints: info.ground_points,
        },
      },
      transfer,
    );
  } catch (err) {
    scope.postMessage({ type: "tool-failed", id, message: describeConversionFailure(err), cancelled: false });
  } finally {
    job?.free();
    opfs.closeHandles(scratchHandles);
    if (outputHandle) opfs.closeHandles([outputHandle]);
    if (scratchDirName) await opfs.removeScratchDir(scratchDirName);
    if (!succeeded) {
      await opfs.removeOutputFile(outputName);
    }
    if (activeConvertId === id) activeConvertId = null;
  }
}

const rasterPreviews = new Map<number, WasmRasterPreview>();

async function handleRasterPreviewOpen(request: RasterPreviewOpenRequest): Promise<void> {
  const preview = new WasmRasterPreview(request.file);
  try {
    for (;;) {
      const result = preview.feed(CONVERT_BATCH_SIZE) as { done: boolean };
      if (result.done) break;
      await yieldToEventLoop();
    }
    const info = preview.info() as RasterPreviewInfo;
    rasterPreviews.set(request.id, preview);
    scope.postMessage({ type: "raster-preview-open-result", id: request.id, info });
  } catch (err) {
    preview.free();
    throw err;
  }
}

function handleRasterPreviewRender(request: RasterPreviewRenderRequest): void {
  const preview = rasterPreviews.get(request.sessionId);
  if (!preview) throw new Error("ラスタ化のウィンドウが閉じられています");
  const bytes = preview.render(request.options);
  const buffer = bytes.buffer as ArrayBuffer;
  scope.postMessage({ type: "raster-preview-image", id: request.id, buffer }, [buffer]);
}

function handleRasterPreviewClose(request: RasterPreviewCloseRequest): void {
  rasterPreviews.get(request.sessionId)?.free();
  rasterPreviews.delete(request.sessionId);
  scope.postMessage({ type: "raster-preview-closed", id: request.id });
}

async function handleRasterStart(request: RasterStartRequest): Promise<void> {
  const { id, file, options } = request;
  activeConvertId = id;
  convertCancelRequested = false;
  let rasterizer: WasmRasterizer | null = null;
  try {
    rasterizer = new WasmRasterizer(file, options);
    for (;;) {
      if (convertCancelRequested) {
        scope.postMessage({ type: "tool-failed", id, message: "キャンセルされました", cancelled: true });
        return;
      }
      const result = rasterizer.feed(CONVERT_BATCH_SIZE) as {
        points_scanned: number;
        candidate_points: number;
        done: boolean;
      };
      scope.postMessage({
        type: "tool-progress",
        id,
        pointsRead: result.points_scanned,
        totalPoints: result.candidate_points,
      });
      if (result.done) break;
      await yieldToEventLoop();
    }
    const geotiff = rasterizer.geotiff();
    const info = rasterizer.info() as { width: number; height: number; warnings: string[] };
    scope.postMessage(
      { type: "raster-done", id, geotiff, width: info.width, height: info.height, warnings: info.warnings },
      [geotiff.buffer],
    );
  } catch (err) {
    scope.postMessage({ type: "tool-failed", id, message: describeConversionFailure(err), cancelled: false });
  } finally {
    rasterizer?.free();
    if (activeConvertId === id) activeConvertId = null;
  }
}

interface PointFileFeedResultDto {
  points_read: number;
  total_points: number;
  done: boolean;
}

interface PointFileFinishResultDto {
  point_count: number;
  stage_timings: ConversionStageBreakdownDto;
  warnings?: string[];
}

async function handlePointFileConvertStart(request: PointFileConvertStartRequest): Promise<void> {
  const { id, files, formats, maxPointsPerNode } = request;
  reportPreparing(id, { step: "acquiring_lock" });
  const outcome = await opfs.withConversionLock(navigator.locks, () =>
    runPointFileConversion(id, files, formats, maxPointsPerNode),
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

async function runPointFileConversion(
  id: number,
  files: File[],
  formats: PointFileFormat[],
  maxPointsPerNode: number,
): Promise<void> {
  activeConvertId = id;
  convertCancelRequested = false;

  const isMulti = files.length > 1;
  const fingerprints = files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified }));
  const outputName = isMulti ? opfs.outputFileNameForMulti(fingerprints) : opfs.outputFileNameFor(fingerprints[0]);
  const startedAt = performance.now();
  const elapsedSecs = () => (performance.now() - startedAt) / 1000;

  let scratchDirName: string | null = null;
  let scratchHandles: FileSystemSyncAccessHandle[] = [];
  let outputHandle: FileSystemSyncAccessHandle | null = null;
  let converter: WasmPointFileConverter | null = null;
  let succeeded = false;

  try {
    reportPreparing(id, { step: "cleaning_stale_scratch" });
    await opfs.cleanupStaleScratchDirsWithoutStoppingTheJob();

    const poolSize = opfsScratchPoolSize();
    const pool = await opfs.createScratchPool(poolSize, (opened, total) => {
      reportPreparing(id, { step: "opening_scratch_files", opened, total });
    });
    scratchDirName = pool.dirName;
    scratchHandles = pool.handles;
    reportPreparing(id, { step: "opening_output_file" });
    outputHandle = await opfs.createOutputHandle(outputName);

    reportPreparing(id, { step: "reading_header" });
    converter = new WasmPointFileConverter(formats, files, scratchHandles, outputHandle, outputName, maxPointsPerNode);

    const totalPoints = converter.totalPoints();
    for (;;) {
      if (convertCancelRequested) {
        scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
        return;
      }
      const result = converter.feed(CONVERT_BATCH_SIZE) as PointFileFeedResultDto;
      scope.postMessage({
        type: "convert-progress",
        id,
        progress: {
          phase: "reading",
          points_read: result.points_read,
          total_points: totalPoints,
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

    scope.postMessage({
      type: "convert-progress",
      id,
      progress: { phase: "post_processing", elapsed_secs: elapsedSecs() },
    });
    let finishResult: PointFileFinishResultDto;
    try {
      finishResult = converter.finish() as PointFileFinishResultDto;
    } finally {
      converter = null;
    }

    if (convertCancelRequested) {
      scope.postMessage({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
      return;
    }

    if (isMulti) {
      await opfs.writeMultiCacheMeta(fingerprints, outputName);
    } else {
      await opfs.writeCacheMeta(fingerprints[0], outputName);
    }
    succeeded = true;
    const sortedNames = files.map((f) => f.name).sort();
    scope.postMessage({
      type: "convert-done",
      id,
      outputName,
      suggestedFileName: isMulti
        ? `${opfs.multiDisplayNameFor(sortedNames)}.copc.laz`
        : suggestedFileNameFor(files[0].name),
      pointCount: finishResult.point_count,
      stageTimings: finishResult.stage_timings,
      warnings: finishResult.warnings ?? [],
    });
  } catch (err) {
    scope.postMessage({
      type: "convert-failed",
      id,
      message: describeConversionFailure(err),
      cancelled: false,
    });
  } finally {
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
