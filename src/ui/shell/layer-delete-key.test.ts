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
  it("修飾キーつきでは消さない", () => {
    expect(shouldDeleteLayerOnKey({ key: "Delete", target: null, ctrlKey: true }, true)).toBe(false);
  });
});
