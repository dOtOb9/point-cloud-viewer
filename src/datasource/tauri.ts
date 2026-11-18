import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DataSource, OpenedCloud, PrepareOptions, PrepareOutcome } from "./DataSource";
import { basenameOfPath } from "./file-name";
import { toConversionFailureOutcome, toPrepareOutcome } from "./prepare-outcome";
import {
  toCloudInfo,
  toHierarchyNodeInfo,
  type CloudInfoDto,
  type HierarchyNodeDto,
} from "./copc-dto";
import {
  toConversionOutcome,
  toConversionProgress,
  toConversionStageBreakdown,
  type ConversionOutcome,
  type ConversionOutcomeDto,
  type ConversionProgress,
  type ConversionProgressDto,
  type ConversionStageBreakdown,
  type ConversionStageBreakdownDto,
} from "./conversion-dto";
import { isTauriEnvironment } from "./environment";
import type { ExtractFilter, ToolOptions, ToolResult } from "./tools";
import type { FilterRequest, ThinRequest } from "./thin-filter";
import type { DtmFile, DtmRequest, DtmResult } from "./dtm";
import {
  decodePreviewImage,
  type RasterExportRequest,
  type RasterExportResult,
  type RasterPreviewImage,
  type RasterPreviewInfo,
  type RasterPreviewSession,
  type RasterRequest,
} from "./raster";
import { decodeSectionProfile, type SectionLineInput, type SectionPoints } from "./section-profile";
import { decodeSectionLine, type SectionGroundLine, type SectionLineRequest } from "./section-line";
import { StaleNodeRequestError } from "./stale-node-error";
import { buildNodeRequestPath } from "./tauri-protocol";
import { OPENABLE_EXTENSIONS } from "./source-format";

function openDialogFilters(): { name: string; extensions: string[] }[] {
  const extensions = [...OPENABLE_EXTENSIONS];
  const shown = extensions.flatMap((ext) => (ext === "laz" ? [".laz", ".copc.laz"] : [`.${ext}`]));
  return [{ name: `点群ファイル (${shown.join(" / ")})`, extensions }];
}

interface OpenCopcResponseDto {
  info: CloudInfoDto;
  nodes: HierarchyNodeDto[];
  generation: number;
}

const STALE_GENERATION_HTTP_STATUS = 409;

export async function reportToBackendConsole(message: string): Promise<void> {
  if (!isTauriEnvironment()) return;
  await invoke("report_diagnostic", { message });
}

export async function getAppVersion(): Promise<string> {
  return await getVersion();
}

export async function openReleasePage(url: string): Promise<void> {
  await openUrl(url);
}

export async function onFilesDropped(
  onDrop: (paths: string[]) => void,
  onHover: (hovering: boolean) => void,
): Promise<() => void> {
  return await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "over" || payload.type === "enter") onHover(true);
    else if (payload.type === "leave") onHover(false);
    else if (payload.type === "drop") {
      onHover(false);
      if (payload.paths.length > 0) onDrop(payload.paths);
    }
  });
}

export async function pickLocalFiles(): Promise<string[] | null> {
  return await openFileDialog({
    multiple: true,
    directory: false,
    filters: openDialogFilters(),
  });
}

export async function pickTempDirectory(): Promise<string | null> {
  return await openFileDialog({ multiple: false, directory: true });
}

export async function supportsCustomTempDir(): Promise<boolean> {
  return await invoke<boolean>("supports_custom_temp_dir");
}

export async function startLasConversion(
  path: string,
  tempDir: string | null,
): Promise<ConversionOutcome> {
  const dto = await invoke<ConversionOutcomeDto>("start_las_conversion", {
    path,
    tempDir,
  });
  return toConversionOutcome(dto);
}

export async function startMultiLasConversion(
  paths: string[],
  tempDir: string | null,
): Promise<ConversionOutcome> {
  const dto = await invoke<ConversionOutcomeDto>("start_multi_las_conversion", {
    paths,
    tempDir,
  });
  return toConversionOutcome(dto);
}

export async function cancelLasConversion(): Promise<void> {
  await invoke("cancel_las_conversion");
}

const NOOP_UNLISTEN: UnlistenFn = () => {};

export async function onConversionProgress(
  callback: (progress: ConversionProgress) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) return NOOP_UNLISTEN;
  return await listen<ConversionProgressDto>("conversion-progress", (event) => {
    callback(toConversionProgress(event.payload));
  });
}

export async function onConversionDone(
  callback: (
    outputPath: string,
    sourceFormat: string,
    stageTimings: ConversionStageBreakdown,
    warnings: string[],
  ) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) return NOOP_UNLISTEN;
  return await listen<{
    output_path: string;
    source_format: string;
    stage_timings: ConversionStageBreakdownDto;
    warnings?: string[];
  }>("conversion-done", (event) => {
    callback(
      event.payload.output_path,
      event.payload.source_format,
      toConversionStageBreakdown(event.payload.stage_timings),
      event.payload.warnings ?? [],
    );
  });
}

