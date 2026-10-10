import { describe, expect, it } from "vitest";
import { FADE_IN_DURATION_MS, fadeInFactor, nodeFadeFactor, resolveMotionEnabled } from "./animation";

describe("AN-1 フェードイン係数", () => {
  it("0から1へ、FADE_IN_DURATION_MSかけて上がる", () => {
    expect(fadeInFactor(0)).toBe(0);
    expect(fadeInFactor(FADE_IN_DURATION_MS / 2)).toBeCloseTo(0.5, 10);
    expect(fadeInFactor(FADE_IN_DURATION_MS)).toBe(1);
    expect(fadeInFactor(FADE_IN_DURATION_MS * 10)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= FADE_IN_DURATION_MS; t += 10) {
      const f = fadeInFactor(t);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it("負の経過時間・時間0の指定でも壊れない", () => {
    expect(fadeInFactor(-5)).toBe(0);
    expect(fadeInFactor(100, 0)).toBe(1);
  });

  it("まだ描いていないノードは0から始まる", () => {
    expect(nodeFadeFactor(null, 1000, true)).toBe(0);
    expect(nodeFadeFactor(1000, 1000, true)).toBe(0);
    expect(nodeFadeFactor(1000, 1000 + FADE_IN_DURATION_MS, true)).toBe(1);
  });

  it("動きが無効（設定オフ・reduced-motion）なら常に1", () => {
    expect(nodeFadeFactor(null, 0, false)).toBe(1);
    expect(nodeFadeFactor(1000, 1001, false)).toBe(1);
    expect(resolveMotionEnabled(true, false)).toBe(true);
    expect(resolveMotionEnabled(false, false)).toBe(false);
    expect(resolveMotionEnabled(true, true)).toBe(false);
  });
});
