// @vitest-environment jsdom
//
// TP-1: the view dialog and the view button. The dialog only shows the state and calls src/app/view.ts, so the
// test passes a fake renderer through the context.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { ViewButton } from "../toolbar/buttons/ViewButton";
import { attachViewRenderer, createViewContext } from "../../app/view";
import { ViewDialog } from "./ViewDialog";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fakeViewer(opts: { preset?: string | null; mode?: "perspective" | "orthographic"; layers?: unknown[] } = {}) {
  const renderer = { setViewPreset: vi.fn(() => true), fitAll: vi.fn(() => true), setProjectionMode: vi.fn() };
  const setProjectionMode = renderer.setProjectionMode;
  const mode = opts.mode ?? "perspective";
  const context = createViewContext();
  context.pointCloud.set(true);
  context.projection.set(mode);
  attachViewRenderer(context, renderer);
  const viewer = {
    layers: opts.layers ?? [{ id: "a", kind: "pointcloud" }],
    stats: { viewPreset: opts.preset ?? null },
  } as unknown as CopcViewerState;
  return { viewer, renderer, setProjectionMode, context };
}

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

describe("ViewDialog", () => {
  it("has 全体 and the six viewpoints with their keys, and a button is at least 44px high (min-h-11)", () => {
    const { viewer, context } = fakeViewer();
    mount(<ViewDialog viewer={viewer} onClose={() => {}} context={context} />);
    const text = document.body.textContent ?? "";
    for (const name of ["全体", "上", "正面", "背面", "左", "右", "等角", "透視投影", "平行投影"]) expect(text).toContain(name);
    expect(document.querySelector('[data-testid="view-preset-top"]')?.textContent).toContain("(1)");
    expect(document.querySelector('[data-testid="view-fit"]')?.className).toContain("min-h-11");
    expect(document.querySelectorAll('[data-testid^="view-preset-"]').length).toBe(6);
  });

  it("pressing a viewpoint moves the view at once and keeps the dialog open", () => {
    const { viewer, renderer, context } = fakeViewer();
    const onClose = vi.fn();
    mount(<ViewDialog viewer={viewer} onClose={onClose} context={context} />);
    act(() => (document.querySelector('[data-testid="view-preset-front"]') as HTMLElement).click());
    expect(renderer.setViewPreset).toHaveBeenCalledWith("front");
    act(() => (document.querySelector('[data-testid="view-fit"]') as HTMLElement).click());
    expect(renderer.fitAll).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks the current viewpoint", () => {
    const { viewer, context } = fakeViewer({ preset: "top" });
    mount(<ViewDialog viewer={viewer} onClose={() => {}} context={context} />);
    expect(document.querySelector('[data-testid="view-preset-top"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[data-testid="view-preset-front"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("choosing the orthographic projection calls the setter; the current one is checked", () => {
    const { viewer, setProjectionMode, context } = fakeViewer({ mode: "perspective" });
    mount(<ViewDialog viewer={viewer} onClose={() => {}} context={context} />);
    const radios = document.querySelectorAll<HTMLInputElement>('[data-testid="view-projection"] input[type="radio"]');
    expect(radios[0].checked).toBe(true);
    act(() => radios[1].click());
    expect(setProjectionMode).toHaveBeenCalledWith("orthographic");
  });

  it("Esc closes it", () => {
    const { viewer, context } = fakeViewer();
    const onClose = vi.fn();
    mount(<ViewDialog viewer={viewer} onClose={onClose} context={context} />);
    const panel = document.querySelector('[role="dialog"]') as HTMLElement;
    act(() => {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ViewButton", () => {
  it("is disabled without a point-cloud layer and enabled with one; the tooltip lists the keys", () => {
    const empty = mount(<ViewButton viewer={fakeViewer({ layers: [] }).viewer} onOpen={() => {}} />);
    const disabledButton = empty.container.querySelector("button") as HTMLButtonElement;
    expect(disabledButton.disabled).toBe(true);
    expect(disabledButton.textContent).toContain("視点");

    const onOpen = vi.fn();
    const full = mount(<ViewButton viewer={fakeViewer().viewer} onOpen={onOpen} />);
    const button = full.container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toContain("F: 全体");
    expect(button.title).toContain("5: 透視・平行");
    act(() => button.click());
    expect(onOpen).toHaveBeenCalled();
  });
});
