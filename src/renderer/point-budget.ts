export const CACHE_BUDGET_MULTIPLIER = 2;

export interface PointBudgetState {
  budget: number;
  consecutiveHits: number;
}

export interface PointBudgetLimits {
  min: number;
  max: number;
}

export interface PointBudgetTuning {
  missThresholdMultiplier: number;
  missRatioToShrink: number;
  hitRatioToGrow: number;
  sustainedHitsToGrow: number;
  growRate: number;
  shrinkRate: number;
  limits: PointBudgetLimits;
}

export const REFRESH_ESTIMATE_GENERATION_MS = 15_000;

export const MIN_PLAUSIBLE_REFRESH_INTERVAL_MS = 4;

export interface RefreshIntervalEstimate {
  intervalMs: number;
  currentGenerationMinMs: number;
  previousGenerationMinMs: number;
  currentGenerationStartMs: number;
}

export function updateRefreshIntervalEstimate(
  previous: RefreshIntervalEstimate | null,
  observedFrameDeltaMs: number,
  nowMs: number,
): RefreshIntervalEstimate {
  const clampedDeltaMs = Math.max(observedFrameDeltaMs, MIN_PLAUSIBLE_REFRESH_INTERVAL_MS);

  if (previous === null) {
    return {
      intervalMs: clampedDeltaMs,
      currentGenerationMinMs: clampedDeltaMs,
      previousGenerationMinMs: Infinity,
      currentGenerationStartMs: nowMs,
    };
  }

  let { currentGenerationMinMs, previousGenerationMinMs, currentGenerationStartMs } = previous;

  if (nowMs - currentGenerationStartMs >= REFRESH_ESTIMATE_GENERATION_MS) {
    previousGenerationMinMs = currentGenerationMinMs;
    currentGenerationMinMs = clampedDeltaMs;
    currentGenerationStartMs = nowMs;
  } else {
    currentGenerationMinMs = Math.min(currentGenerationMinMs, clampedDeltaMs);
  }

  return {
    intervalMs: Math.min(currentGenerationMinMs, previousGenerationMinMs),
    currentGenerationMinMs,
    previousGenerationMinMs,
    currentGenerationStartMs,
  };
}

export function evaluatePointBudget(
  state: PointBudgetState,
  recentFrameDeltasMs: readonly number[],
  refreshIntervalMs: number,
  tuning: PointBudgetTuning,
): PointBudgetState {
  if (recentFrameDeltasMs.length === 0) return state;

  const missThresholdMs = refreshIntervalMs * tuning.missThresholdMultiplier;
  const missCount = recentFrameDeltasMs.filter((deltaMs) => deltaMs > missThresholdMs).length;
  const missRatio = missCount / recentFrameDeltasMs.length;

  if (missRatio >= tuning.missRatioToShrink) {
    return {
      budget: clamp(Math.round(state.budget * (1 - tuning.shrinkRate)), tuning.limits),
      consecutiveHits: 0,
    };
  }

  if (missRatio > tuning.hitRatioToGrow) {
    return { budget: state.budget, consecutiveHits: 0 };
  }

  const consecutiveHits = state.consecutiveHits + 1;
  if (consecutiveHits >= tuning.sustainedHitsToGrow) {
    return {
      budget: clamp(Math.round(state.budget * (1 + tuning.growRate)), tuning.limits),
      consecutiveHits: 0,
    };
  }
  return { budget: state.budget, consecutiveHits };
}

function clamp(value: number, limits: PointBudgetLimits): number {
  return Math.min(limits.max, Math.max(limits.min, value));
}

export function pointBudgetMaxFromMemoryBudget(
  memoryBudgetBytes: number,
  pointStrideBytes: number,
  cacheBudgetMultiplier: number,
): number {
  return Math.floor(memoryBudgetBytes / (pointStrideBytes * cacheBudgetMultiplier));
}

export const DEFAULT_POINT_BUDGET_TUNING: Omit<PointBudgetTuning, "limits"> = {
  missThresholdMultiplier: 1.5,
  missRatioToShrink: 0.15,
  hitRatioToGrow: 0.05,
  sustainedHitsToGrow: 3,
  growRate: 0.1,
  shrinkRate: 0.2,
};
