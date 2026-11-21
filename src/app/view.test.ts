import { describe, expect, it, vi } from "vitest";
import {
  attachViewRenderer,
  createViewContext,
  detachViewRenderer,
  fitAllView,
  hasPointCloudLayer,
  setViewProjection,
  showViewPreset,
  syncViewWithLayers,
  syncViewWithStats,
} from "./view";
import type { ViewerLayer } from "../state/layers";

function fakeRenderer() {
  return { setViewPreset: vi.fn(() => true), fitAll: vi.fn(() => true), setProjectionMode: vi.fn() };
}

function attachedContext() {
  const ctx = createViewContext();
  const renderer = fakeRenderer();
  attachViewRenderer(ctx, renderer);
  return { ctx, renderer };
}

describe("view commands go to the renderer of this viewer", () => {
  it("a preset goes to the renderer", () => {
    const { ctx, renderer } = attachedContext();
    expect(showViewPreset(ctx, "front")).toBe(true);
    expect(renderer.setViewPreset).toHaveBeenCalledWith("front");
  });

  it("fit all goes to the renderer", () => {
    const { ctx, renderer } = attachedContext();
    expect(fitAllView(ctx)).toBe(true);
    expect(renderer.fitAll).toHaveBeenCalledTimes(1);
  });

  it("does nothing (and does not fail) before the renderer exists", () => {
    const ctx = createViewContext();
    expect(fitAllView(ctx)).toBe(false);
    expect(showViewPreset(ctx, "top")).toBe(false);
    expect(() => setViewProjection(ctx, "orthographic")).not.toThrow();
  });

  it("reports false when the renderer has no visible layer", () => {
    const { ctx, renderer } = attachedContext();
    renderer.fitAll.mockReturnValue(false);
    expect(fitAllView(ctx)).toBe(false);
  });

  it("two viewers do not share a view context", () => {
    const a = attachedContext();
    const b = attachedContext();
    setViewProjection(a.ctx, "orthographic");
    expect(b.ctx.state.get().projection).toBe("perspective");
    expect(b.renderer.setProjectionMode).not.toHaveBeenCalledWith("orthographic");
  });
});

describe("the projection lives in the view context, not in the renderer", () => {
  it("setting it stores it and tells the renderer", () => {
    const { ctx, renderer } = attachedContext();
    setViewProjection(ctx, "orthographic");
    expect(ctx.state.get().projection).toBe("orthographic");
    expect(renderer.setProjectionMode).toHaveBeenLastCalledWith("orthographic");
  });

  it("a new renderer gets the mode chosen before it existed", () => {
    const ctx = createViewContext();
    setViewProjection(ctx, "orthographic");
    const renderer = fakeRenderer();
    attachViewRenderer(ctx, renderer);
    expect(renderer.setProjectionMode).toHaveBeenCalledWith("orthographic");
    detachViewRenderer(ctx);
    expect(fitAllView(ctx)).toBe(false);
  });

  it("a renderer made again after the first one is gone gets the mode chosen with the first one", () => {
    const { ctx } = attachedContext();
    setViewProjection(ctx, "orthographic");
    detachViewRenderer(ctx);
    const next = fakeRenderer();
    attachViewRenderer(ctx, next);
    expect(next.setProjectionMode).toHaveBeenCalledTimes(1);
    expect(next.setProjectionMode).toHaveBeenCalledWith("orthographic");
  });

  it("subscribers are told when the projection changes, and only then", () => {
    const { ctx } = attachedContext();
    const listener = vi.fn();
    const stop = ctx.state.subscribe(listener);
    setViewProjection(ctx, "orthographic");
    expect(listener).toHaveBeenCalledTimes(1);
    setViewProjection(ctx, "orthographic");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    setViewProjection(ctx, "perspective");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("hasPointCloudLayer / syncViewWithLayers (the one rule for the button and the keys)", () => {
  const point = { id: "a" } as unknown as ViewerLayer;
  const measure = { id: "m", measurement: { kind: "distance" } } as unknown as ViewerLayer;

  it("only measurement layers (or none) -> false; a point-cloud layer -> true", () => {
    expect(hasPointCloudLayer([])).toBe(false);
    expect(hasPointCloudLayer([measure])).toBe(false);
    expect(hasPointCloudLayer([measure, point])).toBe(true);
  });

  it("syncViewWithLayers puts the answer into the context", () => {
    const ctx = createViewContext();
    syncViewWithLayers(ctx, [measure]);
    expect(ctx.pointCloud.get()).toBe(false);
    syncViewWithLayers(ctx, [measure, point]);
    expect(ctx.pointCloud.get()).toBe(true);
  });
});

describe("syncViewWithStats (the current viewpoint comes from the renderer stats)", () => {
  it("takes the viewpoint and whether the renderer draws a layer", () => {
    const ctx = createViewContext();
    syncViewWithStats(ctx, { viewPreset: "top", layerCount: 2 });
    expect(ctx.state.get()).toEqual({ projection: "perspective", preset: "top", rendererHasLayers: true });
    syncViewWithStats(ctx, { viewPreset: null, layerCount: 0 });
    expect(ctx.state.get()).toEqual({ projection: "perspective", preset: null, rendererHasLayers: false });
  });

  it("knows nothing before the first stats", () => {
    const ctx = createViewContext();
    syncViewWithStats(ctx, null);
    expect(ctx.state.get()).toEqual({ projection: "perspective", preset: null, rendererHasLayers: false });
  });

  it("does not tell subscribers when the stats change something else", () => {
    const ctx = createViewContext();
    syncViewWithStats(ctx, { viewPreset: "front", layerCount: 1 });
    const listener = vi.fn();
    ctx.state.subscribe(listener);
    syncViewWithStats(ctx, { viewPreset: "front", layerCount: 3 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the projection chosen by the user", () => {
    const ctx = createViewContext();
    setViewProjection(ctx, "orthographic");
    syncViewWithStats(ctx, { viewPreset: "left", layerCount: 1 });
    expect(ctx.state.get().projection).toBe("orthographic");
  });
});