export async function onConversionFailed(
  callback: (message: string, cancelled: boolean) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) return NOOP_UNLISTEN;
  return await listen<{ message: string; cancelled: boolean }>("conversion-failed", (event) => {
    callback(event.payload.message, event.payload.cancelled);
  });
}

type ConversionEnd =
  | {
      kind: "done";
      outputPath: string;
      sourceFormat: string;
      stageTimings: ConversionStageBreakdown;
      warnings: string[];
    }
  | { kind: "failed"; message: string; cancelled: boolean };

async function watchConversionEnd(
  onProgress: ((progress: ConversionProgress) => void) | undefined,
): Promise<{ end: Promise<ConversionEnd>; stop: () => void }> {
  let finish: (end: ConversionEnd) => void = () => {};
  const end = new Promise<ConversionEnd>((resolve) => {
    finish = resolve;
  });
  const unlistenAll: UnlistenFn[] = [];
  const stop = () => unlistenAll.forEach((unlisten) => unlisten());
  try {
    if (onProgress) unlistenAll.push(await onConversionProgress(onProgress));
    unlistenAll.push(
      await onConversionDone((outputPath, sourceFormat, stageTimings, warnings) =>
        finish({ kind: "done", outputPath, sourceFormat, stageTimings, warnings }),
      ),
    );
    unlistenAll.push(
      await onConversionFailed((message, cancelled) => finish({ kind: "failed", message, cancelled })),
    );
  } catch (e) {
    stop();
    throw e;
  }
  return { end, stop };
}

export class TauriSource implements DataSource {
  async prepareToOpen(items: string[] | File[], options: PrepareOptions): Promise<PrepareOutcome> {
    const paths: string[] = [];
    for (const item of items) {
      if (typeof item !== "string") throw new Error("ローカルファイルの選択はWeb版でのみサポートしています");
      paths.push(item);
    }
    const watch = await watchConversionEnd(options.onProgress);
    try {
      const isMulti = paths.length !== 1;
      const started = isMulti
        ? await startMultiLasConversion(paths, options.tempDir)
        : await startLasConversion(paths[0], options.tempDir);
      if (started.kind !== "converting") return toPrepareOutcome(started, isMulti);

      options.onConverting?.();
      const end = await watch.end;
      if (end.kind !== "done") return toConversionFailureOutcome(end.message, end.cancelled);
      return {
        kind: "ready",
        path: end.outputPath,
        conversion: {
          outputName: basenameOfPath(end.outputPath),
          platform: "desktop",
          sourceFormat: end.sourceFormat,
          stageTimings: end.stageTimings,
          warnings: end.warnings,
          download: null,
        },
      };
    } finally {
      watch.stop();
    }
  }

  cancelConversion(): void {
    cancelLasConversion().catch((e: unknown) => {
      console.error("cancelLasConversion failed", e);
    });
  }

  async open(path: string): Promise<OpenedCloud> {
    const dto = await invoke<OpenCopcResponseDto>("open_copc", { path });
    return {
      cloudId: dto.generation,
      info: toCloudInfo(dto.info),
      nodes: dto.nodes.map(toHierarchyNodeInfo),
    };
  }

  async close(cloudId: number): Promise<void> {
    await invoke("close_copc", { generation: cloudId });
  }

  async readNode(cloudId: number, key: string): Promise<ArrayBuffer> {
    const segment = buildNodeRequestPath(cloudId, key);
    const url = convertFileSrc(segment, "pcv");
    const res = await fetch(url);
    if (res.status === STALE_GENERATION_HTTP_STATUS) {
      throw new StaleNodeRequestError(key);
    }
    if (!res.ok) {
      const errorMessageFromBackend = await res.text().catch(() => "");
      throw new Error(errorMessageFromBackend || `pcv://${segment} failed: ${res.status}`);
    }
    return await res.arrayBuffer();
  }
}

interface ToolResultDto {
  output_path: string;
  point_count: number;
  warnings: string[];
}

function toToolResult(dto: ToolResultDto): ToolResult {
  return { outputPath: dto.output_path, pointCount: dto.point_count, warnings: dto.warnings };
}

async function withToolProgress<T>(
  options: ToolOptions | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const callback = options?.onProgress;
  const unlisten = callback
    ? await onConversionProgress((progress) => {
        if (progress.phase === "reading") {
          callback({ pointsRead: progress.pointsRead, totalPoints: progress.totalPoints });
        }
      })
    : NOOP_UNLISTEN;
  try {
    return await run();
  } finally {
    unlisten();
  }
}

export async function extractToCopc(
  path: string,
  filter: ExtractFilter,
  options?: ToolOptions,
): Promise<ToolResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<ToolResultDto>("extract_copc", {
      path,
      filter,
      tempDir: options?.tempDir ?? null,
    });
    return toToolResult(dto);
  });
}

