import { describe, expect, it } from "vitest";
import { resolveTheme } from "./useTheme";

describe("resolveTheme (M2-3)", () => {
  it("preferenceがsystemのとき、OSの明暗にそのまま従う", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("preferenceがdark/lightのとき、OSの明暗に関わらず固定される(設定画面からの手動固定)", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
