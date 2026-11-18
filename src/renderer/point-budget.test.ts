import { describe, expect, it } from "vitest";
import {
  evaluatePointBudget,
  pointBudgetMaxFromMemoryBudget,
  updateRefreshIntervalEstimate,
  DEFAULT_POINT_BUDGET_TUNING,
  MIN_PLAUSIBLE_REFRESH_INTERVAL_MS,
  REFRESH_ESTIMATE_GENERATION_MS,
  type PointBudgetState,
  type PointBudgetTuning,
  type RefreshIntervalEstimate,
} from "./point-budget";

const REFRESH_60HZ_MS = 1000 / 60;
const REFRESH_144HZ_MS = 1000 / 144;

const TUNING: PointBudgetTuning = {
  ...DEFAULT_POINT_BUDGET_TUNING,
  limits: { min: 200_000, max: 3_000_000 },
};

const WINDOW_SIZE = 20;

function makeWindow() {
  const values: number[] = [];
  return {
    push(ms: number): void {
      values.push(ms);
      if (values.length > WINDOW_SIZE) values.shift();
    },
    pushMany(ms: number, count: number): void {
      for (let i = 0; i < count; i++) this.push(ms);
    },
    get(): number[] {
      return values;
    },
  };
}

function estimateFromSequence(deltasMs: readonly number[], startMs = 0): RefreshIntervalEstimate | null {
  let estimate: RefreshIntervalEstimate | null = null;
  let nowMs = startMs;
  for (const deltaMs of deltasMs) {
    nowMs += deltaMs;
    estimate = updateRefreshIntervalEstimate(estimate, deltaMs, nowMs);
  }
  return estimate;
}

describe("updateRefreshIntervalEstimate", () => {
  it("最初の観測値をそのまま推定値にする", () => {
    const estimate = updateRefreshIntervalEstimate(null, REFRESH_60HZ_MS, 0);
    expect(estimate.intervalMs).toBe(REFRESH_60HZ_MS);
  });

  it("60Hz相当(16.7ms)の間隔が続くと、約16.7msと推定する（固定値1000/60に決め打ちしていない）", () => {
    const estimate = estimateFromSequence(Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS));
    expect(estimate!.intervalMs).toBeCloseTo(REFRESH_60HZ_MS, 5);
  });

  it("144Hz相当(6.9ms)の間隔が続くと、約6.9msと推定する（60Hz用の固定値ではない）", () => {
    const estimate = estimateFromSequence(Array(WINDOW_SIZE).fill(REFRESH_144HZ_MS));
    expect(estimate!.intervalMs).toBeCloseTo(REFRESH_144HZ_MS, 5);
    expect(estimate!.intervalMs).toBeLessThan(REFRESH_60HZ_MS / 2);
  });

  it("同じ世代の中では、後から大きい値（コマ落ち）が続いても推定値は下がらない（数秒程度の負荷継続を誤検出しない）", () => {
    let estimate = updateRefreshIntervalEstimate(null, REFRESH_60HZ_MS, 0);
    let nowMs = 0;
    const LOAD_DURATION_MS = 6_000;
    while (nowMs < LOAD_DURATION_MS) {
      nowMs += REFRESH_60HZ_MS * 2;
      estimate = updateRefreshIntervalEstimate(estimate, REFRESH_60HZ_MS * 2, nowMs);
    }
    expect(nowMs).toBeLessThan(REFRESH_ESTIMATE_GENERATION_MS);
    expect(estimate.intervalMs).toBe(REFRESH_60HZ_MS);
  });

  it("さらに小さい値が来たら更新する", () => {
    let estimate = updateRefreshIntervalEstimate(null, REFRESH_60HZ_MS, 0);
    estimate = updateRefreshIntervalEstimate(estimate, REFRESH_144HZ_MS, REFRESH_60HZ_MS);
    expect(estimate.intervalMs).toBe(REFRESH_144HZ_MS);
  });

  it("0以下や物理的にありえない短さの異常値は、下限（MIN_PLAUSIBLE_REFRESH_INTERVAL_MS）にクランプされる", () => {
    const estimate = updateRefreshIntervalEstimate(null, -5, 0);
    expect(estimate.intervalMs).toBe(MIN_PLAUSIBLE_REFRESH_INTERVAL_MS);
  });

  it(
    "【最重要】異常に短い間隔を1回混ぜた後、通常の間隔が続く列を与えると、" +
      "推定値が元の水準へ戻る（一方向ラチェットの修正確認）",
    () => {
      let estimate: RefreshIntervalEstimate | null = null;
      let nowMs = 0;

      estimate = updateRefreshIntervalEstimate(estimate, 1, nowMs);
      expect(estimate.intervalMs).toBe(MIN_PLAUSIBLE_REFRESH_INTERVAL_MS);

      const durationMs = REFRESH_ESTIMATE_GENERATION_MS * 2 + 5_000;
      while (nowMs < durationMs) {
        nowMs += REFRESH_60HZ_MS;
        estimate = updateRefreshIntervalEstimate(estimate, REFRESH_60HZ_MS, nowMs);
      }

      expect(estimate.intervalMs).toBeCloseTo(REFRESH_60HZ_MS, 1);
    },
  );
});

