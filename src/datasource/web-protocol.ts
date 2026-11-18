import type { CloudInfoDto, HierarchyNodeDto } from "./copc-dto";
import type { ConversionProgressDto, ConversionStageBreakdownDto } from "./conversion-dto";
import type { ExtractFilter } from "./tools";
import type { FilterRequest, ThinRequest } from "./thin-filter";
import type { DtmRequest } from "./dtm";
import type { RasterExportRequest, RasterPreviewInfo, RasterRequest } from "./raster";
import type { SectionLineInput } from "./section-profile";
import type { SectionLineRequest } from "./section-line";

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
  generation: number;
}

export interface ConvertStartRequest {
  type: "convertStart";
  id: number;
  file: File;
  maxPointsPerNode: number;
  isMobile: boolean;
}

export interface ConvertMultiStartRequest {
  type: "convertMultiStart";
  id: number;
  files: File[];
  maxPointsPerNode: number;
  isMobile: boolean;
}

export type PointFileFormat = "lasLaz" | "pcd" | "ply" | "e57";

export interface PointFileConvertStartRequest {
  type: "pointFileConvertStart";
  id: number;
  files: File[];
  formats: PointFileFormat[];
  maxPointsPerNode: number;
  isMobile: boolean;
}

export interface ConvertCancelRequest {
  type: "convertCancel";
  id: number;
}

export interface CloseRequest {
  type: "close";
  id: number;
  cloudId: number;
}

export interface SectionProfileRequest {
  type: "sectionProfile";
  id: number;
  cloudId: number;
  line: SectionLineInput;
  cap: number;
}

export interface SectionProfileResponse {
  type: "section-profile-result";
  id: number;
  ok: true;
  buffer: ArrayBuffer;
}

export function buildSectionProfileRequest(
  id: number,
  cloudId: number,
  line: SectionLineInput,
  cap: number,
): SectionProfileRequest {
  return { type: "sectionProfile", id, cloudId, line, cap };
}

export type WorkerRequest =
  | SectionProfileRequest
  | SectionLineStartRequest
  | RasterStartRequest
  | RasterPreviewOpenRequest
  | RasterPreviewRenderRequest
  | RasterPreviewCloseRequest
  | ExtractStartRequest
  | ThinStartRequest
  | FilterStartRequest
  | DtmStartRequest
  | ToolMergeStartRequest
  | OpenRequest
  | ReadNodeRequest
  | CloseRequest
  | ConvertStartRequest
  | ConvertMultiStartRequest
  | PointFileConvertStartRequest
  | ConvertCancelRequest;

export interface OpenResponse {
  type: "open-result";
  id: number;
  ok: true;
  info: CloudInfoDto;
  nodes: HierarchyNodeDto[];
  bytesRead: number;
  generation: number;
}

export interface CloseResponse {
  type: "close-result";
  id: number;
  ok: true;
}

export interface ReadNodeResponse {
  type: "readNode-result";
  id: number;
  ok: true;
  buffer: ArrayBuffer;
  bytesRead: number;
}

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

export interface ConvertProgressResponse {
  type: "convert-progress";
  id: number;
  progress: ConversionProgressDto;
}

export interface ConvertDoneResponse {
  type: "convert-done";
  id: number;
  outputName: string;
  suggestedFileName: string;
  pointCount: number;
  stageTimings: ConversionStageBreakdownDto;
  warnings?: string[];
}

export interface ConvertFailedResponse {
  type: "convert-failed";
  id: number;
  message: string;
  cancelled: boolean;
}

export type WorkerResponse =
  | SectionProfileResponse
  | SectionLineProgressResponse
  | SectionLineDoneResponse
  | SectionLineFailedResponse
  | ToolProgressResponse
  | ToolDoneResponse
  | ToolFailedResponse
  | RasterDoneResponse
  | RasterPreviewOpenResponse
  | RasterPreviewImageResponse
  | RasterPreviewClosedResponse
  | OpenResponse
  | ReadNodeResponse
  | ReadNodeStaleResponse
  | CloseResponse
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

export function buildCloseRequest(id: number, cloudId: number): CloseRequest {
  return { type: "close", id, cloudId };
}

export function buildReadNodeRequest(id: number, key: string, generation: number): ReadNodeRequest {
  return { type: "readNode", id, key, generation };
}

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

export function buildConvertMultiStartRequest(
  id: number,
  files: File[],
  isMobile: boolean,
  maxPointsPerNode: number = DEFAULT_MAX_POINTS_PER_NODE,
): ConvertMultiStartRequest {
  return { type: "convertMultiStart", id, files, maxPointsPerNode, isMobile };
}

export function buildPointFileConvertStartRequest(
  id: number,
  files: File[],
  formats: PointFileFormat[],
  isMobile: boolean,
  maxPointsPerNode: number = DEFAULT_MAX_POINTS_PER_NODE,
): PointFileConvertStartRequest {
  return { type: "pointFileConvertStart", id, files, formats, maxPointsPerNode, isMobile };
}

