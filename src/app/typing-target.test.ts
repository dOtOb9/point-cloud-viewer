import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./typing-target";

describe("isTypingTarget", () => {
  it("is true for input, textarea, select (any case) and contenteditable", () => {
    for (const tagName of ["INPUT", "textarea", "Select"]) expect(isTypingTarget({ tagName })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("an input with no type, or a text-like type, takes typed keys", () => {
    for (const type of [undefined, "", "text", "search", "number", "email", "password", "TEXT"]) {
      expect(isTypingTarget({ tagName: "INPUT", type })).toBe(true);
    }
  });
  it("an input that takes no text (radio, checkbox, button, range, ...) is not a typing target", () => {
    for (const type of ["radio", "checkbox", "button", "submit", "reset", "range", "color", "file", "RADIO"]) {
      expect(isTypingTarget({ tagName: "INPUT", type })).toBe(false);
    }
  });
  it("is false for other elements, null and non-objects", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget("input")).toBe(false);
  });
});
