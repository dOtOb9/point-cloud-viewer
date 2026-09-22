// sky.ts のテスト（M2-0c）。
//
// SkyBackground自体はGPUDeviceを要る（webgpu-probe.tsと同様、実機のWebGPUが無いと
// テストできない）。ここではGPUに依存しない純粋関数だけを担保する。

import { describe, expect, it } from "vitest";
import { clearColorForMode, DEFAULT_BACKGROUND_MODE, SOLID_DARK_CLEAR, SOLID_LIGHT_CLEAR } from "./sky";

describe("DEFAULT_BACKGROUND_MODE", () => {
  it("既定は空: 実機フィードバックを受けて単色(暗)から変更した（TaskSheets/M2-shading-and-ui.md M2-0c参照）", () => {
    expect(DEFAULT_BACKGROUND_MODE).toBe("sky");
  });
});

describe("clearColorForMode", () => {
  it("solid-darkは暗い色を返す", () => {
    expect(clearColorForMode("solid-dark")).toEqual(SOLID_DARK_CLEAR);
  });

  it("solid-lightは明るい色を返す", () => {
    expect(clearColorForMode("solid-light")).toEqual(SOLID_LIGHT_CLEAR);
  });

  it("skyのときも何らかの色を返す（全画面パスに上書きされるので実際には見えない）", () => {
    const color = clearColorForMode("sky");
    expect(color).toBeDefined();
  });
});
