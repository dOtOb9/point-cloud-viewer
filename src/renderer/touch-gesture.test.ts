import { describe, expect, it } from "vitest";
import { computeTwoPointerGesture, type TouchPoint } from "./touch-gesture";

describe("computeTwoPointerGesture", () => {
  it("指を広げる（ピンチアウト）とzoomFactorが1未満になる（拡大方向）", () => {
    const prev: [TouchPoint, TouchPoint] = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ];
    const curr: [TouchPoint, TouchPoint] = [
      { x: 50, y: 100 },
      { x: 250, y: 100 },
    ];

    const result = computeTwoPointerGesture(prev, curr);

    expect(result.zoomFactor).toBeCloseTo(0.5, 9);
  });

  it("指をつまむ（ピンチイン）とzoomFactorが1より大きくなる（縮小方向）", () => {
    const prev: [TouchPoint, TouchPoint] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const curr: [TouchPoint, TouchPoint] = [
      { x: 25, y: 0 },
      { x: 75, y: 0 },
    ];

    const result = computeTwoPointerGesture(prev, curr);

    expect(result.zoomFactor).toBeCloseTo(2, 9);
  });

  it("距離を変えずに平行移動すると、zoomFactorは1、panDeltaは中点の移動量と一致する", () => {
    const prev: [TouchPoint, TouchPoint] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const curr: [TouchPoint, TouchPoint] = [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
    ];

    const result = computeTwoPointerGesture(prev, curr);

    expect(result.zoomFactor).toBeCloseTo(1, 9);
    expect(result.panDeltaX).toBeCloseTo(10, 9);
    expect(result.panDeltaY).toBeCloseTo(20, 9);
  });

  it("中点はズーム先として現フレームの2点の中央になる", () => {
    const prev: [TouchPoint, TouchPoint] = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    const curr: [TouchPoint, TouchPoint] = [
      { x: 40, y: 60 },
      { x: 80, y: 100 },
    ];

    const result = computeTwoPointerGesture(prev, curr);

    expect(result.midpoint).toEqual({ x: 60, y: 80 });
  });

  it("指が重なる（距離0）瞬間があっても、NaNやInfinityにならない", () => {
    const prev: [TouchPoint, TouchPoint] = [
      { x: 50, y: 50 },
      { x: 50, y: 50 },
    ];
    const curr: [TouchPoint, TouchPoint] = [
      { x: 50, y: 50 },
      { x: 150, y: 50 },
    ];

    const result = computeTwoPointerGesture(prev, curr);

    expect(Number.isFinite(result.zoomFactor)).toBe(true);
    expect(Number.isFinite(result.panDeltaX)).toBe(true);
    expect(Number.isFinite(result.panDeltaY)).toBe(true);
  });

  it("ピンチとパンが同時に起きても、両方が独立に計算される（現実の2本指操作を想定）", () => {
    const prev: [TouchPoint, TouchPoint] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const curr: [TouchPoint, TouchPoint] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ];

    const result = computeTwoPointerGesture(prev, curr);

    expect(result.panDeltaX).toBeCloseTo(100, 9);
    expect(result.panDeltaY).toBeCloseTo(0, 9);
    expect(result.zoomFactor).toBeCloseTo(1 / 3, 9);
  });
});
