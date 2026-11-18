import type { CsfParamsInFileUnits, SectionLinePreset, SectionLineRequest } from "../datasource/section-line";

export type CsfParamsInMetres = CsfParamsInFileUnits;

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
    clothResolution: 0.25,
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

export const SECTION_CORRIDOR_HALF_WIDTH_M = 20;

export interface FileUnitsInMetres {
  horizontalToMeter: number | null;
  verticalToMeter: number | null;
}

export const UNKNOWN_UNIT_CSF_WARNING =
  "座標の単位が分からないため、CSF の長さ（m で決めた値）をそのままファイルの単位として使います";

export interface ConvertedCsfParams {
  params: CsfParamsInFileUnits;
  warning: string | null;
}

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

export function sectionLineRequestFor(
  preset: SectionLinePreset,
  units: FileUnitsInMetres,
): { request: SectionLineRequest; warning: string | null } {
  const { params, warning } = csfParamsInFileUnits(CSF_PRESETS_METRES[preset], units);
  const corridor = units.horizontalToMeter === null ? SECTION_CORRIDOR_HALF_WIDTH_M : SECTION_CORRIDOR_HALF_WIDTH_M / units.horizontalToMeter;
  return { request: { corridorHalfWidth: corridor, csf: params }, warning };
}
