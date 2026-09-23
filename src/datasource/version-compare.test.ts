import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./version-compare";

describe("isNewerVersion", () => {
  it("パッチ/マイナー/メジャーのどれが上がっても新しいと判定する", () => {
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "1.0.0")).toBe(true);
  });

  it("同じバージョンはfalse", () => {
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
  });

  it("古いバージョンはfalse", () => {
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(false);
  });

  it("先頭の'v'の有無を無視する(GitHubのtag_nameは'v0.1.0'形式)", () => {
    expect(isNewerVersion("0.1.0", "v0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "v0.1.0")).toBe(false);
  });

  it("桁数が違っても正しく比較する(0.1 と 0.1.0 は同じ扱い)", () => {
    expect(isNewerVersion("0.1", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1", "0.1.1")).toBe(true);
  });

  it("プレリリース識別子は無視して数値部分だけを比較する", () => {
    expect(isNewerVersion("0.1.0", "0.1.1-beta.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0-beta.1")).toBe(false);
  });
});
