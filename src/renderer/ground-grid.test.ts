// ground-grid.ts のテスト（M2-0c 補強B）。
//
// GroundGrid本体はGPUDevice依存のためテスト対象外（sky.tsと同じ扱い）。ここでは
// 「グリッド間隔は固定値にせず、シーンのスケールから自動で決める」という
// タスクシートの要求を担保する純粋関数(niceGridCellSize)だけを担保する。

import { describe, expect, it } from "vitest";
import { floorMod, gridFadeDistance, niceGridCellSize } from "./ground-grid";

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

describe("floorMod", () => {
  // 実機不具合の修正（グリッドが効かない）で導入した関数: グリッドの位相合わせに
  // カメラ位置の絶対座標(f32にすると精度を失う/危険)ではなく、セルサイズで割った
  // 余り（小さい値）を使うため。point-cloud-renderer.tsのdrawFrame()参照。

  it("正の値ではJSの%と同じ結果になる", () => {
    expect(floorMod(7, 3)).toBeCloseTo(1, 9);
    expect(floorMod(637290.8, 100)).toBeCloseTo(90.8, 6);
  });

  it("負の値でも常に[0, m)の範囲を返す（JSの%は負を返すことがあるので、それとは違う）", () => {
    // JSの `-1 % 100` は `-1`（範囲外）。floorModは常に非負を返す必要がある。
    expect(-1 % 100).toBe(-1); // 前提の確認: JSの%はそのままでは使えない
    expect(floorMod(-1, 100)).toBeCloseTo(99, 9);
    expect(floorMod(-851209.9, 100)).toBeCloseTo(90.1, 6);
  });

  it("余りは常に[0, m)に収まる", () => {
    for (const a of [-1000, -1, 0, 0.5, 99.9, 100, 100.1, 1e6]) {
      const r = floorMod(a, 100);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(100);
    }
  });
});
