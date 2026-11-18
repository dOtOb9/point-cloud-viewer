import { describe, expect, it } from "vitest";
import { buildNodeRequestPath } from "./tauri-protocol";

describe("buildNodeRequestPath", () => {
  it("世代番号とノードキーを'/'区切りで組み立てる", () => {
    expect(buildNodeRequestPath(0, "1-1-1-1")).toBe("0/1-1-1-1");
  });

  it("世代番号が進んでも区切りの位置がぶれない", () => {
    expect(buildNodeRequestPath(42, "3-0-0-0")).toBe("42/3-0-0-0");
  });

  it("ベンチ用の'/<size>'形式(数字のみ)とは常に区別できる('/'を含む)", () => {
    const path = buildNodeRequestPath(0, "0-0-0-0");
    expect(path).toContain("/");
    expect(Number.isNaN(Number(path))).toBe(true);
  });
});
