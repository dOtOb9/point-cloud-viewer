// point-budget.ts のテスト。WebGPUデバイスもReactも要らない純粋関数なので、
// レンダラを一切起動せずに閉ループの挙動（下げる/上げる/振動しない）を確認できる。

import { describe, expect, it } from "vitest";
import { nextPointBudget, type NextPointBudgetOptions } from "./point-budget";

const OPTS: NextPointBudgetOptions = {
  targetFrameMs: 1000 / 60, // ≈16.67ms（60fps相当）
  limits: { min: 100_000, max: 5_000_000 },
  deadZoneMs: 4,
  growRate: 0.05,
  shrinkRate: 0.2,
};

describe("nextPointBudget", () => {
  it("目標を大きく超えるフレーム時間が続くと、予算が下限に向かって単調に減る", () => {
    let budget = 3_000_000;
    const heavyFrameMs = OPTS.targetFrameMs + 20; // 不感帯(4ms)を大きく超える重さ

    const history = [budget];
    for (let i = 0; i < 50; i++) {
      budget = nextPointBudget(budget, heavyFrameMs, OPTS);
      history.push(budget);
    }

    // 単調減少（同値で頭打ちになるのはよいが、一度でも増えてはいけない）。
    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeLessThanOrEqual(history[i - 1]);
    }
    // 十分な回数を繰り返せば下限に到達する。
    expect(budget).toBe(OPTS.limits.min);
  });

  it("目標を大きく下回るフレーム時間が続くと、予算が上限に向かって単調に増える", () => {
    let budget = 100_000;
    const lightFrameMs = OPTS.targetFrameMs - 10; // 不感帯を大きく下回る軽さ

    const history = [budget];
    for (let i = 0; i < 200; i++) {
      budget = nextPointBudget(budget, lightFrameMs, OPTS);
      history.push(budget);
    }

    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeGreaterThanOrEqual(history[i - 1]);
    }
    expect(budget).toBe(OPTS.limits.max);
  });

  it("目標のすぐ近くの値を交互に与えても、不感帯により予算が振動しない", () => {
    let budget = 3_000_000;
    // 不感帯は target ± 4ms。その内側（±1ms）を交互に与える。
    const justAbove = OPTS.targetFrameMs + 1;
    const justBelow = OPTS.targetFrameMs - 1;

    for (let i = 0; i < 20; i++) {
      const frameMs = i % 2 === 0 ? justAbove : justBelow;
      budget = nextPointBudget(budget, frameMs, OPTS);
      expect(budget).toBe(3_000_000);
    }
  });

  it("不感帯のすぐ外側では、上げる方向にも下げる方向にも反応する（不感帯が広すぎて固まっていないことの確認）", () => {
    const justOutsideAbove = OPTS.targetFrameMs + OPTS.deadZoneMs + 1;
    const justOutsideBelow = OPTS.targetFrameMs - OPTS.deadZoneMs - 1;

    expect(nextPointBudget(3_000_000, justOutsideAbove, OPTS)).toBeLessThan(3_000_000);
    expect(nextPointBudget(3_000_000, justOutsideBelow, OPTS)).toBeGreaterThan(3_000_000);
  });

  it("結果は常にlimitsの範囲に収まる", () => {
    expect(nextPointBudget(OPTS.limits.min, OPTS.targetFrameMs + 100, OPTS)).toBeGreaterThanOrEqual(OPTS.limits.min);
    expect(nextPointBudget(OPTS.limits.max, OPTS.targetFrameMs - 100, OPTS)).toBeLessThanOrEqual(OPTS.limits.max);
  });
});
