export type ColorMode = "rgb" | "elevation" | "intensity" | "classification";

export const FALLBACK_COLOR_MODE_WITHOUT_RGB: ColorMode = "elevation";

export function resolveColorMode(mode: ColorMode, hasColor: boolean): ColorMode {
  if (mode === "rgb" && !hasColor) return FALLBACK_COLOR_MODE_WITHOUT_RGB;
  return mode;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

export function normalizeValue(value: number, range: ValueRange): number {
  if (!(range.max > range.min)) return 0;
  return clamp01((value - range.min) / (range.max - range.min));
}

export function extendRange(range: ValueRange | null, value: number): ValueRange {
  if (range === null) return { min: value, max: value };
  return { min: Math.min(range.min, value), max: Math.max(range.max, value) };
}

export type RGB = readonly [number, number, number];

export interface RampStop {
  readonly t: number;
  readonly color: RGB;
}

export function sampleRamp(stops: readonly RampStop[], t: number): RGB {
  if (stops.length === 0) {
    throw new Error("sampleRamp: stops must not be empty");
  }
  const tc = clamp01(t);
  const first = stops[0];
  if (tc <= first.t) return first.color;
  const last = stops[stops.length - 1];
  if (tc >= last.t) return last.color;

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (tc >= a.t && tc <= b.t) {
      const localT = b.t === a.t ? 0 : (tc - a.t) / (b.t - a.t);
      return [
        a.color[0] + (b.color[0] - a.color[0]) * localT,
        a.color[1] + (b.color[1] - a.color[1]) * localT,
        a.color[2] + (b.color[2] - a.color[2]) * localT,
      ];
    }
  }
  return last.color;
}

const BLUE_FOR_LOW: RGB = [0, 0, 1];
const GREEN: RGB = [0, 1, 0];
const YELLOW_BETWEEN_GREEN_AND_RED: RGB = [1, 1, 0];
const RED_FOR_HIGH: RGB = [1, 0, 0];

export const ELEVATION_INTENSITY_RAMP: readonly RampStop[] = [
  { t: 0, color: BLUE_FOR_LOW },
  { t: 1 / 3, color: GREEN },
  { t: 2 / 3, color: YELLOW_BETWEEN_GREEN_AND_RED },
  { t: 1, color: RED_FOR_HIGH },
];

export function elevationToColor(z: number, range: ValueRange): RGB {
  return sampleRamp(ELEVATION_INTENSITY_RAMP, normalizeValue(z, range));
}

export function intensityToColor(intensity: number, range: ValueRange): RGB {
  return sampleRamp(ELEVATION_INTENSITY_RAMP, normalizeValue(intensity, range));
}

export function rampToWgslFunction(fnName: string, stops: readonly RampStop[]): string {
  if (stops.length < 2) {
    throw new Error("rampToWgslFunction: stops must have at least 2 entries");
  }

  const fmt = (n: number): string => {
    const rounded = Number(n.toFixed(6));
    const s = rounded.toString();
    return s.includes(".") || s.includes("e") ? s : `${s}.0`;
  };
  const colorLiteral = (c: RGB): string => `vec3<f32>(${fmt(c[0])}, ${fmt(c[1])}, ${fmt(c[2])})`;

  const lines: string[] = [`fn ${fnName}(t: f32) -> vec3<f32> {`];
  stops.forEach((stop, i) => {
    lines.push(`  let c${i} = ${colorLiteral(stop.color)};`);
  });
  lines.push(`  let tc = clamp(t, 0.0, 1.0);`);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    lines.push(`  if (tc < ${fmt(b.t)}) { return mix(c${i}, c${i + 1}, (tc - ${fmt(a.t)}) / ${fmt(b.t - a.t)}); }`);
  }
  lines.push(`  return c${stops.length - 1};`);
  lines.push(`}`);
  return lines.join("\n");
}

const ASPRS_CLASS = {
  createdNeverClassified: 0,
  unclassified: 1,
  ground: 2,
  lowVegetation: 3,
  mediumVegetation: 4,
  highVegetation: 5,
  building: 6,
  lowPointNoise: 7,
  reservedModelKeyPoint: 8,
  water: 9,
  rail: 10,
  roadSurface: 11,
  reservedOverlapPoints: 12,
  wireGuard: 13,
  wireConductor: 14,
  transmissionTower: 15,
  wireStructureConnector: 16,
  bridgeDeck: 17,
  highNoise: 18,
} as const;

const ASPRS_CLASSIFICATION_COLORS: ReadonlyMap<number, RGB> = new Map<number, RGB>([
  [ASPRS_CLASS.createdNeverClassified, [0.6, 0.6, 0.6]],
  [ASPRS_CLASS.unclassified, [0.78, 0.78, 0.78]],
  [ASPRS_CLASS.ground, [0.55, 0.4, 0.22]],
  [ASPRS_CLASS.lowVegetation, [0.62, 0.82, 0.35]],
  [ASPRS_CLASS.mediumVegetation, [0.32, 0.66, 0.28]],
  [ASPRS_CLASS.highVegetation, [0.1, 0.42, 0.16]],
  [ASPRS_CLASS.building, [0.85, 0.32, 0.22]],
  [ASPRS_CLASS.lowPointNoise, [1.0, 0.0, 1.0]],
  [ASPRS_CLASS.reservedModelKeyPoint, [0.5, 0.5, 0.5]],
  [ASPRS_CLASS.water, [0.15, 0.4, 0.85]],
  [ASPRS_CLASS.rail, [0.4, 0.4, 0.45]],
  [ASPRS_CLASS.roadSurface, [0.25, 0.25, 0.28]],
  [ASPRS_CLASS.reservedOverlapPoints, [0.58, 0.58, 0.58]],
  [ASPRS_CLASS.wireGuard, [0.8, 0.6, 0.1]],
  [ASPRS_CLASS.wireConductor, [0.9, 0.72, 0.2]],
  [ASPRS_CLASS.transmissionTower, [0.7, 0.42, 0.12]],
  [ASPRS_CLASS.wireStructureConnector, [0.82, 0.55, 0.32]],
  [ASPRS_CLASS.bridgeDeck, [0.62, 0.32, 0.7]],
  [ASPRS_CLASS.highNoise, [1.0, 0.15, 0.15]],
]);

export const UNKNOWN_CLASSIFICATION_COLOR: RGB = [0.0, 0.9, 0.9];

export function classificationToColor(code: number): RGB {
  return ASPRS_CLASSIFICATION_COLORS.get(code) ?? UNKNOWN_CLASSIFICATION_COLOR;
}
