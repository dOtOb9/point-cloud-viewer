// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachViewRenderer, createViewContext, detachViewRenderer, syncViewWithLayers, syncViewWithStats, type ViewContext } from "../../app/view";
import type { PluginHostCore, ShortcutKeyEvent } from "../../core/plugin-host";
import { VIEW_PRESET_IDS as API_VIEW_PRESET_IDS } from "../../plugin-api";
import { viewPlugin } from "../../plugins/view";
import { VIEW_PRESET_LABELS as PLUGIN_VIEW_PRESET_LABELS } from "../../plugins/view/labels";
import { VIEW_PRESET_IDS, VIEW_PRESET_LABELS } from "../../renderer/view-presets";
import type { ViewerLayer } from "../../state/layers";
import { PluginDialogs } from "./PluginDialogs";
import { PluginRibbonItems } from "./PluginRibbonItems";
import { PluginStatusItems } from "./PluginStatusItems";
import { usePluginHost } from "./usePluginHost";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const pointCloud = { id: "a" } as unknown as ViewerLayer;
const measurement = { id: "m", measurement: { kind: "distance" } } as unknown as ViewerLayer;

const PLUGINS = [viewPlugin];

function Shell({ ctx, onHost }: { ctx: ViewContext; onHost: (host: PluginHostCore) => void }) {
  const host = usePluginHost(PLUGINS, { reportError: () => {}, view: ctx });
  onHost(host);
  return (
    <div>
      <div data-testid="ribbon-slot">
        <PluginRibbonItems host={host} group="view" />
      </div>
      <div data-testid="status-slot">
        <PluginStatusItems host={host} />
      </div>
      <PluginDialogs host={host} />
    </div>
  );
}

function fakeRenderer() {
  return { setViewPreset: vi.fn(() => true), fitAll: vi.fn(() => true), setProjectionMode: vi.fn() };
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mountViewer(layers: ViewerLayer[] = [pointCloud]) {
  const ctx = createViewContext();
  const renderer = fakeRenderer();
  attachViewRenderer(ctx, renderer);
  syncViewWithLayers(ctx, layers);
  let host: PluginHostCore | null = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Shell ctx={ctx} onHost={(h) => (host = h)} />));
  const setLayers = (next: ViewerLayer[]) => act(() => syncViewWithLayers(ctx, next));
  const setStats = (stats: { viewPreset: (typeof VIEW_PRESET_IDS)[number] | null; layerCount: number }) => act(() => syncViewWithStats(ctx, stats));
  return { ctx, renderer, host: () => host!, setLayers, setStats };
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function viewButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>("view-button")!;
}

function click(el: HTMLElement) {
  act(() => el.click());
}

