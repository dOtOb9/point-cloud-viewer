import type { ConversionProgress, ConversionStageBreakdown } from "./conversion-dto";

export interface CrsInfo {
  epsg?: number;
  name: string;
  kind: "plane-rectangular" | "utm" | "other" | "none";
  error?: string;
  horizontalUnitToMeter?: number;
  verticalUnitToMeter?: number;
}

export interface CloudInfo {
  pointCount: number;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  scale: readonly [number, number, number];
  offset: readonly [number, number, number];
  hasColor: boolean;
  crs: CrsInfo;
}

export interface HierarchyNodeInfo {
  key: string;
  pointCount: number;
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
}

export interface OpenedCloud {
  cloudId: number;
  info: CloudInfo;
  nodes: HierarchyNodeInfo[];
}

export interface NodeReader {
  readNode(key: string): Promise<ArrayBuffer>;
}

export interface PrepareOptions {
  tempDir: string | null;
  isMobile: boolean;
  onConverting?: () => void;
  onProgress?: (progress: ConversionProgress) => void;
}

export interface ConversionResult {
  outputName: string;
  platform: "web" | "desktop";
  sourceFormat: string;
  stageTimings: ConversionStageBreakdown;
  warnings: string[];
  download: { url: string; fileName: string } | null;
}

export type PrepareOutcome =
  | { kind: "ready"; path: string; conversion: ConversionResult | null }
  | { kind: "failed"; summary: string; details: string }
  | { kind: "cancelled" };

export interface DataSource {
  open(path: string): Promise<OpenedCloud>;

  prepareToOpen(items: string[] | File[], options: PrepareOptions): Promise<PrepareOutcome>;

  cancelConversion(): void;

  readNode(cloudId: number, key: string): Promise<ArrayBuffer>;

  close(cloudId: number): Promise<void>;
}
