import type { Effect, ProjectionMode, ViewPresetId, ViewState } from "../../plugin-api";

export interface ViewModel {
  readonly pointCloud: boolean;
  readonly view: ViewState;
  readonly dialogOpen: boolean;
}

export type ViewMsg =
  | { type: "layersChanged"; pointCloud: boolean }
  | { type: "viewChanged"; view: ViewState }
  | { type: "ribbonClicked" }
  | { type: "dialogClosed" }
  | { type: "fitRequested" }
  | { type: "presetRequested"; id: ViewPresetId }
  | { type: "projectionRequested"; mode: ProjectionMode }
  | { type: "projectionToggled" }
  | { type: "effectFailed"; error: unknown };

export interface ViewEffects {
  openDialog: Effect<ViewMsg>;
  fitAll: Effect<ViewMsg>;
  showPreset(id: ViewPresetId): Effect<ViewMsg>;
  setProjection(mode: ProjectionMode): Effect<ViewMsg>;
}

export function initialViewModel(pointCloud: boolean, view: ViewState): ViewModel {
  return { pointCloud, view, dialogOpen: false };
}

export function otherProjection(mode: ProjectionMode): ProjectionMode {
  return mode === "perspective" ? "orthographic" : "perspective";
}

function onlyWithPointCloud(model: ViewModel, effect: Effect<ViewMsg>): [ViewModel, Effect<ViewMsg>[]] {
  return [model, model.pointCloud ? [effect] : []];
}

export function updateView(model: ViewModel, msg: ViewMsg, effects: ViewEffects): [ViewModel, Effect<ViewMsg>[]] {
  switch (msg.type) {
    case "layersChanged":
      return [model.pointCloud === msg.pointCloud ? model : { ...model, pointCloud: msg.pointCloud }, []];
    case "viewChanged":
      return [{ ...model, view: msg.view }, []];
    case "ribbonClicked":
      if (!model.pointCloud || model.dialogOpen) return [model, []];
      return [{ ...model, dialogOpen: true }, [effects.openDialog]];
    case "dialogClosed":
      return [model.dialogOpen ? { ...model, dialogOpen: false } : model, []];
    case "fitRequested":
      return onlyWithPointCloud(model, effects.fitAll);
    case "presetRequested":
      return onlyWithPointCloud(model, effects.showPreset(msg.id));
    case "projectionRequested":
      return onlyWithPointCloud(model, effects.setProjection(msg.mode));
    case "projectionToggled":
      return onlyWithPointCloud(model, effects.setProjection(otherProjection(model.view.projection)));
    case "effectFailed":
      return [model, []];
  }
}
