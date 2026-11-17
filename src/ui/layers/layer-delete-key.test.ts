import { describe, expect, it } from "vitest";
import { shouldDeleteLayerOnKey } from "./layer-delete-key";

describe("shouldDeleteLayerOnKey", () => {
  it("選択中のレイヤーがあり、フォーカスが普通の要素なら消す", () => {
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: { tagName: "DIV" } }, true)).toBe(true);
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: { tagName: "BUTTON" } }, true)).toBe(true);
  });
  it("選択中のレイヤーが無ければ消さない", () => {
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: null }, false)).toBe(false);
  });
  it("Delete 以外のキーでは消さない", () => {
    expect(shouldDeleteLayerOnKey({ key: "Backspace", target: null }, true)).toBe(false);
  });
  it("入力欄・テキストエリア・編集可能な要素にフォーカスがあるときは消さない", () => {
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: { tagName: "INPUT" } }, true)).toBe(false);
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: { tagName: "TEXTAREA" } }, true)).toBe(false);
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: { tagName: "DIV", isContentEditable: true } }, true)).toBe(false);
  });
  // Audit trendpoint-parity-PR R2 F-1: Delete deletes the selected layer at once (document listener, no confirmation).
  // A focused checkbox (layer visibility) or a radio / range in an open dialog must keep it safe, as before R1.
  it("R2 F-1 チェックボックス・ラジオ・スライダーにフォーカスがあるときも消さない（安全側）", () => {
    for (const type of ["checkbox", "radio", "range"]) {
      const target = { tagName: "INPUT", type };
      expect(shouldDeleteLayerOnKey({ key: "Delete", target }, true)).toBe(false);
    }
  });
  it("修飾キーつきでは消さない", () => {
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: null, ctrlKey: true }, true)).toBe(false);
  });
});
