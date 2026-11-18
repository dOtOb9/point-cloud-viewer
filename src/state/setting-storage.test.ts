import { describe, expect, it } from "vitest";
import { saveSettingIfStorageAllows } from "./setting-storage";

describe("saveSettingIfStorageAllows", () => {
  it("saves when the storage works", () => {
    const saved: string[] = [];
    saveSettingIfStorageAllows(() => saved.push("unit"));
    expect(saved).toEqual(["unit"]);
  });

  it("does not throw when the storage is unavailable (private window, blocked site data): the choice applies until the page is reloaded", () => {
    expect(() =>
      saveSettingIfStorageAllows(() => {
        throw new Error("SecurityError");
      }),
    ).not.toThrow();
  });
});