function openDialog() {
  click(viewButton());
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

function press(key: string, target: EventTarget = window, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("pcv.view: the ribbon button", () => {
  it("is disabled without a point-cloud layer, with the hint as its tooltip", () => {
    mountViewer([measurement]);
    const button = viewButton();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("視点");
    expect(button.title).toBe("点群を開くと、視点を変えられる");
  });

  it("is enabled with one and the tooltip lists the keys", () => {
    mountViewer();
    const button = viewButton();
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("視点を変える（F: 全体 / 1: 上 / 2: 正面 / 3: 右 / 4: 等角 / 5: 透視・平行の切り替え / 6: 背面 / 7: 左）");
  });

  it("follows opening and closing the point cloud without being made again", () => {
    const viewer = mountViewer([]);
    const button = viewButton();
    viewer.setLayers([pointCloud]);
    expect(viewButton()).toBe(button);
    expect(button.disabled).toBe(false);
    viewer.setLayers([measurement]);
    expect(viewButton()).toBe(button);
    expect(button.disabled).toBe(true);
  });

  it("opens the viewpoint dialog once, however often it is pressed", () => {
    mountViewer();
    openDialog();
    click(viewButton());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("視点");
  });
});

describe("pcv.view: the dialog", () => {
  it("has 全体 and the six viewpoints with their keys, and a button is at least 44px high (min-h-11)", () => {
    mountViewer();
    openDialog();
    const text = document.body.textContent ?? "";
    for (const name of ["全体", "上", "正面", "背面", "左", "右", "等角", "透視投影", "平行投影"]) expect(text).toContain(name);
    expect(byTestId("view-preset-top")?.textContent).toContain("(1)");
    expect(byTestId("view-fit")?.className).toContain("min-h-11");
    expect(document.querySelectorAll('[data-testid^="view-preset-"]').length).toBe(6);
    expect(VIEW_PRESET_IDS.every((id) => byTestId(`view-preset-${id}`) !== null)).toBe(true);
    expect(byTestId("view-presets")).not.toBeNull();
    expect(byTestId("view-projection")).not.toBeNull();
  });

  it("is the narrow side panel with 閉じる in its footer", () => {
    mountViewer();
    const dialog = openDialog();
    expect(dialog.className).toContain("max-w-xs");
    expect(dialog.parentElement!.className).toContain("md:justify-end");
    const footerButton = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "閉じる");
    expect(footerButton).toBeDefined();
  });

  it("pressing a viewpoint moves the view at once and keeps the dialog open", () => {
    const { renderer } = mountViewer();
    openDialog();
    click(byTestId("view-preset-front")!);
    expect(renderer.setViewPreset).toHaveBeenCalledWith("front");
    click(byTestId("view-fit")!);
    expect(renderer.fitAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("marks the current viewpoint, and follows the renderer when it changes", () => {
    const viewer = mountViewer();
    viewer.setStats({ viewPreset: "top", layerCount: 1 });
    openDialog();
    expect(byTestId("view-preset-top")?.getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("view-preset-front")?.getAttribute("aria-pressed")).toBe("false");
    viewer.setStats({ viewPreset: "front", layerCount: 1 });
    expect(byTestId("view-preset-top")?.getAttribute("aria-pressed")).toBe("false");
    expect(byTestId("view-preset-front")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("choosing the orthographic projection tells the renderer; the current one is checked", () => {
    const { renderer } = mountViewer();
    openDialog();
    const radios = () => document.querySelectorAll<HTMLInputElement>('[data-testid="view-projection"] input[type="radio"]');
    expect(radios()[0].checked).toBe(true);
    act(() => radios()[1].click());
    expect(renderer.setProjectionMode).toHaveBeenLastCalledWith("orthographic");
    expect(radios()[1].checked).toBe(true);
  });

  it.each([
    ["Esc", () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
    ["閉じる", () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "閉じる")!.click()],
  ])("%s closes it, and the ribbon button opens it again", (_how, close) => {
    mountViewer();
    openDialog();
    act(() => {
      close();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    openDialog();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("stays open when the point cloud is closed, and its buttons then do nothing", () => {
    const viewer = mountViewer();
    openDialog();
    viewer.setLayers([measurement]);
    click(byTestId("view-fit")!);
    click(byTestId("view-preset-top")!);
    expect(viewer.renderer.fitAll).not.toHaveBeenCalled();
    expect(viewer.renderer.setViewPreset).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("pcv.view: the status bar item", () => {
  it("shows nothing until the renderer draws a layer", () => {
    const viewer = mountViewer();
    expect(byTestId("view-status")).toBeNull();
    expect(byTestId("status-slot")!.textContent).toBe("");
    viewer.setStats({ viewPreset: null, layerCount: 0 });
    expect(byTestId("view-status")).toBeNull();
  });

  it("names the viewpoint and the projection, with a short text for a narrow screen", () => {
    const viewer = mountViewer();
    viewer.setStats({ viewPreset: "top", layerCount: 1 });
    const status = byTestId("view-status")!;
    expect(status.querySelector(".hidden.md\\:inline")!.textContent).toBe("視点: 上（透視投影）");
    expect(status.querySelector(".md\\:hidden")!.textContent).toBe("上・透視");
    press("5");
    expect(byTestId("view-status")!.querySelector(".hidden.md\\:inline")!.textContent).toBe("視点: 上（平行投影）");
  });
});

describe("pcv.view: keyboard shortcuts (UX-4)", () => {
  it("F / f / 1 / 2 / 3 / 4 / 6 / 7 are fit, top, front, right, isometric, back, left", () => {
    const { renderer } = mountViewer();
    press("f");
    press("F");
    expect(renderer.fitAll).toHaveBeenCalledTimes(2);
    for (const [key, id] of [
      ["1", "top"],
      ["2", "front"],
      ["3", "right"],
      ["4", "isometric"],
      ["6", "back"],
      ["7", "left"],
    ]) {
      press(key);
      expect(renderer.setViewPreset).toHaveBeenLastCalledWith(id);
    }
  });

  it("5 switches the projection while a point cloud is open, and the key is taken", () => {
    const { ctx, renderer } = mountViewer();
    const event = press("5");
    expect(ctx.state.get().projection).toBe("orthographic");
    expect(renderer.setProjectionMode).toHaveBeenLastCalledWith("orthographic");
    expect(event.defaultPrevented).toBe(true);
    press("5");
    expect(ctx.state.get().projection).toBe("perspective");
  });

  it("with only measurement layers left, 5 changes nothing and the key is not taken", () => {
    const { ctx } = mountViewer([measurement]);
    const event = press("5");
    expect(ctx.state.get().projection).toBe("perspective");
    expect(event.defaultPrevented).toBe(false);
  });

  it("with no layer at all the keys do nothing", () => {
    const { ctx, renderer } = mountViewer([]);
    press("5");
    press("F");
    press("1");
    expect(ctx.state.get().projection).toBe("perspective");
    expect(renderer.fitAll).not.toHaveBeenCalled();
    expect(renderer.setViewPreset).not.toHaveBeenCalled();
  });

  it("follows the layer list: deleting the point cloud stops the keys, opening one starts them", () => {
    const viewer = mountViewer([pointCloud, measurement]);
    press("5");
    expect(viewer.ctx.state.get().projection).toBe("orthographic");
    viewer.setLayers([measurement]);
    press("5");
    expect(viewer.ctx.state.get().projection).toBe("orthographic");
    viewer.setLayers([measurement, pointCloud]);
    press("5");
    expect(viewer.ctx.state.get().projection).toBe("perspective");
  });

  it("F-1 the keys still work while a radio button (the dialog's projection choice) has focus", () => {
    const { ctx } = mountViewer();
    openDialog();
    const radio = document.querySelector<HTMLInputElement>('[data-testid="view-projection"] input[type="radio"]')!;
    radio.focus();
    press("5", radio);
    expect(ctx.state.get().projection).toBe("orthographic");
  });

  it("keys typed in a field are not shortcuts", () => {
    const { ctx, renderer } = mountViewer();
    for (const make of [
      () => Object.assign(document.createElement("input"), { type: "text" }),
      () => document.createElement("textarea"),
      () => document.createElement("select"),
    ]) {
      const field = make();
      document.body.appendChild(field);
      const event = press("5", field);
      press("1", field);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(ctx.state.get().projection).toBe("perspective");
    expect(renderer.setViewPreset).not.toHaveBeenCalled();
  });

  it("keys typed in a contenteditable element are not shortcuts", () => {
    const viewer = mountViewer();
    const event: ShortcutKeyEvent = {
      key: "f",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: { tagName: "DIV", isContentEditable: true },
      preventDefault: vi.fn(),
    };
    act(() => viewer.host().handleKeyDown(event));
    expect(viewer.renderer.fitAll).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keys with Ctrl / Meta / Alt, held keys and IME composition are not shortcuts", () => {
    const { renderer } = mountViewer();
    press("f", window, { ctrlKey: true });
    press("f", window, { metaKey: true });
    press("1", window, { altKey: true });
    press("1", window, { repeat: true });
    press("1", window, { isComposing: true });
    expect(renderer.fitAll).not.toHaveBeenCalled();
    expect(renderer.setViewPreset).not.toHaveBeenCalled();
  });

  it("other keys are ignored", () => {
    const { ctx, renderer } = mountViewer();
    for (const key of ["Enter", "x", "8"]) expect(press(key).defaultPrevented).toBe(false);
    expect(ctx.state.get().projection).toBe("perspective");
    expect(renderer.fitAll).not.toHaveBeenCalled();
  });
});

describe("pcv.view: the projection survives the renderer being made again (F11)", () => {
  it("a new renderer gets the mode chosen with the old one", () => {
    const viewer = mountViewer();
    press("5");
    detachViewRenderer(viewer.ctx);
    const next = fakeRenderer();
    attachViewRenderer(viewer.ctx, next);
    expect(next.setProjectionMode).toHaveBeenCalledWith("orthographic");
    press("F");
    expect(next.fitAll).toHaveBeenCalledTimes(1);
    expect(viewer.renderer.fitAll).not.toHaveBeenCalled();
  });

  it("a renderer attached later gets the mode chosen while there was none", () => {
    const viewer = mountViewer();
    detachViewRenderer(viewer.ctx);
    press("5");
    const next = fakeRenderer();
    attachViewRenderer(viewer.ctx, next);
    expect(next.setProjectionMode).toHaveBeenCalledWith("orthographic");
  });
});

describe("pcv.view names the same viewpoints as the renderer", () => {
  it("the plugin API's viewpoints and the plugin's labels are the renderer's", () => {
    expect(API_VIEW_PRESET_IDS).toEqual(VIEW_PRESET_IDS);
    expect(PLUGIN_VIEW_PRESET_LABELS).toEqual(VIEW_PRESET_LABELS);
  });
});

function countingSubscriptions(ctx: ViewContext) {
  const live = { count: 0 };
  for (const store of [ctx.state, ctx.pointCloud]) {
    const subscribe = store.subscribe;
    store.subscribe = (listener) => {
      live.count++;
      const stop = subscribe(listener);
      return () => {
        live.count--;
        stop();
      };
    };
  }
  return live;
}

describe("pcv.view stops listening when it is deactivated", () => {
  it("drops every subscription to the view context when the shell unmounts", () => {
    const ctx = createViewContext();
    const live = countingSubscriptions(ctx);
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<Shell ctx={ctx} onHost={() => {}} />));
    expect(live.count).toBeGreaterThan(0);
    act(() => root!.unmount());
    root = null;
    expect(live.count).toBe(0);
  });
});
