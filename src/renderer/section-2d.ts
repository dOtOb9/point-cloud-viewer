import type { SectionPoints } from "../datasource/section-profile";
import { classificationToColor } from "./colormap";

export interface DrawView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const SMALL_DOT_MAX_POINTS = 300_000;

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
  const limitX = width - dot + 1;
  const limitY = height - dot + 1;
  const { scale, offsetX, offsetY } = view;
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const x = offsetX + floats[i * 3] * scale;
    const y = offsetY - floats[i * 3 + 1] * scale;
    if (!(x >= 0 && x < limitX && y >= 0 && y < limitY)) continue;
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

export function niceStep(span: number, targetCount: number): number {
  if (!(span > 0) || !(targetCount > 0)) return 1;
  const raw = span / targetCount;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

export function niceTicks(min: number, max: number, targetCount: number): number[] {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  const step = niceStep(max - min, targetCount);
  const ticks: number[] = [];
  for (let k = Math.ceil(min / step); k * step <= max && ticks.length < MAX_TICKS; k++) ticks.push(k * step);
  return ticks;
}

export function formatTick(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  return (value + 0).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const LABEL_HEIGHT_PX = 14;
const MAX_TICKS = 1000;
const CSS_PX_PER_HORIZONTAL_TICK = 90;
const CSS_PX_PER_VERTICAL_TICK = 50;

export interface DrawSectionOptions {
  dpr: number;
  horizontalUnitScale: number;
  verticalUnitScale: number;
  unitLabel: string;
  line?: Float32Array | null;
}

export interface DrawSectionResult {
  fillMs: number;
  totalMs: number;
  drawn: number;
}

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

  if (points.count > 0) drawAxes(ctx, canvas, cssWidth, cssHeight, view, options);
  if (options.line) drawGroundLine(ctx, options.line, view, options.dpr, getComputedStyle(canvas).getPropertyValue("--secondary").trim());
  return { fillMs, totalMs: performance.now() - start, drawn };
}

export const GROUND_LINE_WIDTH_PX = 2;
const GROUND_LINE_FALLBACK_COLOR = "#fb923c";

export function drawGroundLine(ctx: CanvasRenderingContext2D, line: Float32Array, view: DrawView, dpr: number, color: string): void {
  if (line.length < 4) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = color || GROUND_LINE_FALLBACK_COLOR;
  ctx.lineWidth = GROUND_LINE_WIDTH_PX;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < line.length; i += 2) {
    const x = view.offsetX + line[i] * view.scale;
    const y = view.offsetY - line[i + 1] * view.scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

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

  const sMin = (0 - view.offsetX) / view.scale;
  const sMax = (cssWidth - view.offsetX) / view.scale;
  const zMax = view.offsetY / view.scale;
  const zMin = (view.offsetY - cssHeight) / view.scale;
  const hScale = options.horizontalUnitScale;
  const vScale = options.verticalUnitScale;

  const sTicks = niceTicks(sMin * hScale, sMax * hScale, Math.max(2, Math.floor(cssWidth / CSS_PX_PER_HORIZONTAL_TICK)));
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

  const zTicks = niceTicks(zMin * vScale, zMax * vScale, Math.max(2, Math.floor(cssHeight / CSS_PX_PER_VERTICAL_TICK)));
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
    const y = view.offsetY - (t / vScale) * view.scale;
    if (y < LABEL_HEIGHT_PX || y > cssHeight - LABEL_HEIGHT_PX) continue;
    ctx.fillText(formatTick(t, zStep), 3, y - 1);
  }

  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(options.unitLabel, cssWidth - 4, 3);
  ctx.restore();
}
