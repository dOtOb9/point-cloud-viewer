import type { CrsInfo } from "../datasource/DataSource";

export type DisplayUnit = "meter" | "foot";

export const DEFAULT_DISPLAY_UNIT: DisplayUnit = "meter";

export const INTERNATIONAL_FOOT_IN_METERS = 0.3048;

export const UNKNOWN_UNIT_NOTE = "座標の単位（m かどうか不明）";

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

export function unitSymbol(display: DisplayUnit): string {
  return display === "foot" ? "ft" : "m";
}

export function metersToDisplay(meters: number, display: DisplayUnit): number {
  return display === "foot" ? meters / INTERNATIONAL_FOOT_IN_METERS : meters;
}

export function convertLength(value: number, toMeter: number | null, display: DisplayUnit): number | null {
  if (toMeter === null) return null;
  return metersToDisplay(value * toMeter, display);
}

export function convertArea(value: number, toMeter: number | null, display: DisplayUnit): number | null {
  if (toMeter === null) return null;
  const squareMeters = value * toMeter * toMeter;
  return display === "foot" ? squareMeters / (INTERNATIONAL_FOOT_IN_METERS * INTERNATIONAL_FOOT_IN_METERS) : squareMeters;
}

function fixed(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatLength(value: number, toMeter: number | null, display: DisplayUnit, digits = 2): string {
  const converted = convertLength(value, toMeter, display);
  return converted === null ? `${fixed(value, digits)} ${UNKNOWN_UNIT_NOTE}` : `${fixed(converted, digits)} ${unitSymbol(display)}`;
}

export function formatArea(value: number, toMeter: number | null, display: DisplayUnit, digits = 2): string {
  const converted = convertArea(value, toMeter, display);
  return converted === null
    ? `${fixed(value, digits)} ${UNKNOWN_UNIT_NOTE}²`
    : `${fixed(converted, digits)} ${unitSymbol(display)}²`;
}

export function formatDistance3d(horizontal: number, vertical: number, units: LengthUnits, digits = 2): string {
  const { horizontalToMeter: h, verticalToMeter: v, display } = units;
  if (h === null || v === null) return formatLength(Math.hypot(horizontal, vertical), null, display, digits);
  const meters = Math.hypot(horizontal * h, vertical * v);
  return `${fixed(metersToDisplay(meters, display), digits)} ${unitSymbol(display)}`;
}

export function formatCoordinate(point: readonly [number, number, number], units: LengthUnits, digits = 2): string {
  const parts = [
    convertLength(point[0], units.horizontalToMeter, units.display),
    convertLength(point[1], units.horizontalToMeter, units.display),
    convertLength(point[2], units.verticalToMeter, units.display),
  ].map((converted, i) => fixed(converted ?? point[i], digits));
  return `[${parts.join(", ")}]`;
}

export function coordinateUnitLabel(units: LengthUnits): string {
  return units.horizontalToMeter === null || units.verticalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(units.display);
}

export function parseDisplayUnit(stored: string | null | undefined): DisplayUnit {
  return stored === "foot" || stored === "meter" ? stored : DEFAULT_DISPLAY_UNIT;
}
