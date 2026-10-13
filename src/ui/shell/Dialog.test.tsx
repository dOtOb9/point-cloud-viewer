// @vitest-environment jsdom
//
// ADR-0017: 共通Dialogの振る舞い(Esc・暗幕クリックで閉じる・✕は無い・フォーカスが中に移り、閉じると戻る・
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

  it("✕ボタンは無い", () => {
    const { container } = setup(true, () => {});
    expect(container.querySelector('button[aria-label="閉じる"]')).toBeNull();
  });

  it("閉じるとフォーカスが元の要素へ戻る", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { render } = setup(false, () => {});
    render(true);
    render(false);
    expect(document.activeElement).toBe(opener);
  });

  // mousedown→clickの順でイベントを流す。暗幕=role="dialog"の親要素。
  const press = (down: Element, up: Element) => {
    act(() => {
      down.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      up.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("暗幕クリック(押すのも離すのも暗幕)でonCloseが呼ばれる", () => {
    const onClose = vi.fn();
    const { container } = setup(true, onClose);
    const backdrop = container.querySelector('[role="dialog"]')?.parentElement as Element;
    press(backdrop, backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("パネル内のクリックでは閉じない", () => {
    const onClose = vi.fn();
    const { container } = setup(true, onClose);
    const panel = container.querySelector('[role="dialog"]') as Element;
    press(panel, panel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("パネル内で押して暗幕で離しても閉じない", () => {
    const onClose = vi.fn();
    const { container } = setup(true, onClose);
    const panel = container.querySelector('[role="dialog"]') as Element;
    const backdrop = panel.parentElement as Element;
    // 実ブラウザでは共通の祖先(暗幕)にclickが届き、targetは暗幕になる。
    press(panel, backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
