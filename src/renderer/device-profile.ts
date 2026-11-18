import { NODE_POINT_STRIDE } from "../datasource/node-format";
import { CACHE_BUDGET_MULTIPLIER, pointBudgetMaxFromMemoryBudget } from "./point-budget";

export type PointShape = "round" | "square";

export interface DeviceProfileInput {
  deviceMemoryGiB: number | undefined;
  pointerCoarse: boolean;
}

export const MOBILE_LOW_MEMORY_THRESHOLD_GIB = 4;

export function isMobileDevice(input: DeviceProfileInput): boolean {
  if (input.pointerCoarse) return true;
  if (input.deviceMemoryGiB !== undefined && input.deviceMemoryGiB <= MOBILE_LOW_MEMORY_THRESHOLD_GIB) {
    return true;
  }
  return false;
}

export const DESKTOP_RENDER_SCALE = 1.0;
export const MOBILE_RENDER_SCALE = 0.5;

export const DESKTOP_POINT_CACHE_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

export const MOBILE_POINT_CACHE_MEMORY_FRACTION = 1 / 64;

export const MOBILE_FALLBACK_DEVICE_MEMORY_GIB = 4;

export interface RenderDefaults {
  isMobile: boolean;
  renderScale: number;
  pointShape: PointShape;
  edlEnabled: boolean;
  glassEnabled: boolean;
  pointBudgetMax: number;
  pointBudgetStart: number;
}

export function defaultRenderSettings(input: DeviceProfileInput): RenderDefaults {
  const isMobile = isMobileDevice(input);

  if (!isMobile) {
    const pointBudgetMax = pointBudgetMaxFromMemoryBudget(
      DESKTOP_POINT_CACHE_MEMORY_BUDGET_BYTES,
      NODE_POINT_STRIDE,
      CACHE_BUDGET_MULTIPLIER,
    );
    return {
      isMobile: false,
      renderScale: DESKTOP_RENDER_SCALE,
      pointShape: "round",
      edlEnabled: true,
      glassEnabled: true,
      pointBudgetMax,
      pointBudgetStart: pointBudgetMax,
    };
  }

  const deviceMemoryGiB = input.deviceMemoryGiB ?? MOBILE_FALLBACK_DEVICE_MEMORY_GIB;
  const memoryBudgetBytes = deviceMemoryGiB * 1024 * 1024 * 1024 * MOBILE_POINT_CACHE_MEMORY_FRACTION;
  const pointBudgetMax = pointBudgetMaxFromMemoryBudget(memoryBudgetBytes, NODE_POINT_STRIDE, CACHE_BUDGET_MULTIPLIER);
  return {
    isMobile: true,
    renderScale: MOBILE_RENDER_SCALE,
    pointShape: "square",
    edlEnabled: false,
    glassEnabled: false,
    pointBudgetMax,
    pointBudgetStart: pointBudgetMax,
  };
}

export function readDeviceProfileInput(): DeviceProfileInput {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const pointerCoarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return { deviceMemoryGiB: nav.deviceMemory, pointerCoarse };
}
