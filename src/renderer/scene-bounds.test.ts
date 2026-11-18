import { describe, expect, it } from "vitest";
import type { HierarchyNodeInfo } from "../datasource/DataSource";
import { computeSceneBounds, elevationRangeFromCloudBounds } from "./scene-bounds";

describe("computeSceneBounds", () => {
  it("複数ノードのboundsMin/boundsMaxの和集合を求める", () => {
    const nodes: HierarchyNodeInfo[] = [
      { key: "a", pointCount: 1, boundsMin: [0, 0, 0], boundsMax: [10, 10, 10] },
      { key: "b", pointCount: 1, boundsMin: [-5, 2, 3], boundsMax: [8, 20, 12] },
    ];
    const bounds = computeSceneBounds(nodes);
    expect(bounds).not.toBeNull();
    expect(bounds?.min).toEqual([-5, 0, 0]);
    expect(bounds?.max).toEqual([10, 20, 12]);
    expect(bounds?.center).toEqual([2.5, 10, 6]);
  });

  it("ノードが空の場合はnullを返す", () => {
    expect(computeSceneBounds([])).toBeNull();
  });

  it("対角線が0になる場合(点が1つ等)は100にフォールバックする", () => {
    const nodes: HierarchyNodeInfo[] = [{ key: "a", pointCount: 1, boundsMin: [1, 1, 1], boundsMax: [1, 1, 1] }];
    expect(computeSceneBounds(nodes)?.diagonal).toBe(100);
  });
});

describe("elevationRangeFromCloudBounds", () => {
  it("ヘッダーの実データ範囲(Z成分)をそのまま使う", () => {
    const min: readonly [number, number, number] = [500_000, 4_000_000, 100];
    const max: readonly [number, number, number] = [501_000, 4_001_000, 150];
    expect(elevationRangeFromCloudBounds(min, max)).toEqual({ min: 100, max: 150 });
  });
});

describe("実機不具合の再現: ノードのセル範囲(立方体)を標高に使ってはいけない", () => {
  it("computeSceneBoundsのZ範囲と、elevationRangeFromCloudBoundsの結果は一致しない(混同していない)", () => {
    const nodes: HierarchyNodeInfo[] = [
      { key: "root", pointCount: 1, boundsMin: [-1000, -1000, -900], boundsMax: [1000, 1000, 1100] },
    ];
    const sceneBounds = computeSceneBounds(nodes);
    expect(sceneBounds?.min[2]).toBe(-900);
    expect(sceneBounds?.max[2]).toBe(1100);

    const headerMin: readonly [number, number, number] = [-1000, -1000, 100];
    const headerMax: readonly [number, number, number] = [1000, 1000, 150];
    const elevationRange = elevationRangeFromCloudBounds(headerMin, headerMax);

    expect(elevationRange).toEqual({ min: 100, max: 150 });
    expect(elevationRange).not.toEqual({ min: sceneBounds?.min[2], max: sceneBounds?.max[2] });
  });
});
