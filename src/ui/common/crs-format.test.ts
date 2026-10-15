import { describe, expect, it } from "vitest";
import type { CrsInfo } from "../../datasource/DataSource";
import { formatCrsLong, formatCrsShort } from "./crs-format";

const jgd: CrsInfo = { epsg: 6677, name: "JGD2011 / 平面直角座標系 第IX系", kind: "plane-rectangular" };

describe("formatCrsLong / formatCrsShort", () => {
  it("平面直角座標系: 長い形は名前とEPSG、短い形はEPSGだけ", () => {
    expect(formatCrsLong(jgd)).toBe("JGD2011 / 平面直角座標系 第IX系 (EPSG:6677)");
    expect(formatCrsShort(jgd)).toBe("EPSG:6677");
  });

  it("UTM", () => {
    const utm: CrsInfo = { epsg: 32654, name: "WGS 84 / UTM zone 54N", kind: "utm" };
    expect(formatCrsLong(utm)).toBe("WGS 84 / UTM zone 54N (EPSG:32654)");
    expect(formatCrsShort(utm)).toBe("EPSG:32654");
  });

  it("CRS情報が無いファイル", () => {
    const none: CrsInfo = { name: "", kind: "none" };
    expect(formatCrsLong(none)).toBe("なし（ファイルに座標系情報が無い）");
    expect(formatCrsShort(none)).toBe("なし");
  });

  it("未対応の系は、ファイルに書かれた名前とEPSGをそのまま出す", () => {
    const other: CrsInfo = { epsg: 2992, name: "NAD83 / Oregon GIC Lambert (ft)", kind: "other" };
    expect(formatCrsLong(other)).toBe("NAD83 / Oregon GIC Lambert (ft) (EPSG:2992)");
    expect(formatCrsShort(other)).toBe("EPSG:2992");
  });

  it("名前がEPSGコードそのものなら重ねて書かない", () => {
    const other: CrsInfo = { epsg: 3857, name: "EPSG:3857", kind: "other" };
    expect(formatCrsLong(other)).toBe("EPSG:3857");
  });

  it("EPSGコードが無い未対応の系は名前だけ", () => {
    const other: CrsInfo = { name: "Local grid", kind: "other" };
    expect(formatCrsLong(other)).toBe("Local grid");
    expect(formatCrsShort(other)).toBe("Local grid");
  });

  it("読み取りに失敗したら「読み取れなかった」", () => {
    const failed: CrsInfo = { name: "", kind: "other", error: "VLRを読めなかった: x" };
    expect(formatCrsLong(failed)).toBe("読み取れなかった");
    expect(formatCrsShort(failed)).toBe("読み取れなかった");
  });
});
