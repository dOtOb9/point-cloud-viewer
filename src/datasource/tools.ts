export interface ScreenPolygonFilter {
  kind: "screenPolygon";
  viewProj: number[];
  polygonNdc: [number, number][];
}

export interface OrientedBoxFilter {
  kind: "orientedBox";
  center: [number, number, number];
  axes: [[number, number, number], [number, number, number], [number, number, number]];
  halfExtents: [number, number, number];
}

export type ExtractFilter = ScreenPolygonFilter | OrientedBoxFilter;

export interface ToolResult {
  outputPath: string;
  pointCount: number;
  warnings: string[];
}

export interface ToolProgress {
  pointsRead: number;
  totalPoints: number;
}

export interface ToolOptions {
  onProgress?: (progress: ToolProgress) => void;
  tempDir?: string | null;
}

