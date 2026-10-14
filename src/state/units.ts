// L2-D: length units for display. Pure functions only (no React, no localStorage).
//
// Rule (owner decision 2026-10-15): lengths are shown in meters by default, or in feet if the
// user chooses. The file's coordinates are in the CRS length unit (for example international
// feet for EPSG:2992), so a value is first converted to meters with the factor the Rust side
// reads from the WKT (`CrsInfo.horizontalUnitToMeter` / `verticalUnitToMeter`), then to the
// display unit. The horizontal and vertical factors can differ (autzen: horizontal international
// foot 0.3048, vertical US survey foot 0.3048006096), so they are kept separate.
// When a factor is unknown (null) we never convert: the raw number is shown with the note
// "座標の単位（m かどうか不明）" instead of pretending it is meters.

import type { CrsInfo } from "../datasource/DataSource";

export type DisplayUnit = "meter" | "foot";

export const DEFAULT_DISPLAY_UNIT: DisplayUnit = "meter";

/** The display "foot" is the international foot (exactly 0.3048 m), as the owner decided. */
export const INTERNATIONAL_FOOT_IN_METERS = 0.3048;

/** Note used instead of a unit when the file's unit is unknown (the number is not converted). */
export const UNKNOWN_UNIT_NOTE = "座標の単位（m かどうか不明）";

/** Conversion factors of one file, plus the unit to display. A null factor means "unknown". */
export interface LengthUnits {
  horizontalToMeter: number | null;
  verticalToMeter: number | null;
  display: DisplayUnit;
}

export function lengthUnitsFor(crs: CrsInfo | null | undefined, display: DisplayUnit): LengthUnits {
  return {
    horizontalToMeter: crs?.horizontalUnitToMeter ?? null,
    verticalToMeter: crs?.verticalUnitToMeter ?? null,
    display,
  };
}

/** "m" or "ft". */
export function unitSymbol(display: DisplayUnit): string {
  return display === "foot" ? "ft" : "m";
}

/** Meters -> the display unit. */
export function metersToDisplay(meters: number, display: DisplayUnit): number {
  return display === "foot" ? meters / INTERNATIONAL_FOOT_IN_METERS : meters;
}

/** A length in file units -> the display unit. Returns null when the factor is unknown (no conversion). */
export function convertLength(value: number, toMeter: number | null, display: DisplayUnit): number | null {
  if (toMeter === null) return null;
  return metersToDisplay(value * toMeter, display);
}

/** An area in file units squared -> the display unit squared. null when the factor is unknown. */
export function convertArea(value: number, toMeter: number | null, display: DisplayUnit): number | null {
  if (toMeter === null) return null;
  const squareMeters = value * toMeter * toMeter;
  return display === "foot" ? squareMeters / (INTERNATIONAL_FOOT_IN_METERS * INTERNATIONAL_FOOT_IN_METERS) : squareMeters;
}

function fixed(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Format a length. With a known factor: "1,044.31 m". With an unknown factor the raw number
 * is shown with the unknown-unit note (never labeled m).
 */
export function formatLength(value: number, toMeter: number | null, display: DisplayUnit, digits = 2): string {
  const converted = convertLength(value, toMeter, display);
  return converted === null ? `${fixed(value, digits)} ${UNKNOWN_UNIT_NOTE}` : `${fixed(converted, digits)} ${unitSymbol(display)}`;
}

/** Format an area: "1,090,000.00 m²", or the raw number with the unknown-unit note. */
export function formatArea(value: number, toMeter: number | null, display: DisplayUnit, digits = 2): string {
  const converted = convertArea(value, toMeter, display);
  return converted === null
    ? `${fixed(value, digits)} ${UNKNOWN_UNIT_NOTE}²`
    : `${fixed(converted, digits)} ${unitSymbol(display)}²`;
}

/**
 * A 3D distance whose horizontal part (file horizontal units) and vertical part (file vertical
 * units) may have different units. Converts each to meters, then combines. If either factor is
 * unknown the distance is not converted: the raw hypot is shown with the unknown-unit note.
 */
export function formatDistance3d(horizontal: number, vertical: number, units: LengthUnits, digits = 2): string {
  const { horizontalToMeter: h, verticalToMeter: v, display } = units;
  if (h === null || v === null) return formatLength(Math.hypot(horizontal, vertical), null, display, digits);
  const meters = Math.hypot(horizontal * h, vertical * v);
  return `${fixed(metersToDisplay(meters, display), digits)} ${unitSymbol(display)}`;
}

/** Format a coordinate triple (x, y, z) such as a bounding-box corner: x and y use the horizontal factor, z the vertical one. */
export function formatCoordinate(point: readonly [number, number, number], units: LengthUnits, digits = 2): string {
  const parts = [
    convertLength(point[0], units.horizontalToMeter, units.display),
    convertLength(point[1], units.horizontalToMeter, units.display),
    convertLength(point[2], units.verticalToMeter, units.display),
  ].map((converted, i) => fixed(converted ?? point[i], digits));
  return `[${parts.join(", ")}]`;
}

/**
 * The unit to write after a coordinate triple: the display symbol when everything converted,
 * the unknown-unit note when any axis is unknown.
 */
export function coordinateUnitLabel(units: LengthUnits): string {
  return units.horizontalToMeter === null || units.verticalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(units.display);
}

/** Parse a stored preference (localStorage text). Anything unexpected falls back to meters. */
export function parseDisplayUnit(stored: string | null | undefined): DisplayUnit {
  return stored === "foot" || stored === "meter" ? stored : DEFAULT_DISPLAY_UNIT;
}
