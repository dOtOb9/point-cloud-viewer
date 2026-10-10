import { describe, expect, it } from "vitest";
import {
  MOTION_STORAGE_KEY,
  applyMotionAttribute,
  readStoredAnimationEnabled,
  shouldSkipExitWait,
  storeAnimationEnabled,
} from "./motion-setting";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("アニメーション設定の保存 (AN-3)", () => {
  it("何も保存されていなければオン(既定)", () => {
    expect(readStoredAnimationEnabled(fakeStorage())).toBe(true);
  });

  it("オフで保存すると、次に読んだときもオフ", () => {
    const s = fakeStorage();
    storeAnimationEnabled(s, false);
    expect(s.data[MOTION_STORAGE_KEY]).toBe("false");
    expect(readStoredAnimationEnabled(s)).toBe(false);
    storeAnimationEnabled(s, true);
    expect(readStoredAnimationEnabled(s)).toBe(true);
  });

  it("localStorageが使えない(例外・未定義)ときもオンのまま落ちない", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredAnimationEnabled(broken)).toBe(true);
    expect(() => storeAnimationEnabled(broken, false)).not.toThrow();
    expect(readStoredAnimationEnabled(undefined)).toBe(true);
  });
});

describe("data-motion属性 (AN-3)", () => {
  it("オフのときだけdata-motion=\"off\"を付け、オンで外す", () => {
    const root = { dataset: {} as DOMStringMap };
    applyMotionAttribute(root, false);
    expect(root.dataset.motion).toBe("off");
    applyMotionAttribute(root, true);
    expect(root.dataset.motion).toBeUndefined();
  });

  it("閉じるアニメーションの待ちは、OSの設定かアプリの設定がオフなら省く", () => {
    const on = { dataset: {} as DOMStringMap };
    const off = { dataset: { motion: "off" } as DOMStringMap };
    expect(shouldSkipExitWait(on, false)).toBe(false);
    expect(shouldSkipExitWait(on, true)).toBe(true);
    expect(shouldSkipExitWait(off, false)).toBe(true);
    expect(shouldSkipExitWait(undefined, false)).toBe(false);
  });
});
