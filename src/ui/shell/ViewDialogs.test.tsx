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
function fakeViewer(hasColor = true) {
  const setters = {
    setColorMode: vi.fn(),
    setEdlEnabled: vi.fn(),
    setPointShape: vi.fn(),
    setCenterPriorityStrength: vi.fn(),
    setMinCenterPriorityWeight: vi.fn(),
  };
  const viewer = {
    colorMode: "rgb",
    edlEnabled: true,
    pointShape: "round",
    centerPriorityStrength: 4,
    minCenterPriorityWeight: 0.2,
    cloudInfo: { hasColor },
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
  it("着色: ラジオを選ぶとsetColorModeが呼ばれる。RGBを持たないファイルではRGBが選べない", () => {
    const { viewer, setters } = fakeViewer(false);
    const m = mount(<ColorModeDialog viewer={viewer} open onClose={() => {}} />);
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="color-mode"]'));
    expect(radios.map((r) => r.value)).toEqual(["rgb", "elevation", "intensity", "classification"]);
    expect(radios[0].disabled).toBe(true);
    act(() => radios[1].click());
    expect(setters.setColorMode).toHaveBeenCalledWith("elevation");
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
