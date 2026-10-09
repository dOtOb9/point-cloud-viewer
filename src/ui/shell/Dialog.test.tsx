// @vitest-environment jsdom
//
// ADR-0017: 共通Dialogの振る舞い(Escで閉じる・フォーカスが中に移り、閉じると戻る・
// 閉じているときは何も描画しない)を確かめる。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setup(open: boolean, onClose: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (isOpen: boolean) =>
    act(() => {
      root.render(
        <Dialog open={isOpen} title="テスト" onClose={onClose} footer={<button type="button">フッター</button>}>
          <button type="button" data-testid="first">
            本文のボタン
          </button>
        </Dialog>,
      );
    });
  render(open);
  return { container, render, root };
}

describe("Dialog", () => {
  it("閉じているときは何も描画しない", () => {
    const { container } = setup(false, () => {});
    expect(container.innerHTML).toBe("");
  });

  it("開くと本文の最初の操作要素にフォーカスが移り、EscでonCloseが呼ばれる", () => {
    const onClose = vi.fn();
    const { container } = setup(true, onClose);
    const first = container.querySelector('[data-testid="first"]');
    expect(document.activeElement).toBe(first);
    act(() => {
      first?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("✕ボタンでonCloseが呼ばれ、閉じるとフォーカスが元の要素へ戻る", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { container, render } = setup(false, onClose);
    render(true);
    const closeButton = container.querySelector('button[aria-label="閉じる"]') as HTMLButtonElement;
    act(() => closeButton.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    render(false);
    expect(document.activeElement).toBe(opener);
  });
});
