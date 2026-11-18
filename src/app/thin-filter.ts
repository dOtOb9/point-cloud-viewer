import type { CloudInfo } from "../datasource/DataSource";
import type { FilterRequest, GridKeep, ThinRequest } from "../datasource/thin-filter";
import { convertLength, metersToDisplay, type DisplayUnit, type LengthUnits } from "../state/units";
import { displayLengthToFile } from "../state/tool-math";

export const THIN_FILTER_PRESETS = {
  thin: {
    sizeMeters: 0.1,
    method: "grid" as ThinMethod,
    keep: "nearestCentre" as GridKeep,
  },
  ror: {
    radiusMeters: 0.5,
    minNeighbors: 4,
  },
  sor: {
    k: 8,
    nSigma: 2.0,
    searchRadiusOverSpacing: 10,
  },
} as const;

export type ThinMethod = "grid" | "voxel";
export type FilterMethod = "ror" | "sor";

export interface ThinDialogValues {
  method: ThinMethod;
  size: number;
  keep: GridKeep;
}

export interface FilterDialogValues {
  method: FilterMethod;
  radius: number;
  minNeighbors: number;
  k: number;
  nSigma: number;
  searchRadius: number;
}

export function estimatePointSpacing(info: Pick<CloudInfo, "pointCount" | "min" | "max">): number | null {
  const width = info.max[0] - info.min[0];
  const height = info.max[1] - info.min[1];
  const area = width * height;
  if (!(info.pointCount > 0) || !(area > 0) || !Number.isFinite(area)) return null;
  return Math.sqrt(area / info.pointCount);
}

export function presetLengthInDisplay(meters: number, display: DisplayUnit): number {
  return metersToDisplay(meters, display);
}

export function defaultSorSearchRadius(info: CloudInfo, units: LengthUnits): number {
  const fallback = presetLengthInDisplay(THIN_FILTER_PRESETS.ror.radiusMeters * 10, units.display);
  const spacing = estimatePointSpacing(info);
  if (spacing === null) return fallback;
  const inDisplay = convertLength(spacing * THIN_FILTER_PRESETS.sor.searchRadiusOverSpacing, units.horizontalToMeter, units.display);
  return inDisplay === null ? fallback : inDisplay;
}

export function thinRequestFor(values: ThinDialogValues, units: LengthUnits): ThinRequest {
  const size = displayLengthToFile(values.size, units.horizontalToMeter, units.display);
  return values.method === "voxel" ? { kind: "voxel", size } : { kind: "grid", size, keep: values.keep };
}

export function filterRequestFor(values: FilterDialogValues, units: LengthUnits): FilterRequest {
  if (values.method === "ror") {
    return {
      kind: "ror",
      radius: displayLengthToFile(values.radius, units.horizontalToMeter, units.display),
      minNeighbors: values.minNeighbors,
    };
  }
  return {
    kind: "sor",
    k: values.k,
    nSigma: values.nSigma,
    searchRadius: displayLengthToFile(values.searchRadius, units.horizontalToMeter, units.display),
  };
}