export interface ExtractStartRequest {
  type: "extractStart";
  id: number;
  file: File;
  filter: ExtractFilter;
  label: string;
}

export interface ToolMergeStartRequest {
  type: "toolMergeStart";
  id: number;
  files: File[];
  isMobile: boolean;
  label: string;
}

export interface ToolProgressResponse {
  type: "tool-progress";
  id: number;
  pointsRead: number;
  totalPoints: number;
}

export interface ToolDoneResponse {
  type: "tool-done";
  id: number;
  outputName: string;
  pointCount: number;
  warnings: string[];
  dtm?: DtmDoneFiles;
}

export interface ToolFailedResponse {
  type: "tool-failed";
  id: number;
  message: string;
  cancelled: boolean;
}

export function buildExtractStartRequest(
  id: number,
  file: File,
  filter: ExtractFilter,
  label: string,
): ExtractStartRequest {
  return { type: "extractStart", id, file, filter, label };
}

export interface ThinStartRequest {
  type: "thinStart";
  id: number;
  file: File;
  request: ThinRequest;
  label: string;
}

export interface FilterStartRequest {
  type: "filterStart";
  id: number;
  file: File;
  request: FilterRequest;
  label: string;
}

export function buildThinStartRequest(id: number, file: File, request: ThinRequest, label: string): ThinStartRequest {
  return { type: "thinStart", id, file, request, label };
}

export function buildFilterStartRequest(
  id: number,
  file: File,
  request: FilterRequest,
  label: string,
): FilterStartRequest {
  return { type: "filterStart", id, file, request, label };
}

export interface DtmStartRequest {
  type: "dtmStart";
  id: number;
  file: File;
  request: DtmRequest;
  label: string;
}

export function buildDtmStartRequest(id: number, file: File, request: DtmRequest, label: string): DtmStartRequest {
  return { type: "dtmStart", id, file, request, label };
}

export interface DtmDoneFiles {
  geotiff: Uint8Array | null;
  landxml: Uint8Array | null;
  width: number;
  height: number;
  cellSize: number;
  tinPoints: number;
  tinTriangles: number;
  groundPoints: number;
}

export interface RasterStartRequest {
  type: "rasterStart";
  id: number;
  file: File;
  options: RasterExportRequest;
}

export function buildRasterStartRequest(id: number, file: File, options: RasterExportRequest): RasterStartRequest {
  return { type: "rasterStart", id, file, options };
}

export interface RasterDoneResponse {
  type: "raster-done";
  id: number;
  geotiff: Uint8Array;
  width: number;
  height: number;
  warnings: string[];
}

export interface RasterPreviewOpenRequest {
  type: "rasterPreviewOpen";
  id: number;
  file: File;
}

export function buildRasterPreviewOpenRequest(id: number, file: File): RasterPreviewOpenRequest {
  return { type: "rasterPreviewOpen", id, file };
}

export function buildRasterPreviewRenderRequest(id: number, sessionId: number, options: RasterRequest): RasterPreviewRenderRequest {
  return { type: "rasterPreviewRender", id, sessionId, options };
}

export function buildRasterPreviewCloseRequest(id: number, sessionId: number): RasterPreviewCloseRequest {
  return { type: "rasterPreviewClose", id, sessionId };
}

export interface RasterPreviewOpenResponse {
  type: "raster-preview-open-result";
  id: number;
  info: RasterPreviewInfo;
}

export interface RasterPreviewRenderRequest {
  type: "rasterPreviewRender";
  id: number;
  sessionId: number;
  options: RasterRequest;
}

export interface RasterPreviewImageResponse {
  type: "raster-preview-image";
  id: number;
  buffer: ArrayBuffer;
}

export interface RasterPreviewCloseRequest {
  type: "rasterPreviewClose";
  id: number;
  sessionId: number;
}

export interface RasterPreviewClosedResponse {
  type: "raster-preview-closed";
  id: number;
}

export function buildToolMergeStartRequest(
  id: number,
  files: File[],
  isMobile: boolean,
  label: string,
): ToolMergeStartRequest {
  return { type: "toolMergeStart", id, files, isMobile, label };
}

export interface SectionLineStartRequest {
  type: "sectionLineStart";
  id: number;
  cloudId: number;
  line: SectionLineInput;
  request: SectionLineRequest;
}

export interface SectionLineProgressResponse {
  type: "section-line-progress";
  id: number;
  fraction: number;
}

export interface SectionLineDoneResponse {
  type: "section-line-done";
  id: number;
  buffer: ArrayBuffer;
}

export interface SectionLineFailedResponse {
  type: "section-line-failed";
  id: number;
  message: string;
  cancelled: boolean;
}

export function buildSectionLineStartRequest(
  id: number,
  cloudId: number,
  line: SectionLineInput,
  request: SectionLineRequest,
): SectionLineStartRequest {
  return { type: "sectionLineStart", id, cloudId, line, request };
}
