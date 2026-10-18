import { describe, expect, it } from "vitest";
import {
  detectSourceFormatByName,
  multiSourceFormatLabel,
  needsPointMerge,
  OPENABLE_EXTENSIONS,
} from "./source-format";

describe("OPENABLE_EXTENSIONS", () => {
  it("lists every format in the desktop dialog order", () => {
    expect([...OPENABLE_EXTENSIONS]).toEqual(["las", "laz", "e57", "ply", "pcd"]);
  });

  it("every openable extension is recognised by detectSourceFormatByName", () => {
    for (const ext of OPENABLE_EXTENSIONS) {
      expect(detectSourceFormatByName(`file.${ext}`)).not.toBe("unknown");
    }
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

// M4-17: which route a selection of several files takes.
describe("needsPointMerge", () => {
  it("is false for LAS/LAZ only (the LAS merge keeps every attribute)", () => {
    expect(needsPointMerge(["a.las", "b.LAZ", "c.copc.laz"])).toBe(false);
  });

  it("is true as soon as one file is PLY, PCD or E57", () => {
    expect(needsPointMerge(["a.las", "b.ply"])).toBe(true);
    expect(needsPointMerge(["a.pcd", "b.pcd"])).toBe(true);
    expect(needsPointMerge(["a.laz", "b.laz", "c.E57"])).toBe(true);
  });

  it("an unknown extension alone does not choose the point merge", () => {
    expect(needsPointMerge(["a.las", "b.zip"])).toBe(false);
  });
});

describe("multiSourceFormatLabel", () => {
  it("keeps the older wording for LAS/LAZ only", () => {
    expect(multiSourceFormatLabel(["a.las", "b.laz"])).toBe("las/laz(複数ファイル)");
  });

  it("uses the desktop wording for the point merge (mixed formats, or PLY/PCD/E57 only)", () => {
    expect(multiSourceFormatLabel(["b.ply", "a.las", "c.ply", "d.pcd"])).toBe("複数ファイル(形式混在)");
    expect(multiSourceFormatLabel(["a.pcd", "b.pcd"])).toBe("複数ファイル(形式混在)");
  });
});
