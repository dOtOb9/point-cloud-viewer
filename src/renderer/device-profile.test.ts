// device-profile.tsのテスト（M3-8、受け入れ条件「モバイル判定と既定値の決定が
// 純粋関数にあり、単体テストがある」に対応）。

import { describe, expect, it } from "vitest";
import {
  defaultRenderSettings,
  isMobileDevice,
  MOBILE_FALLBACK_DEVICE_MEMORY_GIB,
  MOBILE_LOW_MEMORY_THRESHOLD_GIB,
} from "./device-profile";

describe("isMobileDevice", () => {
  it("4GBかつタッチ主体 → モバイル(タスクシートの受け入れ条件そのもの)", () => {
    expect(isMobileDevice({ deviceMemoryGiB: 4, pointerCoarse: true })).toBe(true);
  });

  it("deviceMemoryが取れない環境・マウス主体 → デスクトップ(タスクシートの受け入れ条件そのもの)", () => {
    expect(isMobileDevice({ deviceMemoryGiB: undefined, pointerCoarse: false })).toBe(false);
  });

  it("タッチ主体なら、deviceMemoryが大きくても(高性能タブレット等)モバイル判定にする", () => {
    expect(isMobileDevice({ deviceMemoryGiB: 8, pointerCoarse: true })).toBe(true);
  });

  it("マウス主体でも、deviceMemoryが閾値以下ならモバイル(=軽い側)判定にする", () => {
    expect(isMobileDevice({ deviceMemoryGiB: MOBILE_LOW_MEMORY_THRESHOLD_GIB, pointerCoarse: false })).toBe(true);
    expect(isMobileDevice({ deviceMemoryGiB: 2, pointerCoarse: false })).toBe(true);
  });

  it("マウス主体・deviceMemoryが閾値より大きい → デスクトップ", () => {
    expect(isMobileDevice({ deviceMemoryGiB: 8, pointerCoarse: false })).toBe(false);
  });

  it("deviceMemoryが取れない・タッチでもない → デスクトップ(「分からない」をモバイルと決めつけない)", () => {
    expect(isMobileDevice({ deviceMemoryGiB: undefined, pointerCoarse: false })).toBe(false);
  });
});

describe("defaultRenderSettings (デスクトップ)", () => {
  it("デスクトップ判定では、既存の挙動と同じ既定値になる(変更前と同じであることの固定テスト)", () => {
    const defaults = defaultRenderSettings({ deviceMemoryGiB: undefined, pointerCoarse: false });
    expect(defaults.isMobile).toBe(false);
    expect(defaults.renderScale).toBe(1.0);
    expect(defaults.pointShape).toBe("round");
    expect(defaults.edlEnabled).toBe(true);
    expect(defaults.glassEnabled).toBe(true);
    // ADR-0010の計算式(1GiB / (20バイト×2倍)) と同じ値であることを固定する。
    // ADR-0010本文に書かれている実測値(26,843,545)と一致する。
    expect(defaults.pointBudgetMax).toBe(26_843_545);
    expect(defaults.pointBudgetStart).toBe(defaults.pointBudgetMax);
  });

  it("高性能なデスクトップ(deviceMemory=8, マウス)でも同じデスクトップの既定値になる", () => {
    const defaults = defaultRenderSettings({ deviceMemoryGiB: 8, pointerCoarse: false });
    expect(defaults.isMobile).toBe(false);
    expect(defaults.pointBudgetMax).toBe(26_843_545);
  });
});

describe("defaultRenderSettings (モバイル)", () => {
  it("モバイル判定では、レンダースケール0.5・四角い点・EDLオフ・ガラスオフになる", () => {
    const defaults = defaultRenderSettings({ deviceMemoryGiB: 4, pointerCoarse: true });
    expect(defaults.isMobile).toBe(true);
    expect(defaults.renderScale).toBe(0.5);
    expect(defaults.pointShape).toBe("square");
    expect(defaults.edlEnabled).toBe(false);
    expect(defaults.glassEnabled).toBe(false);
  });

  it("点予算の上限はdeviceMemoryから算出され、デスクトップの上限より大幅に小さい", () => {
    const defaults = defaultRenderSettings({ deviceMemoryGiB: 4, pointerCoarse: true });
    // 4GiB * (1/64) / (20バイト×2倍) = 67,108,864 / 40 = 1,677,721.6 → floor
    expect(defaults.pointBudgetMax).toBe(1_677_721);
    expect(defaults.pointBudgetStart).toBe(defaults.pointBudgetMax);
    // 「4GBの端末で起動した瞬間に大量のノードを要求しない」がタスクシートの
    // 目的なので、デスクトップの上限(26,843,545)より十分小さいことを確認する。
    expect(defaults.pointBudgetMax).toBeLessThan(26_843_545 / 10);
  });

  it("deviceMemoryが取得できないモバイル端末では、フォールバック値(4GiB)で算出する", () => {
    const withUndefined = defaultRenderSettings({ deviceMemoryGiB: undefined, pointerCoarse: true });
    const withFallbackValue = defaultRenderSettings({
      deviceMemoryGiB: MOBILE_FALLBACK_DEVICE_MEMORY_GIB,
      pointerCoarse: true,
    });
    expect(withUndefined.pointBudgetMax).toBe(withFallbackValue.pointBudgetMax);
  });

  it("deviceMemoryが小さいほど点予算の上限も小さくなる(単調性)", () => {
    const memory1GiB = defaultRenderSettings({ deviceMemoryGiB: 1, pointerCoarse: true });
    const memory2GiB = defaultRenderSettings({ deviceMemoryGiB: 2, pointerCoarse: true });
    const memory4GiB = defaultRenderSettings({ deviceMemoryGiB: 4, pointerCoarse: true });
    expect(memory1GiB.pointBudgetMax).toBeLessThan(memory2GiB.pointBudgetMax);
    expect(memory2GiB.pointBudgetMax).toBeLessThan(memory4GiB.pointBudgetMax);
  });
});