export async function thinCopc(path: string, request: ThinRequest, options?: ToolOptions): Promise<ToolResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<ToolResultDto>("thin_copc", { path, request, tempDir: options?.tempDir ?? null });
    return toToolResult(dto);
  });
}

export async function filterCopc(path: string, request: FilterRequest, options?: ToolOptions): Promise<ToolResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<ToolResultDto>("filter_copc", { path, request, tempDir: options?.tempDir ?? null });
    return toToolResult(dto);
  });
}

export async function mergeCopcs(paths: string[], options?: ToolOptions): Promise<ToolResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<ToolResultDto>("merge_copcs", {
      paths,
      tempDir: options?.tempDir ?? null,
    });
    return toToolResult(dto);
  });
}

export async function readSectionProfile(
  cloudId: number,
  line: SectionLineInput,
  cap: number,
): Promise<SectionPoints> {
  const buffer = await invoke<ArrayBuffer>("read_section_profile", { generation: cloudId, line, cap });
  return decodeSectionProfile(buffer);
}

interface RasterPreviewOpenDto extends RasterPreviewInfo {
  id: number;
}

export async function openRasterPreview(path: string): Promise<RasterPreviewSession> {
  const dto = await invoke<RasterPreviewOpenDto>("raster_preview_open", { path });
  return { id: dto.id, info: { heldPoints: dto.heldPoints, depth: dto.depth, truncated: dto.truncated } };
}

export async function renderRasterPreview(sessionId: number, request: RasterRequest): Promise<RasterPreviewImage> {
  const buffer = await invoke<ArrayBuffer>("raster_preview_render", { id: sessionId, options: request });
  return decodePreviewImage(buffer);
}

export async function closeRasterPreview(sessionId: number): Promise<void> {
  try {
    await invoke("raster_preview_close", { id: sessionId });
  } catch (e) {
    console.error("raster_preview_close failed", e);
  }
}

interface RasterExportDto {
  geotiff_path: string;
  width: number;
  height: number;
  warnings: string[];
}

export async function exportRasterGeoTiff(
  path: string,
  request: RasterExportRequest,
  options?: ToolOptions,
): Promise<RasterExportResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<RasterExportDto>("rasterize_copc", {
      path,
      options: request,
      tempDir: options?.tempDir ?? null,
    });
    return { width: dto.width, height: dto.height, warnings: dto.warnings, path: dto.geotiff_path, download: null };
  });
}

export async function chooseGeoTiffDestination(suggestedName: string): Promise<string | null> {
  return await saveFileDialog({
    defaultPath: suggestedName,
    filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
  });
}

export async function saveToolFile(sourcePath: string, destination: string): Promise<void> {
  await invoke("save_tool_file", { source: sourcePath, destination });
}

export async function chooseTextDestination(suggestedName: string, filterName: string, extension: string): Promise<string | null> {
  return await saveFileDialog({
    defaultPath: suggestedName,
    filters: [{ name: filterName, extensions: [extension] }],
  });
}

export async function saveTextFile(destination: string, text: string): Promise<void> {
  await invoke("save_text_file", { destination, text });
}

export async function computeSectionLine(
  cloudId: number,
  line: SectionLineInput,
  request: SectionLineRequest,
  options?: ToolOptions,
): Promise<SectionGroundLine> {
  return await withToolProgress(options, async () => {
    const buffer = await invoke<ArrayBuffer>("compute_section_line", { generation: cloudId, line, request });
    return decodeSectionLine(buffer);
  });
}

interface DtmDto {
  output_path: string;
  point_count: number;
  warnings: string[];
  geotiff_path: string | null;
  landxml_path: string | null;
  width: number;
  height: number;
  cell_size: number;
  tin_points: number;
  tin_triangles: number;
  ground_points: number;
}

export async function dtmCopc(path: string, request: DtmRequest, options?: ToolOptions): Promise<DtmResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<DtmDto>("dtm_copc", { path, request, tempDir: options?.tempDir ?? null });
    const stem = basenameOfPath(path).replace(/(\.copc)?\.laz$/i, "");
    const file = (savedPath: string | null, extension: string): DtmFile | null =>
      savedPath === null ? null : { fileName: `${stem}-dtm.${extension}`, path: savedPath, downloadUrl: null };
    return {
      outputPath: dto.output_path,
      pointCount: dto.point_count,
      warnings: dto.warnings,
      dtm: {
        cellSize: dto.cell_size,
        width: dto.width,
        height: dto.height,
        tinPoints: dto.tin_points,
        tinTriangles: dto.tin_triangles,
        groundPoints: dto.ground_points,
        geotiff: file(dto.geotiff_path, "tif"),
        landxml: file(dto.landxml_path, "xml"),
      },
    };
  });
}

export async function chooseLandXmlDestination(suggestedName: string): Promise<string | null> {
  return await saveFileDialog({
    defaultPath: suggestedName,
    filters: [{ name: "LandXML", extensions: ["xml"] }],
  });
}