describe("evaluatePointBudget", () => {
  it("60Hz相当でも144Hz相当でも、それぞれの推定周期を基準に「間に合っている」と正しく判定する", () => {
    const state: PointBudgetState = { budget: 1_000_000, consecutiveHits: 0 };

    const window60 = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS);
    const refresh60 = estimateFromSequence(window60)!.intervalMs;
    const result60 = evaluatePointBudget(state, window60, refresh60, TUNING);
    expect(result60.budget).toBe(1_000_000);
    expect(result60.consecutiveHits).toBe(1);

    const window144 = Array(WINDOW_SIZE).fill(REFRESH_144HZ_MS);
    const refresh144 = estimateFromSequence(window144)!.intervalMs;
    const result144 = evaluatePointBudget(state, window144, refresh144, TUNING);
    expect(result144.budget).toBe(1_000_000);
    expect(result144.consecutiveHits).toBe(1);
  });

  it("外した（vsyncを落とした）フレームが続くと、予算が下限に向かって単調に減る", () => {
    let state: PointBudgetState = { budget: 3_000_000, consecutiveHits: 0 };
    const window = makeWindow();
    window.pushMany(REFRESH_60HZ_MS * 2, WINDOW_SIZE);

    const history = [state.budget];
    for (let i = 0; i < 50; i++) {
      state = evaluatePointBudget(state, window.get(), REFRESH_60HZ_MS, TUNING);
      history.push(state.budget);
    }

    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeLessThanOrEqual(history[i - 1]);
    }
    expect(state.budget).toBe(TUNING.limits.min);
  });

  it("結果は常にlimitsの範囲に収まる", () => {
    const window = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS * 5);
    const shrunk = evaluatePointBudget({ budget: TUNING.limits.min, consecutiveHits: 0 }, window, REFRESH_60HZ_MS, TUNING);
    expect(shrunk.budget).toBeGreaterThanOrEqual(TUNING.limits.min);

    const lightWindow = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS);
    let state: PointBudgetState = { budget: TUNING.limits.max, consecutiveHits: 0 };
    for (let i = 0; i < TUNING.sustainedHitsToGrow + 5; i++) {
      state = evaluatePointBudget(state, lightWindow, REFRESH_60HZ_MS, TUNING);
    }
    expect(state.budget).toBeLessThanOrEqual(TUNING.limits.max);
  });

  it("不感帯（ミス割合がhitRatioToGrowとmissRatioToShrinkの間）では振動しない", () => {
    const window = Array(WINDOW_SIZE - 2).fill(REFRESH_60HZ_MS);
    window.push(REFRESH_60HZ_MS * 2, REFRESH_60HZ_MS * 2);

    let state: PointBudgetState = { budget: 3_000_000, consecutiveHits: 0 };
    for (let i = 0; i < 20; i++) {
      state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
      expect(state.budget).toBe(3_000_000);
      expect(state.consecutiveHits).toBe(0);
    }
  });

  it("20フレームの窓にミスが1枚混ざっても、「間に合っている」の積み上げが台無しにならない（ADR-0010追記分）", () => {
    const window = Array(WINDOW_SIZE - 1).fill(REFRESH_60HZ_MS);
    window.push(REFRESH_60HZ_MS * 2);

    let state: PointBudgetState = { budget: 1_000_000, consecutiveHits: 0 };
    for (let i = 0; i < TUNING.sustainedHitsToGrow - 1; i++) {
      state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
      expect(state.consecutiveHits).toBe(i + 1);
      expect(state.budget).toBe(1_000_000);
    }
    state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
    expect(state.budget).toBeGreaterThan(1_000_000);
  });

  it("間に合っている状態が sustainedHitsToGrow 回続くまでは上げない（緩やかに上げる）", () => {
    const window = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS);
    let state: PointBudgetState = { budget: 1_000_000, consecutiveHits: 0 };

    for (let i = 0; i < TUNING.sustainedHitsToGrow - 1; i++) {
      state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
      expect(state.budget).toBe(1_000_000);
    }
    state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
    expect(state.budget).toBeGreaterThan(1_000_000);
    expect(state.consecutiveHits).toBe(0);
  });

  it(
    "【最重要】vsyncに量子化されたフレーム間隔の列を与えたとき、" +
      "コマ落ち区間の後に予算が元の水準へ向かって回復する",
    () => {
      const window = makeWindow();
      let state: PointBudgetState = { budget: 3_000_000, consecutiveHits: 0 };
      let refreshEstimate: RefreshIntervalEstimate | null = null;
      let nowMs = 0;

      function stepOnce(deltaMs: number): void {
        nowMs += deltaMs;
        window.push(deltaMs);
        refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, deltaMs, nowMs);
        state = evaluatePointBudget(state, window.get(), refreshEstimate.intervalMs, TUNING);
      }

      for (let i = 0; i < WINDOW_SIZE + 5; i++) stepOnce(REFRESH_60HZ_MS);

      for (let i = 0; i < WINDOW_SIZE + 20; i++) stepOnce(REFRESH_60HZ_MS * 2);
      const budgetAfterDrop = state.budget;
      expect(budgetAfterDrop).toBeLessThan(3_000_000);

      for (let i = 0; i < 500; i++) stepOnce(REFRESH_60HZ_MS);

      expect(state.budget).toBeGreaterThan(budgetAfterDrop);
      expect(state.budget).toBe(3_000_000);
    },
  );

  it("推定が異常値で壊れても、点予算が下限に張り付いたまま戻らなくならない（ADR-0010追記3）", () => {
    const window = makeWindow();
    let budgetState: PointBudgetState = { budget: TUNING.limits.max, consecutiveHits: 0 };
    let refreshEstimate: RefreshIntervalEstimate | null = null;
    let nowMs = 0;

    window.push(1);
    refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, 1, nowMs);
    budgetState = evaluatePointBudget(budgetState, window.get(), refreshEstimate.intervalMs, TUNING);

    const durationMs = REFRESH_ESTIMATE_GENERATION_MS * 2 + 5_000;
    while (nowMs < durationMs) {
      nowMs += REFRESH_60HZ_MS;
      window.push(REFRESH_60HZ_MS);
      refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, REFRESH_60HZ_MS, nowMs);
      budgetState = evaluatePointBudget(budgetState, window.get(), refreshEstimate.intervalMs, TUNING);
    }

    expect(budgetState.budget).toBeGreaterThan(TUNING.limits.min);
  });

  it("上限から始めてミスの多い列を与えると、数ステップで適正域まで落ちる（ADR-0010追記分: 楽観的に高く始める設計の確認）", () => {
    const CAPACITY_POINTS = 500_000;
    const START_BUDGET = 6_710_886;
    const LIMITS = { min: 200_000, max: START_BUDGET };

    function simulateFrameMs(budget: number): number {
      const renderCostMs = REFRESH_60HZ_MS * (budget / CAPACITY_POINTS);
      const vsyncMultiples = Math.max(1, Math.ceil(renderCostMs / REFRESH_60HZ_MS));
      return vsyncMultiples * REFRESH_60HZ_MS;
    }

    const tuning: PointBudgetTuning = { ...TUNING, limits: LIMITS };
    let state: PointBudgetState = { budget: START_BUDGET, consecutiveHits: 0 };
    let nowMs = 0;
    let refreshEstimate: RefreshIntervalEstimate | null = updateRefreshIntervalEstimate(null, REFRESH_60HZ_MS, nowMs);
    let stepsToReachNearCapacity = -1;

    for (let i = 0; i < 30; i++) {
      const frameMs = simulateFrameMs(state.budget);
      nowMs += frameMs;
      refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, frameMs, nowMs);
      const window = Array(WINDOW_SIZE).fill(frameMs);
      state = evaluatePointBudget(state, window, refreshEstimate.intervalMs, tuning);
      if (stepsToReachNearCapacity === -1 && state.budget <= CAPACITY_POINTS * 1.5) {
        stepsToReachNearCapacity = i + 1;
      }
    }

    expect(stepsToReachNearCapacity).toBeGreaterThan(0);
    expect(stepsToReachNearCapacity).toBeLessThanOrEqual(15);
  });

  it("予算を増やした結果コマ落ちするようになったら下げ、その付近で落ち着く（際限なく増え続けない）", () => {
    const CAPACITY_POINTS = 2_000_000;
    const REFRESH_MS = REFRESH_60HZ_MS;
    const LIMITS = { min: 200_000, max: 10_000_000 };

    function simulateFrameMs(budget: number): number {
      const renderCostMs = REFRESH_MS * (budget / CAPACITY_POINTS);
      const vsyncMultiples = Math.max(1, Math.ceil(renderCostMs / REFRESH_MS));
      return vsyncMultiples * REFRESH_MS;
    }

    const tuning: PointBudgetTuning = { ...TUNING, limits: LIMITS };
    let state: PointBudgetState = { budget: 200_000, consecutiveHits: 0 };
    let refreshEstimate: RefreshIntervalEstimate | null = null;
    let nowMs = 0;
    let sawDecreaseAfterGrowth = false;
    let maxBudgetSeen = state.budget;

    for (let i = 0; i < 500; i++) {
      const frameMs = simulateFrameMs(state.budget);
      nowMs += frameMs;
      refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, frameMs, nowMs);
      const window = Array(WINDOW_SIZE).fill(frameMs);
      const before = state.budget;
      state = evaluatePointBudget(state, window, refreshEstimate.intervalMs, tuning);
      if (state.budget > maxBudgetSeen) maxBudgetSeen = state.budget;
      if (state.budget < before) sawDecreaseAfterGrowth = true;
    }

    expect(state.budget).toBeLessThan(LIMITS.max);
    expect(maxBudgetSeen).toBeLessThan(CAPACITY_POINTS * 1.5);
    expect(sawDecreaseAfterGrowth).toBe(true);
    expect(state.budget).toBeGreaterThan(CAPACITY_POINTS * 0.3);
  });
});

describe("pointBudgetMaxFromMemoryBudget", () => {
  it("メモリ予算をキャッシュ倍率つきの1点あたりバイト数で割った点数を返す", () => {
    expect(pointBudgetMaxFromMemoryBudget(256 * 1024 * 1024, 20, 2)).toBe(6_710_886);
  });

  it("結果は常に整数（端数を切り捨てる）", () => {
    const result = pointBudgetMaxFromMemoryBudget(1_000, 3, 1);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(Math.floor(1_000 / 3));
  });
});
