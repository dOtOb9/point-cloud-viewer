import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./typing-target";

describe("isTypingTarget", () => {
  it("is true for input, textarea, select (any case) and contenteditable", () => {
    for (const tagName of ["INPUT", "textarea", "Select"]) expect(isTypingTarget({ tagName })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("is false for other elements, null and non-objects", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget("input")).toBe(false);
  });
});
