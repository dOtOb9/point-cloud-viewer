import { describe, expect, it } from "vitest";
import type { Effect, ViewState } from "../../plugin-api";
import { initialViewModel, updateView, type ViewEffects, type ViewModel, type ViewMsg } from "./model";

const VIEW: ViewState = { projection: "perspective", preset: null, rendererHasLayers: true };

function recordingEffects() {
  const named = (name: string): Effect<ViewMsg> => Object.assign(() => {}, { effectName: name });
  const effects: ViewEffects = {
    openDialog: named("openDialog"),
    fitAll: named("fitAll"),
    showPreset: (id) => named(`showPreset ${id}`),
    setProjection: (mode) => named(`setProjection ${mode}`),
  };
  return effects;
}

function effectNames(effects: Effect<ViewMsg>[]): string[] {
  return effects.map((e) => (e as unknown as { effectName: string }).effectName);
}

function run(model: ViewModel, msg: ViewMsg): [ViewModel, string[]] {
  const [next, effects] = updateView(model, msg, recordingEffects());
  return [next, effectNames(effects)];
}

const open = initialViewModel(true, VIEW);
const closed = initialViewModel(false, VIEW);

describe("pcv.view update: view commands", () => {
  it("fit, a viewpoint and a projection each become one renderer effect while a point cloud is open", () => {
    expect(run(open, { type: "fitRequested" })[1]).toEqual(["fitAll"]);
    expect(run(open, { type: "presetRequested", id: "front" })[1]).toEqual(["showPreset front"]);
    expect(run(open, { type: "projectionRequested", mode: "orthographic" })[1]).toEqual(["setProjection orthographic"]);
  });

  it("the projection toggle flips between the two modes", () => {
    expect(run(open, { type: "projectionToggled" })[1]).toEqual(["setProjection orthographic"]);
    const ortho = { ...open, view: { ...VIEW, projection: "orthographic" as const } };
    expect(run(ortho, { type: "projectionToggled" })[1]).toEqual(["setProjection perspective"]);
  });

  it("TP-1 F-10: without a point-cloud layer (only measurements left) every view command does nothing", () => {
    for (const msg of [
      { type: "fitRequested" },
      { type: "presetRequested", id: "top" },
      { type: "projectionRequested", mode: "orthographic" },
      { type: "projectionToggled" },
    ] as ViewMsg[]) {
      const [next, effects] = run(closed, msg);
      expect(next).toBe(closed);
      expect(effects).toEqual([]);
    }
  });

  it("does not change the model for a command: the projection comes back from the view context", () => {
    expect(run(open, { type: "projectionToggled" })[0]).toBe(open);
  });
});

describe("pcv.view update: what it hears from the host", () => {
  it("follows the layer list: deleting the point cloud stops the commands, opening one starts them", () => {
    const [gone] = run(open, { type: "layersChanged", pointCloud: false });
    expect(run(gone, { type: "projectionToggled" })[1]).toEqual([]);
    const [back] = run(gone, { type: "layersChanged", pointCloud: true });
    expect(run(back, { type: "projectionToggled" })[1]).toEqual(["setProjection orthographic"]);
  });

  it("keeps the same model when the layer answer does not change", () => {
    expect(run(open, { type: "layersChanged", pointCloud: true })[0]).toBe(open);
  });

  it("takes the viewpoint and the projection the view context reports", () => {
    const view: ViewState = { projection: "orthographic", preset: "top", rendererHasLayers: true };
    expect(run(open, { type: "viewChanged", view })[0].view).toBe(view);
  });

  it("ignores an effect failure (the host has already reported it)", () => {
    expect(run(open, { type: "effectFailed", error: new Error("x") })).toEqual([open, []]);
  });
});

describe("pcv.view update: the dialog", () => {
  it("opens the dialog once, however often the ribbon button is pressed", () => {
    const [opened, first] = run(open, { type: "ribbonClicked" });
    expect(first).toEqual(["openDialog"]);
    expect(opened.dialogOpen).toBe(true);
    expect(run(opened, { type: "ribbonClicked" })[1]).toEqual([]);
  });

  it("opens again after the host told it the dialog was closed", () => {
    const [opened] = run(open, { type: "ribbonClicked" });
    const [shut] = run(opened, { type: "dialogClosed" });
    expect(shut.dialogOpen).toBe(false);
    expect(run(shut, { type: "ribbonClicked" })[1]).toEqual(["openDialog"]);
  });

  it("does not open without a point cloud", () => {
    expect(run(closed, { type: "ribbonClicked" })).toEqual([closed, []]);
  });
});
