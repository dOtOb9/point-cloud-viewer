import { describe, expect, it, vi } from "vitest";
import {
  attachViewRenderer,
  createViewContext,
  detachViewRenderer,
  fitAllView,
  runViewAction,
  shortcutKeyOfPreset,
  showViewPreset,
  viewActionForKey,
  viewStatusText,
  VIEW_SHORTCUTS,
  type ViewContext,
} from "./view";
import { VIEW_PRESET_IDS } from "../renderer/view-presets";

function makeContext(opts: { attach?: boolean; mode?: "perspective" | "orthographic" } = {}) {
  const renderer = { setViewPreset: vi.fn(() => true), fitAll: vi.fn(() => true), setProjectionMode: vi.fn() };
  const ctx: ViewContext = createViewContext();
  ctx.pointCloud.set(true);
  if (opts.mode) ctx.projection.set(opts.mode);
  if (opts.attach !== false) attachViewRenderer(ctx, renderer);
  return { ctx, renderer, setProjectionMode: renderer.setProjectionMode };
}

const plain = { ctrlKey: false, metaKey: false, altKey: false, target: { tagName: "DIV" } };

describe("view actions", () => {
  it("a preset goes to the renderer", () => {
    const { ctx, renderer } = makeContext();
    expect(showViewPreset(ctx, "front")).toBe(true);
    expect(renderer.setViewPreset).toHaveBeenCalledWith("front");
  });

  it("fit all goes to the renderer", () => {
    const { ctx, renderer } = makeContext();
    expect(fitAllView(ctx)).toBe(true);
    expect(renderer.fitAll).toHaveBeenCalledTimes(1);
  });

  it("does nothing (and does not fail) before the renderer exists", () => {
    const { ctx } = makeContext({ attach: false });
    expect(fitAllView(ctx)).toBe(false);
    expect(showViewPreset(ctx, "top")).toBe(false);
  });

  it("reports false when the renderer has no visible layer", () => {
    const { ctx, renderer } = makeContext();
    renderer.fitAll.mockReturnValue(false);
    expect(fitAllView(ctx)).toBe(false);
  });

  it("the projection toggle flips between the two modes", () => {
    const a = makeContext({ mode: "perspective" });
    runViewAction(a.ctx, { kind: "toggleProjection" });
    expect(a.setProjectionMode).toHaveBeenLastCalledWith("orthographic");
    expect(a.ctx.projection.get()).toBe("orthographic");
    const b = makeContext({ mode: "orthographic" });
    runViewAction(b.ctx, { kind: "toggleProjection" });
    expect(b.setProjectionMode).toHaveBeenLastCalledWith("perspective");
    expect(b.ctx.projection.get()).toBe("perspective");
  });

  it("the store is the one source of the projection: a new renderer gets the mode chosen before it existed", () => {
    const ctx = createViewContext();
    ctx.pointCloud.set(true);
    runViewAction(ctx, { kind: "toggleProjection" }); // no renderer yet: only the store changes
    expect(ctx.projection.get()).toBe("orthographic");
    const renderer = { setViewPreset: vi.fn(() => true), fitAll: vi.fn(() => true), setProjectionMode: vi.fn() };
    attachViewRenderer(ctx, renderer);
    expect(renderer.setProjectionMode).toHaveBeenCalledWith("orthographic");
    detachViewRenderer(ctx);
    expect(fitAllView(ctx)).toBe(false);
  });

  it("subscribers are told when the projection changes, and only then", () => {
    const { ctx } = makeContext();
    const listener = vi.fn();
    const stop = ctx.projection.subscribe(listener);
    runViewAction(ctx, { kind: "toggleProjection" });
    expect(listener).toHaveBeenCalledTimes(1);
    ctx.projection.set("orthographic"); // same value
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    runViewAction(ctx, { kind: "toggleProjection" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("no point cloud (TP-1 F-10: the keys agree with the grayed-out button)", () => {
  it("every view function does nothing while no point-cloud layer is open (only measurement layers left)", () => {
    const { ctx, renderer } = makeContext();
    ctx.pointCloud.set(false);
    runViewAction(ctx, { kind: "toggleProjection" });
    expect(ctx.projection.get()).toBe("perspective");
    expect(renderer.setProjectionMode).toHaveBeenCalledTimes(1); // only the attach call
    expect(showViewPreset(ctx, "top")).toBe(false);
    expect(fitAllView(ctx)).toBe(false);
    expect(renderer.setViewPreset).not.toHaveBeenCalled();
    expect(renderer.fitAll).not.toHaveBeenCalled();
    ctx.pointCloud.set(true); // a point cloud is opened again
    runViewAction(ctx, { kind: "toggleProjection" });
    expect(ctx.projection.get()).toBe("orthographic");
  });
});

describe("keyboard shortcuts (UX-4)", () => {
  it("F / 1 / 2 / 3 / 4 / 5 are fit, top, front, right, isometric, projection", () => {
    expect(viewActionForKey({ ...plain, key: "f" })).toEqual({ kind: "fit" });
    expect(viewActionForKey({ ...plain, key: "F" })).toEqual({ kind: "fit" });
    expect(viewActionForKey({ ...plain, key: "1" })).toEqual({ kind: "preset", id: "top" });
    expect(viewActionForKey({ ...plain, key: "2" })).toEqual({ kind: "preset", id: "front" });
    expect(viewActionForKey({ ...plain, key: "3" })).toEqual({ kind: "preset", id: "right" });
    expect(viewActionForKey({ ...plain, key: "4" })).toEqual({ kind: "preset", id: "isometric" });
    expect(viewActionForKey({ ...plain, key: "5" })).toEqual({ kind: "toggleProjection" });
  });

  it("every preset has a key and no key is used twice", () => {
    for (const id of VIEW_PRESET_IDS) expect(shortcutKeyOfPreset(id)).not.toBe("");
    const keys = VIEW_SHORTCUTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys typed in a field are not shortcuts", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(viewActionForKey({ ...plain, key: "1", target: { tagName } })).toBeNull();
    }
    expect(viewActionForKey({ ...plain, key: "f", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
  });

  it("keys with Ctrl / Meta / Alt, held keys and IME composition are not shortcuts", () => {
    expect(viewActionForKey({ ...plain, key: "f", ctrlKey: true })).toBeNull();
    expect(viewActionForKey({ ...plain, key: "f", metaKey: true })).toBeNull();
    expect(viewActionForKey({ ...plain, key: "1", altKey: true })).toBeNull();
    expect(viewActionForKey({ ...plain, key: "1", repeat: true })).toBeNull();
    expect(viewActionForKey({ ...plain, key: "1", isComposing: true })).toBeNull();
  });

  it("other keys are ignored", () => {
    expect(viewActionForKey({ ...plain, key: "Enter" })).toBeNull();
    expect(viewActionForKey({ ...plain, key: "x" })).toBeNull();
    expect(viewActionForKey({ ...plain, key: "Escape" })).toBeNull();
  });
});

describe("viewStatusText (UX-1)", () => {
  it("names the viewpoint and the projection", () => {
    expect(viewStatusText("front", "perspective", false)).toBe("視点: 正面（透視投影）");
    expect(viewStatusText("top", "orthographic", false)).toBe("視点: 上（平行投影）");
  });
  it("says 自由 when the camera is not at a fixed viewpoint", () => {
    expect(viewStatusText(null, "perspective", false)).toBe("視点: 自由（透視投影）");
  });
  it("is short on a narrow screen", () => {
    expect(viewStatusText("isometric", "orthographic", true)).toBe("等角・平行");
  });
});
