// copc-dto.ts のテスト。TauriSource(open_copc)とWebSource(pcv-wasm)が返す
// snake_caseのJSONを、DataSourceのcamelCase型へ正しく詰め替えられることを確認する。
// Worker/wasmには依存しない純粋関数なので、実際のバックエンドなしでテストできる。

import { describe, expect, it } from "vitest";
import { toCloudInfo, toHierarchyNodeInfo, type CloudInfoDto, type HierarchyNodeDto } from "./copc-dto";

describe("toCloudInfo", () => {
  it("snake_caseのフィールドをcamelCaseへ変換する", () => {
    const dto: CloudInfoDto = {
      point_count: 12345,
      min: [1, 2, 3],
      max: [4, 5, 6],
      scale: [0.01, 0.01, 0.01],
      offset: [500000, 4000000, 0],
      has_color: true,
    };

    expect(toCloudInfo(dto)).toEqual({
      pointCount: 12345,
      min: [1, 2, 3],
      max: [4, 5, 6],
      scale: [0.01, 0.01, 0.01],
      offset: [500000, 4000000, 0],
      hasColor: true,
    });
  });
});

describe("toHierarchyNodeInfo", () => {
  it("keyをそのまま保持しつつ、他はcamelCaseへ変換する", () => {
    const dto: HierarchyNodeDto = {
      key: "1-0-1-0",
      point_count: 999,
      bounds_min: [0, 0, 0],
      bounds_max: [10, 10, 10],
    };

    expect(toHierarchyNodeInfo(dto)).toEqual({
      key: "1-0-1-0",
      pointCount: 999,
      boundsMin: [0, 0, 0],
      boundsMax: [10, 10, 10],
    });
  });
});
