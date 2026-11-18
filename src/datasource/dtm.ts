import type { CsfParamsInFileUnits } from "./section-line";
import type { TiffKind } from "./raster";
import type { ToolResult } from "./tools";

export type LandXmlUnit = "meter" | "foot" | "usSurveyFoot" | "unknown";

export interface DtmOutputOptions {
  geotiff: boolean;
  landxml: boolean;
  tiff: TiffKind;
  unit: LandXmlUnit;
}

export interface DtmRequest {
  csf: CsfParamsInFileUnits;
  cellSize: number;
  output: DtmOutputOptions;
  displayUnit: DtmDisplayUnit;
}

export interface DtmDisplayUnit {
  symbol: "m" | "ft";
  fileUnitsPerDisplayUnit: number | null;
}

export interface DtmFile {
  fileName: string;
  path: string | null;
  downloadUrl: string | null;
}

export interface DtmInfo {
  cellSize: number;
  width: number;
  height: number;
  tinPoints: number;
  tinTriangles: number;
  groundPoints: number;
  geotiff: DtmFile | null;
  landxml: DtmFile | null;
}

export interface DtmResult extends ToolResult {
  dtm: DtmInfo;
}
