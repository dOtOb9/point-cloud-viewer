// The DTM tool's request (G1-T15), as pure functions (no React): the dialog holds the CSF values in the DISPLAY unit
// (m or ft); this file turns them into metres and then into the file's unit (the one place that knows the presets is
// src/app/csf-params.ts). The dialog only shows these; `makeDtm` (src/app/point-cloud-tools.ts) sends the request.
import type { DtmOutputOptions, DtmRequest, LandXmlUnit } from "../datasource/dtm";
import type { SectionLinePreset } from "../datasource/section-line";
import { displayLengthToFile } from "../state/tool-math";
import { INTERNATIONAL_FOOT_IN_METERS, metersToDisplay, type DisplayUnit, type LengthUnits } from "../state/units";
import type { DtmOutputSetting } from "../state/dtm-setting";
import { CSF_PRESETS_METRES, csfParamsInFileUnits, type CsfParamsInMetres } from "./csf-params";

/** The dialog's presets. "custom" is what the detail fields hold after the user changes one. */
export type DtmPreset = SectionLinePreset | "custom";

/** Default side of a DTM cell, in metres (owner's plan 2.2). */
export const DTM_DEFAULT_CELL_SIZE_M = 0.5;

/** The CSF values of a preset, with the lengths in the display unit (for the detail fields). */
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

/** Display unit -> metres, for every length of the CSF values. */
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

/** True when the values are the preset's values (the dialog shows "標準" / "急勾配" then, "カスタム" otherwise). */
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

/** The `Units` of LandXML for the file's horizontal unit (metres per unit). `unknown` writes no `Units` element. */
export function landXmlUnitFor(horizontalToMeter: number | null): LandXmlUnit {
  if (horizontalToMeter === null) return "unknown";
  const near = (target: number) => Math.abs(horizontalToMeter - target) < 1e-8; // the two feet differ by 6e-7
  if (near(1)) return "meter";
  if (near(INTERNATIONAL_FOOT_IN_METERS)) return "foot";
  if (near(1200 / 3937)) return "usSurveyFoot";
  return "unknown";
}

/** The files to make, from the settings page's choice. */
export function dtmOutputOptionsFor(setting: DtmOutputSetting, units: LengthUnits): DtmOutputOptions {
  return {
    geotiff: setting.format !== "landxml",
    landxml: setting.format !== "geotiff",
    tiff: setting.tiff,
    unit: landXmlUnitFor(units.horizontalToMeter),
  };
}

/** What the dialog holds. Lengths are in the display unit. */
export interface DtmDialogValues {
  csf: CsfParamsInMetres;
  cellSize: number;
}

/**
 * The request for Rust: lengths in the file's unit. `warning` is set when a unit of the file is unknown (the values are
 * then used as they are, like the section line does).
 */
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
    },
    warning,
  };
}
