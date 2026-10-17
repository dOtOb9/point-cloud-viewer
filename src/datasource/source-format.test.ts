import { describe, expect, it } from "vitest";
import {
  detectSourceFormatByName,
  fileExtensionsOf,
  NOT_YET_CONVERTIBLE_ON_WEB,
  openableFormatsOn,
} from "./source-format";

describe("openable formats", () => {
  it("desktop lists every format in the dialog order", () => {
    expect(fileExtensionsOf(openableFormatsOn("desktop"))).toEqual(["las", "laz", "e57", "ply", "pcd"]);
  });

  it("web lacks the formats in NOT_YET_CONVERTIBLE_ON_WEB", () => {
    expect(fileExtensionsOf(openableFormatsOn("web"))).toEqual(["las", "laz", "pcd"]);
    expect(NOT_YET_CONVERTIBLE_ON_WEB).toEqual(["ply", "e57"]);
  });

  it("unknown has no extensions", () => {
    expect(fileExtensionsOf(["unknown"])).toEqual([]);
  });
});

describe("detectSourceFormatByName", () => {
  it("las/lazをlasLazと判定する(大文字小文字を区別しない)", () => {
    expect(detectSourceFormatByName("raw.las")).toBe("lasLaz");
    expect(detectSourceFormatByName("raw.laz")).toBe("lasLaz");
    expect(detectSourceFormatByName("RAW.LAZ")).toBe("lasLaz");
  });

  it("pcd/ply/e57をそれぞれ判定する", () => {
    expect(detectSourceFormatByName("cloud.pcd")).toBe("pcd");
    expect(detectSourceFormatByName("mesh.ply")).toBe("ply");
    expect(detectSourceFormatByName("scan.e57")).toBe("e57");
    expect(detectSourceFormatByName("CLOUD.PCD")).toBe("pcd");
  });

  it("拡張子が無い、または未知の拡張子はunknownを返す", () => {
    expect(detectSourceFormatByName("no_extension")).toBe("unknown");
    expect(detectSourceFormatByName("archive.zip")).toBe("unknown");
  });

  it("既にCOPCの.copc.lazも拡張子としてはlasLaz扱いになる(呼び出し側は\
isCopcFileで先に判定済みの想定)", () => {
    expect(detectSourceFormatByName("autzen.copc.laz")).toBe("lasLaz");
  });
});
