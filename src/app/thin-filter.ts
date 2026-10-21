// Thinning and outlier filters (G3): the preset values, the estimate of the SOR search range, and the conversion of the
// dialogs' values (typed in the display unit, m or ft) into the requests Rust takes (the file's unit).
// Pure functions and constants, no React (TaskSheets/ADR-0021-thin-react.md). The dialogs only show these.
import type { CloudInfo } from "../datasource/DataSource";
import type { FilterRequest, GridKeep, ThinRequest } from "../datasource/thin-filter";
import { convertLength, metersToDisplay, type DisplayUnit, type LengthUnits } from "../state/units";
import { displayLengthToFile } from "../state/tool-math";

/**
 * The preset (default) values, in ONE table. Lengths are in METRES (the owner states them in metres; the dialog shows
 * them in the display unit, so 0.1 m reads as 0.33 ft when the display is feet).
 */
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
    /** The search range R is this many times the estimated point spacing (G3-T7: "several times the spacing or more"). */
    searchRadiusOverSpacing: 10,
  },
} as const;

export type ThinMethod = "grid" | "voxel";
export type FilterMethod = "ror" | "sor";

/** What the thinning dialog holds. Lengths are in the display unit. */
export interface ThinDialogValues {
  method: ThinMethod;
  size: number;
  /** Only used by the grid; the voxel always keeps the point nearest to the centre. */
  keep: GridKeep;
}

/** What the filter dialog holds. Lengths are in the display unit. */
export interface FilterDialogValues {
  method: FilterMethod;
  radius: number;
  minNeighbors: number;
  k: number;
  nSigma: number;
  searchRadius: number;
}

/**
 * The average distance between neighbouring points, in the file's unit: sqrt(XY area / point count). The area is the
 * header's bounding rectangle, so a cloud that fills only part of it (a long thin road) gets a spacing that is too
 * large. It is an estimate for a default value, nothing more. null when it cannot be computed.
 */
export function estimatePointSpacing(info: Pick<CloudInfo, "pointCount" | "min" | "max">): number | null {
  const width = info.max[0] - info.min[0];
  const height = info.max[1] - info.min[1];
  const area = width * height;
  if (!(info.pointCount > 0) || !(area > 0) || !Number.isFinite(area)) return null;
  return Math.sqrt(area / info.pointCount);
}

/** The preset sizes in the display unit (the fixed preset in metres, shown in m or ft). */
export function presetLengthInDisplay(meters: number, display: DisplayUnit): number {
  return metersToDisplay(meters, display);
}

/**
 * The default SOR search range in the display unit: `searchRadiusOverSpacing` times the estimated point spacing.
 * Falls back to ten times the ROR radius preset when the spacing cannot be estimated or the file's unit is unknown.
 */
export function defaultSorSearchRadius(info: CloudInfo, units: LengthUnits): number {
  const fallback = presetLengthInDisplay(THIN_FILTER_PRESETS.ror.radiusMeters * 10, units.display);
  const spacing = estimatePointSpacing(info);
  if (spacing === null) return fallback;
  const inDisplay = convertLength(spacing * THIN_FILTER_PRESETS.sor.searchRadiusOverSpacing, units.horizontalToMeter, units.display);
  return inDisplay === null ? fallback : inDisplay;
}

/** The request for thinning: the size is converted from the display unit to the file's unit. */
export function thinRequestFor(values: ThinDialogValues, units: LengthUnits): ThinRequest {
  const size = displayLengthToFile(values.size, units.horizontalToMeter, units.display);
  return values.method === "voxel" ? { kind: "voxel", size } : { kind: "grid", size, keep: values.keep };
}

/** The request for a filter: the radius and the search range are converted to the file's unit. */
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
