// CSF (cloth simulation filter) parameters, as the owner states them: always in METRES. Rust takes the file's unit, so
// every tool that runs CSF (the section line now, the DTM tool later) converts here, in one place, with the layer's CRS
// factors: the horizontal factor for the cloth spacing, the vertical factor for the heights (class thresholds,
// `hdiff`, the convergence step). Pure functions, no React (TaskSheets/ADR-0021-thin-react.md).
import type { CsfParamsInFileUnits, SectionLinePreset, SectionLineRequest } from "../datasource/section-line";

/** CSF parameters with lengths in metres. Meanings: `CsfParams` in `crates/pcv-core/src/csf.rs`. */
export type CsfParamsInMetres = CsfParamsInFileUnits;

/** The owner's presets (plan 2.2): standard and steep terrain. Same numbers as `CsfParams::standard` / `steep` in Rust. */
export const CSF_PRESETS_METRES: Record<SectionLinePreset, CsfParamsInMetres> = {
  standard: {
    clothResolution: 0.5,
    rigidness: 3,
    timeStep: 0.65,
    classThresholdUpper: 0.1,
    classThresholdLower: 1.0,
    iterations: 500,
    slopeSmooth: true,
    hdiff: 0.3,
    convergenceThreshold: 0.005,
  },
  steep: {
    clothResolution: 0.5,
    rigidness: 1,
    timeStep: 0.65,
    classThresholdUpper: 0.1,
    classThresholdLower: 1.0,
    iterations: 1500,
    slopeSmooth: true,
    hdiff: 0.3,
    convergenceThreshold: 0.005,
  },
};

/** Half width of the corridor the section line reads on each side of the line, in metres (plan 8.3). */
export const SECTION_CORRIDOR_HALF_WIDTH_M = 20;

/** The file's units in metres per file unit; `null` when the CRS does not say. */
export interface FileUnitsInMetres {
  horizontalToMeter: number | null;
  verticalToMeter: number | null;
}

export const UNKNOWN_UNIT_CSF_WARNING =
  "座標の単位が分からないため、CSF の長さ（m で決めた値）をそのままファイルの単位として使います";

export interface ConvertedCsfParams {
  params: CsfParamsInFileUnits;
  /** Set when a unit was unknown and the metre values were used as they are (for the error log). */
  warning: string | null;
}

/**
 * Metres to the file's unit: `clothResolution` with the horizontal factor, `classThreshold*`, `hdiff` and
 * `convergenceThreshold` with the vertical factor (a length in file units = metres / (metres per file unit)). A unit
 * that is unknown (`null`) leaves those values as they are and sets `warning`, like the other tools' unknown-unit handling.
 */
export function csfParamsInFileUnits(metres: CsfParamsInMetres, units: FileUnitsInMetres): ConvertedCsfParams {
  const h = units.horizontalToMeter;
  const v = units.verticalToMeter;
  const toFile = (value: number, toMeter: number | null) => (toMeter === null ? value : value / toMeter);
  return {
    params: {
      ...metres,
      clothResolution: toFile(metres.clothResolution, h),
      classThresholdUpper: toFile(metres.classThresholdUpper, v),
      classThresholdLower: toFile(metres.classThresholdLower, v),
      hdiff: toFile(metres.hdiff, v),
      convergenceThreshold: toFile(metres.convergenceThreshold, v),
    },
    warning: h === null || v === null ? UNKNOWN_UNIT_CSF_WARNING : null,
  };
}

/** The request of the section line for a preset: CSF parameters and the 20 m corridor, in the file's unit. */
export function sectionLineRequestFor(
  preset: SectionLinePreset,
  units: FileUnitsInMetres,
): { request: SectionLineRequest; warning: string | null } {
  const { params, warning } = csfParamsInFileUnits(CSF_PRESETS_METRES[preset], units);
  const corridor = units.horizontalToMeter === null ? SECTION_CORRIDOR_HALF_WIDTH_M : SECTION_CORRIDOR_HALF_WIDTH_M / units.horizontalToMeter;
  return { request: { corridorHalfWidth: corridor, csf: params }, warning };
}
