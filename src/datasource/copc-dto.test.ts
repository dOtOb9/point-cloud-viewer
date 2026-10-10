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
      crs: { epsg: 6677, name: "JGD2011 / 平面直角座標系 第IX系", kind: "plane-rectangular", error: null },
    };

    expect(toCloudInfo(dto)).toEqual({
      pointCount: 12345,
      min: [1, 2, 3],
      max: [4, 5, 6],
      scale: [0.01, 0.01, 0.01],
      offset: [500000, 4000000, 0],
      hasColor: true,
      crs: { epsg: 6677, name: "JGD2011 / 平面直角座標系 第IX系", kind: "plane-rectangular" },
    });
  });

  it("CRSのnull(Tauri)とundefined(Web)はどちらもキー無しにそろえる", () => {
    const base = { point_count: 1, min: [0, 0, 0], max: [1, 1, 1], scale: [1, 1, 1], offset: [0, 0, 0], has_color: false } as const;
    const fromTauri = toCloudInfo({ ...base, min: [0, 0, 0], max: [1, 1, 1], scale: [1, 1, 1], offset: [0, 0, 0], crs: { epsg: null, name: "", kind: "none", error: null } });
    const fromWeb = toCloudInfo({ ...base, min: [0, 0, 0], max: [1, 1, 1], scale: [1, 1, 1], offset: [0, 0, 0], crs: { name: "", kind: "none" } });
    expect(fromTauri.crs).toEqual({ name: "", kind: "none" });
    expect(fromWeb.crs).toEqual(fromTauri.crs);
  });

  it("読み取りエラーはそのまま保持する", () => {
    const base = { point_count: 1, min: [0, 0, 0], max: [1, 1, 1], scale: [1, 1, 1], offset: [0, 0, 0], has_color: false } as const;
    const info = toCloudInfo({ ...base, min: [0, 0, 0], max: [1, 1, 1], scale: [1, 1, 1], offset: [0, 0, 0], crs: { name: "", kind: "other", error: "VLRを読めなかった" } });
    expect(info.crs.error).toBe("VLRを読めなかった");
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
