// @vitest-environment jsdom
//
// L2-A: レイヤー操作のボタン列。レイヤーが無いときは無効、あれば削除ボタンと Delete キーで消せる。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { LayerActions } from "./LayerActions";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fakeViewer(hasLayer: boolean) {
  const removeLayer = vi.fn();
  const focusLayer = vi.fn();
  const viewer = {
    selectedLayer: hasLayer ? { id: "layer-1", name: "a.copc.laz", colorMode: "rgb", info: { hasColor: true } } : null,
    removeLayer,
    focusLayer,
    setLayerColorMode: vi.fn(),
    edlEnabled: true,
    setEdlEnabled: vi.fn(),
  } as unknown as CopcViewerState;
  return { viewer, removeLayer, focusLayer };
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

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="layer-actions"] button'));

describe("LayerActions", () => {
  it("レイヤーが無いときは着色・見た目・削除が全部無効", () => {
    const { viewer } = fakeViewer(false);
    const cleanup = mount(<LayerActions viewer={viewer} />);
    expect(buttons().map((b) => b.textContent)).toEqual(["着色", "見た目", "移動", "削除"]);
    expect(buttons().every((b) => b.disabled)).toBe(true);
    cleanup();
  });

  it("計測レイヤーを選んでいるときは着色・見た目が無効で、移動・削除は有効（L2-F）", () => {
    const { viewer } = fakeViewer(true);
    (viewer as unknown as { selectedLayer: object }).selectedLayer = {
      id: "layer-2",
      name: "距離 1",
      colorMode: "elevation",
      pointShape: "round",
      pointSize: 4,
      info: { hasColor: false },
      measurement: { kind: "distance", points: [], up: [0, 0, 1] },
    };
    const cleanup = mount(<LayerActions viewer={viewer} />);
    const state = Object.fromEntries(buttons().map((b) => [b.textContent, b.disabled]));
    expect(state).toEqual({ 着色: true, 見た目: true, 移動: false, 削除: false });
    cleanup();
  });

  it("削除ボタンで選択中のレイヤーのremoveLayerが呼ばれる", () => {
    const { viewer, removeLayer } = fakeViewer(true);
    const cleanup = mount(<LayerActions viewer={viewer} />);
    const del = buttons().find((b) => b.textContent === "削除");
    expect(del?.disabled).toBe(false);
    act(() => del?.click());
    expect(removeLayer).toHaveBeenCalledWith("layer-1");
    cleanup();
  });

  it("移動ボタンで選択中のレイヤーのfocusLayerが呼ばれる", () => {
    const { viewer, focusLayer } = fakeViewer(true);
    const cleanup = mount(<LayerActions viewer={viewer} />);
    act(() => buttons().find((b) => b.textContent === "移動")?.click());
    expect(focusLayer).toHaveBeenCalledWith("layer-1");
    cleanup();
  });

  it("Delete キーで消えるが、入力欄にフォーカスがあるときは消えない", () => {
    const { viewer, removeLayer } = fakeViewer(true);
    const cleanup = mount(<LayerActions viewer={viewer} />);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(removeLayer).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(removeLayer).toHaveBeenCalledTimes(1);
    input.remove();
    cleanup();
  });

  it("着色ボタンで着色ダイアログが開く", () => {
    const { viewer } = fakeViewer(true);
    const cleanup = mount(<LayerActions viewer={viewer} />);
    act(() => buttons().find((b) => b.textContent === "着色")?.click());
    expect(document.body.textContent).toContain("点の色の付け方");
    cleanup();
  });
});
