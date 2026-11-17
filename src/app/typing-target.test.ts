import { describe, expect, it } from "vitest";
import { isFormControl, isTypingTarget } from "./typing-target";

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
  it("isFormControl: every input type (also radio, checkbox, range, button), textarea, select and contenteditable", () => {
    for (const type of [undefined, "text", "radio", "checkbox", "range", "button", "submit", "file", "RADIO"]) {
      expect(isFormControl({ tagName: "INPUT", type })).toBe(true);
    }
    expect(isFormControl({ tagName: "textarea" })).toBe(true);
    expect(isFormControl({ tagName: "SELECT" })).toBe(true);
    expect(isFormControl({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isFormControl({ tagName: "BUTTON" })).toBe(false);
    expect(isFormControl(null)).toBe(false);
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
