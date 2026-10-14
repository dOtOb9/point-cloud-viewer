// @vitest-environment jsdom
//
// L1-D: レイヤー欄の操作（チェックで表示切替、行クリックで選択、右クリックのメニューから削除、Escで閉じる）。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { LayerList } from "./LayerList";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fakeViewer(status: string = "ready") {
  const fns = { selectLayer: vi.fn(), setLayerVisible: vi.fn(), removeLayer: vi.fn() };
  const viewer = {
    status,
    layers: [
      { id: "layer-1", name: "a.copc.laz", visible: true },
      { id: "layer-2", name: "b.copc.laz", visible: false },
    ],
    selectedLayerId: "layer-1",
    ...fns,
  } as unknown as CopcViewerState;
  return { viewer, fns };
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

describe("LayerList", () => {
  it("チェックで表示を切り替える。行の選択は起きない", () => {
    const { viewer, fns } = fakeViewer();
    const cleanup = mount(<LayerList viewer={viewer} />);
    const boxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    act(() => boxes[1].click());
    expect(fns.setLayerVisible).toHaveBeenCalledWith("layer-2", true);
    expect(fns.selectLayer).not.toHaveBeenCalled();
    cleanup();
  });

  it("行クリックで選択", () => {
    const { viewer, fns } = fakeViewer();
    const cleanup = mount(<LayerList viewer={viewer} />);
    const rows = document.querySelectorAll<HTMLElement>('[data-testid="layer-row"]');
    act(() => rows[1].click());
    expect(fns.selectLayer).toHaveBeenCalledWith("layer-2");
    cleanup();
  });

  it("右クリックでメニューが出て「削除」でremoveLayerが呼ばれ、メニューは閉じる", () => {
    const { viewer, fns } = fakeViewer();
    const cleanup = mount(<LayerList viewer={viewer} />);
    const rows = document.querySelectorAll<HTMLElement>('[data-testid="layer-row"]');
    act(() => {
      rows[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
    });
    const item = document.querySelector<HTMLElement>('[data-testid="layer-context-menu"] button');
    expect(item?.textContent).toBe("削除");
    act(() => item?.click());
    expect(fns.removeLayer).toHaveBeenCalledWith("layer-2");
    expect(document.querySelector('[data-testid="layer-context-menu"]')).toBeNull();
    cleanup();
  });

  it("Escと外側クリックでメニューが閉じる", () => {
    const { viewer, fns } = fakeViewer();
    const cleanup = mount(<LayerList viewer={viewer} />);
    const row = document.querySelector<HTMLElement>('[data-testid="layer-row"]');
    const open = () =>
      act(() => {
        row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
    open();
    expect(document.querySelector('[data-testid="layer-context-menu"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-testid="layer-context-menu"]')).toBeNull();
    open();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="layer-context-menu"]')).toBeNull();
    expect(fns.removeLayer).not.toHaveBeenCalled();
    cleanup();
  });

  it("読み込み中は「読み込み中…」の行が出る", () => {
    const { viewer } = fakeViewer("opening");
    const cleanup = mount(<LayerList viewer={viewer} />);
    expect(document.body.textContent).toContain("読み込み中…");
    cleanup();
  });
});
