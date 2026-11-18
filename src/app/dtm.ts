import type { DtmOutputOptions, DtmRequest, LandXmlUnit } from "../datasource/dtm";
import type { SectionLinePreset } from "../datasource/section-line";
import { displayLengthToFile } from "../state/tool-math";
import { INTERNATIONAL_FOOT_IN_METERS, metersToDisplay, type DisplayUnit, type LengthUnits } from "../state/units";
import type { DtmOutputSetting } from "../state/dtm-setting";
import { CSF_PRESETS_METRES, csfParamsInFileUnits, type CsfParamsInMetres } from "./csf-params";

export type DtmPreset = SectionLinePreset | "custom";

export const DTM_DEFAULT_CELL_SIZE_M = 0.5;

export function csfPresetInDisplay(preset: SectionLinePreset, display: DisplayUnit): CsfParamsInMetres {
  const m = CSF_PRESETS_METRES[preset];
  return {
    ...m,
    clothResolution: metersToDisplay(m.clothResolution, display),
    classThresholdUpper: metersToDisplay(m.classThresholdUpper, display),
    classThresholdLower: metersToDisplay(m.classThresholdLower, display),
    hdiff: metersToDisplay(m.hdiff, display),
    convergenceThreshold: metersToDisplay(m.convergenceThreshold, display),
  };
}

function csfDisplayToMetres(values: CsfParamsInMetres, display: DisplayUnit): CsfParamsInMetres {
  const toM = (v: number) => (display === "foot" ? v * INTERNATIONAL_FOOT_IN_METERS : v);
  return {
    ...values,
    clothResolution: toM(values.clothResolution),
    classThresholdUpper: toM(values.classThresholdUpper),
    classThresholdLower: toM(values.classThresholdLower),
    hdiff: toM(values.hdiff),
    convergenceThreshold: toM(values.convergenceThreshold),
  };
}

export function presetOf(values: CsfParamsInMetres, display: DisplayUnit): DtmPreset {
  const same = (a: CsfParamsInMetres, b: CsfParamsInMetres) =>
    (Object.keys(a) as (keyof CsfParamsInMetres)[]).every((k) =>
      typeof a[k] === "number" && typeof b[k] === "number" ? Math.abs((a[k] as number) - (b[k] as number)) < 1e-9 : a[k] === b[k],
    );
  for (const preset of ["standard", "steep"] as const) {
    if (same(values, csfPresetInDisplay(preset, display))) return preset;
  }
  return "custom";
}

const UNIT_FACTOR_TOLERANCE = 1e-8;

export function landXmlUnitFor(horizontalToMeter: number | null): LandXmlUnit {
  if (horizontalToMeter === null) return "unknown";
  const near = (target: number) =>
    Math.abs(horizontalToMeter - target) < UNIT_FACTOR_TOLERANCE;
  if (near(1)) return "meter";
  if (near(INTERNATIONAL_FOOT_IN_METERS)) return "foot";
  if (near(1200 / 3937)) return "usSurveyFoot";
  return "unknown";
}

export function dtmOutputOptionsFor(setting: DtmOutputSetting, units: LengthUnits): DtmOutputOptions {
  return {
    geotiff: setting.format !== "landxml",
    landxml: setting.format !== "geotiff",
    tiff: setting.tiff,
    unit: landXmlUnitFor(units.horizontalToMeter),
  };
}

export interface DtmDialogValues {
  csf: CsfParamsInMetres;
  cellSize: number;
}

export function dtmRequestFor(
  values: DtmDialogValues,
  units: LengthUnits,
  output: DtmOutputSetting,
): { request: DtmRequest; warning: string | null } {
  const metres = csfDisplayToMetres(values.csf, units.display);
  const { params, warning } = csfParamsInFileUnits(metres, units);
  return {
    request: {
      csf: params,
      cellSize: displayLengthToFile(values.cellSize, units.horizontalToMeter, units.display),
      output: dtmOutputOptionsFor(output, units),
      displayUnit: {
        symbol: units.display === "foot" ? "ft" : "m",
        fileUnitsPerDisplayUnit: units.horizontalToMeter === null ? null : displayLengthToFile(1, units.horizontalToMeter, units.display),
      },
    },
    warning,
  };
}
