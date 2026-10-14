import { describe, expect, it } from "vitest";
import { settingsNavReducer, visibleSettingsPages } from "./settings-nav";

describe("settingsNavReducer", () => {
  it("一覧から専用ダイアログへ切り替わり、戻るで一覧に戻る", () => {
    expect(settingsNavReducer("list", { type: "open", page: "background" })).toBe("background");
    expect(settingsNavReducer("background", { type: "back" })).toBe("list");
  });
  it("resetは常に一覧", () => {
    expect(settingsNavReducer("pointBudget", { type: "reset" })).toBe("list");
  });
});

describe("visibleSettingsPages", () => {
  it("デスクトップ: 一時フォルダが出て、保存領域は出ない", () => {
    const p = visibleSettingsPages({ isBrowser: false, supportsCustomTempDir: true });
    expect(p).toContain("tempDir");
    expect(p).not.toContain("storage");
  });
  it("Android: どちらも出ない", () => {
    const p = visibleSettingsPages({ isBrowser: false, supportsCustomTempDir: false });
    expect(p).not.toContain("tempDir");
    expect(p).not.toContain("storage");
  });
  it("Web: 保存領域が出て、一時フォルダは出ない", () => {
    const p = visibleSettingsPages({ isBrowser: true, supportsCustomTempDir: true });
    expect(p).toContain("storage");
    expect(p).not.toContain("tempDir");
  });
});
