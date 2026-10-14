// @vitest-environment jsdom
//
// L1-E: 設定の専用ダイアログ。背景はラジオ、点予算は手動値と自動調整、フッターは戻る・閉じる。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { BackgroundDialog, PointBudgetDialog } from "./SettingsPages";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fakeViewer() {
  const setters = {
    setBackgroundMode: vi.fn(),
    setGridEnabled: vi.fn(),
    setPointBudget: vi.fn(),
    setAutoPointBudgetEnabled: vi.fn(),
  };
  const viewer = {
    backgroundMode: "solid-dark",
    gridEnabled: false,
    pointBudget: 1_000_000,
    autoPointBudgetEnabled: false,
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

describe("SettingsPages", () => {
  it("背景: ラジオで3つから選べ、グリッドのチェックでsetterが呼ばれる", () => {
    const { viewer, setters } = fakeViewer();
    const m = mount(<BackgroundDialog viewer={viewer} open onBack={() => {}} onClose={() => {}} />);
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="background-mode"]'));
    expect(radios.map((r) => r.value)).toEqual(["solid-dark", "solid-light", "sky"]);
    expect(radios[0].checked).toBe(true);
    act(() => radios[2].click());
    expect(setters.setBackgroundMode).toHaveBeenCalledWith("sky");
    act(() => document.querySelector<HTMLInputElement>('input[name="grid-enabled"]')?.click());
    expect(setters.setGridEnabled).toHaveBeenCalledWith(true);
    unmount(m);
  });

  it("点予算: 自動調整のチェックでsetterが呼ばれる。自動中は手動の値を変えられない", () => {
    const { viewer, setters } = fakeViewer();
    const m = mount(<PointBudgetDialog viewer={viewer} open onBack={() => {}} onClose={() => {}} />);
    const input = document.querySelector<HTMLInputElement>('input[name="point-budget"]');
    expect(input?.disabled).toBe(false);
    act(() => document.querySelector<HTMLInputElement>('input[name="auto-point-budget"]')?.click());
    expect(setters.setAutoPointBudgetEnabled).toHaveBeenCalledWith(true);
    unmount(m);

    const auto = { ...viewer, autoPointBudgetEnabled: true } as CopcViewerState;
    const m2 = mount(<PointBudgetDialog viewer={auto} open onBack={() => {}} onClose={() => {}} />);
    expect(document.querySelector<HTMLInputElement>('input[name="point-budget"]')?.disabled).toBe(true);
    unmount(m2);
  });

  it("フッター: 戻る・閉じるが灰色(tertiary)で、それぞれのコールバックを呼ぶ", () => {
    const { viewer } = fakeViewer();
    const onBack = vi.fn();
    const onClose = vi.fn();
    const m = mount(<BackgroundDialog viewer={viewer} open onBack={onBack} onClose={onClose} />);
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
    const back = buttons.find((b) => b.textContent === "戻る");
    const close = buttons.find((b) => b.textContent === "閉じる");
    expect(back?.className).toContain("bg-tertiary");
    expect(close?.className).toContain("bg-tertiary");
    act(() => back?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount(m);
  });
});
