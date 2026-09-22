// ground-grid.ts のテスト（M2-0c 補強B）。
//
// GroundGrid本体はGPUDevice依存のためテスト対象外（sky.tsと同じ扱い）。ここでは
// 「グリッド間隔は固定値にせず、シーンのスケールから自動で決める」という
// タスクシートの要求を担保する純粋関数(niceGridCellSize)だけを担保する。

import { describe, expect, it } from "vitest";
import { gridFadeDistance, niceGridCellSize } from "./ground-grid";

describe("niceGridCellSize", () => {
  it("シーンが大きいほど、間隔も大きくなる（固定値ではない）", () => {
    const small = niceGridCellSize(10);
    const medium = niceGridCellSize(1000);
    const large = niceGridCellSize(100_000);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
  });

  it("1-2-5系列のキリのいい値だけを返す（先頭の桁は1, 2, 5のいずれか）", () => {
    const diagonals = [1, 5, 10, 47, 100, 999, 4656, 100_000, 3_426_000];
    for (const d of diagonals) {
      const cell = niceGridCellSize(d);
      const magnitude = Math.pow(10, Math.floor(Math.log10(cell)));
      const leadingDigit = Math.round(cell / magnitude);
      expect([1, 2, 5]).toContain(leadingDigit);
    }
  });

  it("autzenのY幅(4656m)相当では100m刻みになる（タスクシートの例: 1m/10m/100mの桁選び）", () => {
    expect(niceGridCellSize(4656)).toBe(100);
  });

  it("対角線が0や不正な値なら、フォールバックとして1を返す（描画が壊れないように）", () => {
    expect(niceGridCellSize(0)).toBe(1);
    expect(niceGridCellSize(-5)).toBe(1);
    expect(niceGridCellSize(NaN)).toBe(1);
    expect(niceGridCellSize(Infinity)).toBe(1);
  });
});

describe("gridFadeDistance", () => {
  it("シーンの対角線に比例する（固定値ではない）", () => {
    expect(gridFadeDistance(100)).toBeCloseTo(150, 9);
    expect(gridFadeDistance(1000)).toBeCloseTo(1500, 9);
  });

  it("0や不正な値ならフォールバックの対角線(100)を使う", () => {
    expect(gridFadeDistance(0)).toBeGreaterThan(0);
  });
});
