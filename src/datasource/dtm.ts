// G1-T15: types of the DTM tool, the same shape on desktop (tauri.ts) and Web (web.ts).
// The Rust types are `DtmRequest` / `DtmOutputOptions` in `crates/pcv-core/src/dtm.rs`.
import type { CsfParamsInFileUnits } from "./section-line";
import type { TiffKind } from "./raster";
import type { ToolResult } from "./tools";

/** The unit written into LandXML (`Units`). `unknown` writes no `Units` element. */
export type LandXmlUnit = "meter" | "foot" | "usSurveyFoot" | "unknown";

/** Which files to make (the setting "DTM の出力形式"). */
export interface DtmOutputOptions {
  geotiff: boolean;
  landxml: boolean;
  tiff: TiffKind;
  /** The file's horizontal unit. */
  unit: LandXmlUnit;
}

/** What the DTM tool asks for. Lengths are in the file's unit (`src/app/dtm.ts` converts them). */
export interface DtmRequest {
  csf: CsfParamsInFileUnits;
  /** Side of a DTM cell. */
  cellSize: number;
  output: DtmOutputOptions;
  /** The unit on screen, so the cap messages from Rust can name a size the way the user typed it. */
  displayUnit: DtmDisplayUnit;
}

/** The unit shown on screen. "fileUnitsPerDisplayUnit" is null when the file's unit is unknown. */
export interface DtmDisplayUnit {
  symbol: "m" | "ft";
  fileUnitsPerDisplayUnit: number | null;
}

/** One file the tool made: on disk in the temp folder (desktop) or a download (Web). */
export interface DtmFile {
  /** The name to suggest when saving. */
  fileName: string;
  /** Desktop: the file in the temp folder (copy it where the user chose with `saveToolFile`). */
  path: string | null;
  /** Web: an object URL. */
  downloadUrl: string | null;
}

/** What is kept on the new layer (`ViewerLayer.dtm`). */
export interface DtmInfo {
  /** The DTM grid: cell size in the file's unit, columns and rows. */
  cellSize: number;
  width: number;
  height: number;
  /** TIN vertices (cells that held a ground point) and triangles. */
  tinPoints: number;
  tinTriangles: number;
  /** Points CSF classified as ground. */
  groundPoints: number;
  geotiff: DtmFile | null;
  landxml: DtmFile | null;
}

/** The result of the tool: the classified point cloud (`ToolResult`) and the DTM files. */
export interface DtmResult extends ToolResult {
  dtm: DtmInfo;
}
