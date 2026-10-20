// G2-3: drawing of the 2D cross-section panel with Canvas 2D. No React, no WebGPU.
//
// The points are written straight into an `ImageData` (one pixel, or 2x2 pixels when there are few points) through a
// `Uint32Array` view, which is much faster than 2 million `fillRect` calls. The axes, grid lines and labels are drawn
// on top with ordinary Canvas 2D calls (a few dozen of them).
// Not chosen: a second WebGPU pipeline (the renderer would grow and need its own error handling) and SVG (too slow
// beyond a few tens of thousands of points). See TaskSheets/G1-raster-and-dtm.md section 8.3.
import type { SectionPoints } from "../datasource/section-profile";
import { classificationToColor } from "./colormap";

/** screenX = offsetX + s * scale, screenY = offsetY - z * scale (the same as `SectionView` in src/app/section-math.ts). */
export interface DrawView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

// ---------------------------------------------------------------------------------------------
// Points -> pixels
// ---------------------------------------------------------------------------------------------

/** Above this many points a point is one pixel; below it 2x2 pixels, so a sparse section stays visible. */
export const SMALL_DOT_MAX_POINTS = 300_000;

/** Packed RGBA (little endian: byte 0 = r) of each ASPRS classification code 0..255, fully opaque. */
export function classificationPalette(): Uint32Array {
  const palette = new Uint32Array(256);
  for (let code = 0; code < 256; code++) {
    const [r, g, b] = classificationToColor(code);
    palette[code] = packRgb(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
  }
  return palette;
}

function packRgb(r: number, g: number, b: number): number {
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Write the points into `pixels` (width x height, RGBA packed in a Uint32). Points outside are skipped.
 * `view` is in the same pixel units as `pixels`. Returns the number of points that landed inside.
 */
export function fillSectionPixels(
  pixels: Uint32Array,
  width: number,
  height: number,
  points: SectionPoints,
  view: DrawView,
  palette: Uint32Array,
): number {
  const { floats, words, count, hasColor } = points;
  const dot = count > SMALL_DOT_MAX_POINTS ? 1 : 2;
  const limitX = width - dot + 1; // a point with x < limitX has all its pixels inside
  const limitY = height - dot + 1;
  const { scale, offsetX, offsetY } = view;
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const x = offsetX + floats[i * 3] * scale;
    const y = offsetY - floats[i * 3 + 1] * scale;
    if (!(x >= 0 && x < limitX && y >= 0 && y < limitY)) continue; // also false for NaN
    const word = words[i * 3 + 2];
    const color = hasColor ? ((word & 0x00ffffff) | 0xff000000) >>> 0 : palette[word >>> 24];
    const index = (y | 0) * width + (x | 0);
    pixels[index] = color;
    if (dot === 2) {
      pixels[index + 1] = color;
      pixels[index + width] = color;
      pixels[index + width + 1] = color;
    }
    drawn++;
  }
  return drawn;
}

// ---------------------------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------------------------

/** A "nice" step (1, 2 or 5 times a power of ten) near `span / targetCount`. */
export function niceStep(span: number, targetCount: number): number {
  if (!(span > 0) || !(targetCount > 0)) return 1;
  const raw = span / targetCount;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Multiples of a nice step inside [min, max]: about `targetCount` of them. Empty for an invalid range. */
export function niceTicks(min: number, max: number, targetCount: number): number[] {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  const step = niceStep(max - min, targetCount);
  const ticks: number[] = [];
  for (let k = Math.ceil(min / step); k * step <= max && ticks.length < 1000; k++) ticks.push(k * step);
  return ticks;
}

/** A tick label with only as many decimals as the step needs. */
export function formatTick(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  // `+ 0` turns a "-0" into "0".
  return (value + 0).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export interface DrawSectionOptions {
  /** Device pixels per CSS pixel (the canvas is `cssWidth * dpr` wide). */
  dpr: number;
  /** Display units per file unit on the horizontal / vertical axis (1 when the file's unit is unknown). */
  horizontalUnitScale: number;
  verticalUnitScale: number;
  /** "m", "ft" or a note such as "単位不明", drawn at the end of each axis. */
  unitLabel: string;
}

export interface DrawSectionResult {
  /** Milliseconds spent writing the points into the pixel buffer. */
  fillMs: number;
  /** Milliseconds for the whole call (fill, put on the canvas, axes). */
  totalMs: number;
  /** Points that were inside the panel. */
  drawn: number;
}

/**
 * Draw the whole panel: points, then grid lines and labels on top.
 * `view` is in CSS pixels. The canvas's own pixel size is set here from its CSS size and `dpr`.
 */
export function drawSection(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  points: SectionPoints,
  view: DrawView,
  options: DrawSectionOptions,
): DrawSectionResult {
  const start = performance.now();
  const width = Math.max(1, Math.round(cssWidth * options.dpr));
  const height = Math.max(1, Math.round(cssHeight * options.dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { fillMs: 0, totalMs: 0, drawn: 0 };

  const image = ctx.createImageData(width, height);
  const pixels = new Uint32Array(image.data.buffer);
  const deviceView: DrawView = {
    scale: view.scale * options.dpr,
    offsetX: view.offsetX * options.dpr,
    offsetY: view.offsetY * options.dpr,
  };
  const fillStart = performance.now();
  const drawn = fillSectionPixels(pixels, width, height, points, deviceView, classificationPalette());
  const fillMs = performance.now() - fillStart;
  ctx.putImageData(image, 0, 0);

  drawAxes(ctx, canvas, cssWidth, cssHeight, view, options);
  return { fillMs, totalMs: performance.now() - start, drawn };
}

/** Grid lines and labels in the display unit, on top of the points. Text takes the canvas's CSS `color`. */
function drawAxes(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  view: DrawView,
  options: DrawSectionOptions,
): void {
  ctx.save();
  ctx.scale(options.dpr, options.dpr);
  const color = getComputedStyle(canvas).color || "#888";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  // Visible range in file units, then in display units.
  const sMin = (0 - view.offsetX) / view.scale;
  const sMax = (cssWidth - view.offsetX) / view.scale;
  const zMax = view.offsetY / view.scale;
  const zMin = (view.offsetY - cssHeight) / view.scale;
  const hScale = options.horizontalUnitScale;
  const vScale = options.verticalUnitScale;

  // Vertical lines (s) with labels along the bottom edge.
  const sTicks = niceTicks(sMin * hScale, sMax * hScale, Math.max(2, Math.floor(cssWidth / 90)));
  const sStep = sTicks.length > 1 ? sTicks[1] - sTicks[0] : 1;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.globalAlpha = 0.18;
  for (const t of sTicks) {
    const x = view.offsetX + (t / hScale) * view.scale;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, cssHeight);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.9;
  for (const t of sTicks) {
    ctx.fillText(formatTick(t, sStep), view.offsetX + (t / hScale) * view.scale, cssHeight - 2);
  }

  // Horizontal lines (z) with labels along the left edge.
  const zTicks = niceTicks(zMin * vScale, zMax * vScale, Math.max(2, Math.floor(cssHeight / 50)));
  const zStep = zTicks.length > 1 ? zTicks[1] - zTicks[0] : 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.globalAlpha = 0.18;
  for (const t of zTicks) {
    const y = view.offsetY - (t / vScale) * view.scale;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(cssWidth, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.9;
  for (const t of zTicks) {
    ctx.fillText(formatTick(t, zStep), 3, view.offsetY - (t / vScale) * view.scale - 1);
  }

  // The unit, once, at the top right.
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(options.unitLabel, cssWidth - 4, 3);
  ctx.restore();
}
