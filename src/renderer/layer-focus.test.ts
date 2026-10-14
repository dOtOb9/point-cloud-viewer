import { describe, expect, it } from "vitest";
import { focusGoalFor, layerFocusBounds, sanitizePointSize } from "./layer-focus";
import type { SceneBounds } from "./scene-bounds";

describe("layerFocusBounds", () => {
  it("ノードの範囲があればそれをそのまま使う", () => {
    const sb: SceneBounds = { min: [0, 0, 0], max: [10, 10, 10], center: [5, 5, 5], diagonal: 17.3 };
    expect(layerFocusBounds(sb, [1, 1, 1], [2, 2, 2])).toBe(sb);
  });

  it("ノードが無いときはヘッダーの範囲から作る", () => {
    const b = layerFocusBounds(null, [0, 0, 0], [3, 4, 0]);
    expect(b.center).toEqual([1.5, 2, 0]);
    expect(b.diagonal).toBe(5);
  });

  it("点が1つ（対角線0）なら100にフォールバックする", () => {
    expect(layerFocusBounds(null, [1, 1, 1], [1, 1, 1]).diagonal).toBe(100);
  });
});

describe("sanitizePointSize", () => {
  it("範囲に収め、未指定・NaNは既定の4にする", () => {
    expect(sanitizePointSize(undefined)).toBe(4);
    expect(sanitizePointSize(Number.NaN)).toBe(4);
    expect(sanitizePointSize(0)).toBe(1);
    expect(sanitizePointSize(100)).toBe(32);
    expect(sanitizePointSize(6)).toBe(6);
  });
});

describe("focusGoalFor", () => {
  const b: SceneBounds = { min: [0, 0, 0], max: [2, 0, 0], center: [1, 0, 0], diagonal: 2 };

  it("離れた2つのレイヤーでは、行き先は合併ではなくそのレイヤー自身の大きさで決まる", () => {
    const near = focusGoalFor(b);
    const far = focusGoalFor({ min: [1e6, 0, 0], max: [1e6 + 2, 0, 0], center: [1e6 + 1, 0, 0], diagonal: 2 });
    expect(near.distance).toBe(2);
    expect(far.distance).toBe(2);
    expect(far.target[0]).toBe(1e6 + 1);
  });

  it("向きを指定したときだけ yaw/pitch が入る", () => {
    expect("yaw" in focusGoalFor(b)).toBe(false);
    expect(focusGoalFor(b, { yaw: 0, pitch: 0.3 })).toMatchObject({ yaw: 0, pitch: 0.3 });
  });
});
