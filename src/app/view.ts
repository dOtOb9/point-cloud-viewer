import type { PointCloudRenderer, RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_PROJECTION_MODE, type ProjectionMode } from "../renderer/projection";
import type { ViewPresetId } from "../renderer/view-presets";
import { isMeasureLayer, type ViewerLayer } from "../state/layers";
import { createStore, type Store } from "./store";

export type { ProjectionMode, ViewPresetId };

export type ViewRenderer = Pick<PointCloudRenderer, "setViewPreset" | "fitAll" | "setProjectionMode">;

export interface ViewerViewState {
  readonly projection: ProjectionMode;
  readonly preset: ViewPresetId | null;
  readonly rendererHasLayers: boolean;
}

export interface ViewContext {
  state: Store<ViewerViewState>;
  pointCloud: Store<boolean>;
  renderer: Store<ViewRenderer | null>;
}

export type ViewStats = Pick<RenderStats, "viewPreset" | "layerCount">;

export function createViewContext(): ViewContext {
  return {
    state: createStore<ViewerViewState>({ projection: DEFAULT_PROJECTION_MODE, preset: null, rendererHasLayers: false }),
    pointCloud: createStore(false),
    renderer: createStore<ViewRenderer | null>(null),
  };
}

function changeViewState(ctx: ViewContext, change: Partial<ViewerViewState>): void {
  const current = ctx.state.get();
  const next = { ...current, ...change };
  const same = next.projection === current.projection && next.preset === current.preset && next.rendererHasLayers === current.rendererHasLayers;
  if (!same) ctx.state.set(next);
}

export function hasPointCloudLayer(layers: readonly ViewerLayer[]): boolean {
  return layers.some((layer) => !isMeasureLayer(layer));
}

export function syncViewWithLayers(ctx: ViewContext, layers: readonly ViewerLayer[]): void {
  ctx.pointCloud.set(hasPointCloudLayer(layers));
}

export function syncViewWithStats(ctx: ViewContext, stats: ViewStats | null): void {
  changeViewState(ctx, { preset: stats?.viewPreset ?? null, rendererHasLayers: (stats?.layerCount ?? 0) > 0 });
}

export function attachViewRenderer(ctx: ViewContext, renderer: ViewRenderer): void {
  ctx.renderer.set(renderer);
  renderer.setProjectionMode(ctx.state.get().projection);
}

export function detachViewRenderer(ctx: ViewContext): void {
  ctx.renderer.set(null);
}

export function setViewProjection(ctx: ViewContext, mode: ProjectionMode): void {
  changeViewState(ctx, { projection: mode });
  ctx.renderer.get()?.setProjectionMode(mode);
}

export function showViewPreset(ctx: ViewContext, id: ViewPresetId): boolean {
  return ctx.renderer.get()?.setViewPreset(id) ?? false;
}

export function fitAllView(ctx: ViewContext): boolean {
  return ctx.renderer.get()?.fitAll() ?? false;
}
