// @vitest-environment jsdom
//
// ADR-0017追記: リボンから開く3つのダイアログで値を変えると、viewerのsetterが呼ばれることを確かめる。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { AppearanceDialog, ColorModeDialog, LoadPriorityDialog } from "./ViewDialogs";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** ダイアログが読み書きする項目だけを持つ偽のviewer。 */
function fakeViewer(hasColor = true, layerName: string | null = "a.copc.laz") {
  const setters = {
    setLayerColorMode: vi.fn(),
    setEdlEnabled: vi.fn(),
    setPointShape: vi.fn(),
    setCenterPriorityStrength: vi.fn(),
    setMinCenterPriorityWeight: vi.fn(),
  };
  const viewer = {
    edlEnabled: true,
    pointShape: "round",
    centerPriorityStrength: 4,
    minCenterPriorityWeight: 0.2,
    selectedLayer: layerName === null ? null : { id: "layer-1", name: layerName, info: { hasColor }, colorMode: "rgb" },
    ...setters,
  } as unknown as CopcViewerState;
  return { viewer, setters };
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { root, container };
}

function unmount(m: { root: ReturnType<typeof createRoot>; container: HTMLElement }) {
  act(() => m.root.unmount());
  m.container.remove();
}

describe("ViewDialogs", () => {
  it("着色: ラジオを選ぶと選択中のレイヤーのsetLayerColorModeが呼ばれる。RGBを持たないレイヤーではRGBが選べない", () => {
    const { viewer, setters } = fakeViewer(false);
    const m = mount(<ColorModeDialog viewer={viewer} open onClose={() => {}} />);
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="color-mode"]'));
    expect(radios.map((r) => r.value)).toEqual(["rgb", "elevation", "intensity", "classification"]);
    expect(radios[0].disabled).toBe(true);
    act(() => radios[1].click());
    expect(setters.setLayerColorMode).toHaveBeenCalledWith("layer-1", "elevation");
    expect(document.body.textContent).toContain("a.copc.laz");
    unmount(m);
  });

  it("着色: レイヤーが無いときは全部選べず、その旨が出る", () => {
    const { viewer } = fakeViewer(true, null);
    const m = mount(<ColorModeDialog viewer={viewer} open onClose={() => {}} />);
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="color-mode"]'));
    expect(radios.every((r) => r.disabled)).toBe(true);
    expect(document.body.textContent).toContain("着色を変えるレイヤーがありません");
    unmount(m);
  });

  it("見た目: EDLのチェックと点の形でsetterが呼ばれる", () => {
    const { viewer, setters } = fakeViewer();
    const m = mount(<AppearanceDialog viewer={viewer} open onClose={() => {}} />);
    act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    expect(setters.setEdlEnabled).toHaveBeenCalledWith(false);
    act(() => document.querySelector<HTMLInputElement>('input[name="point-shape"][value="square"]')?.click());
    expect(setters.setPointShape).toHaveBeenCalledWith("square");
    unmount(m);
  });

  it("読み込み優先: スライダーを動かすとsetterが数値で呼ばれる", () => {
    const { viewer, setters } = fakeViewer();
    const m = mount(<LoadPriorityDialog viewer={viewer} open onClose={() => {}} />);
    const [strength, minWeight] = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="range"]'));
    // Reactは値をプロトタイプのsetter経由で追跡するので、同じ経路で値を入れてからinputイベントを送る。
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(strength, "8");
      strength.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(setters.setCenterPriorityStrength).toHaveBeenCalledWith(8);
    act(() => {
      setValue?.call(minWeight, "0.3");
      minWeight.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(setters.setMinCenterPriorityWeight).toHaveBeenCalledWith(0.3);
    unmount(m);
  });

  it("フッターの「閉じる」でonCloseが呼ばれる", () => {
    const { viewer } = fakeViewer();
    const onClose = vi.fn();
    const m = mount(<ColorModeDialog viewer={viewer} open onClose={onClose} />);
    const close = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("閉じる"));
    act(() => close?.click());
    expect(onClose).toHaveBeenCalled();
    unmount(m);
  });
});
