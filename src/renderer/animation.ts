export const FADE_IN_DURATION_MS = 250;

export function fadeInFactor(elapsedMs: number, durationMs: number = FADE_IN_DURATION_MS): number {
  if (!(durationMs > 0)) return 1;
  if (!(elapsedMs > 0)) return 0;
  return Math.min(1, elapsedMs / durationMs);
}

export function nodeFadeFactor(firstDrawnAtMs: number | null, nowMs: number, motionEnabled: boolean): number {
  if (!motionEnabled) return 1;
  if (firstDrawnAtMs === null) return 0;
  return fadeInFactor(nowMs - firstDrawnAtMs);
}

export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== "function") return false;
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function resolveMotionEnabled(settingEnabled: boolean, reducedMotion: boolean): boolean {
  return settingEnabled && !reducedMotion;
}

export const INERTIA_TAU_MS = 325;
export const INERTIA_SAMPLE_WINDOW_MS = 100;
export const INERTIA_MAX_IDLE_MS = 60;
export const INERTIA_STOP_ROTATE_RAD_PER_SEC = 0.05;
export const INERTIA_STOP_PAN_PX_PER_SEC = 8;

export const ZOOM_SMOOTH_TAU_MS = 80;
export const ZOOM_SMOOTH_STOP_LOG = 1e-3;

export const TRANSITION_DURATION_MS = 500;
export const FLY_TO_DISTANCE_RATIO = 0.5;
export const DOUBLE_TAP_MAX_INTERVAL_MS = 300;
export const DOUBLE_TAP_MAX_DISTANCE_PX = 30;

export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function expApproachFraction(dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return 0;
  if (!(tauMs > 0)) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

export function shortestAngleDelta(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let d = (to - from) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return d;
}

export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  add(tMs: number, x: number, y: number): void {
    this.samples.push({ t: tMs, x, y });
    while (this.samples.length > 2 && tMs - this.samples[0].t > INERTIA_SAMPLE_WINDOW_MS) {
      this.samples.shift();
    }
  }

  reset(): void {
    this.samples.length = 0;
  }

  velocity(nowMs: number): [number, number] {
    const n = this.samples.length;
    if (n < 2) return [0, 0];
    const last = this.samples[n - 1];
    if (nowMs - last.t > INERTIA_MAX_IDLE_MS) return [0, 0];
    let first = this.samples[0];
    for (const s of this.samples) {
      if (last.t - s.t <= INERTIA_SAMPLE_WINDOW_MS) {
        first = s;
        break;
      }
    }
    const spanSec = (last.t - first.t) / 1000;
    if (!(spanSec > 0)) return [0, 0];
    return [(last.x - first.x) / spanSec, (last.y - first.y) / spanSec];
  }
}
