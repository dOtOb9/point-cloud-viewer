import { describe, expect, it } from "vitest";
import { effectiveSelectedIds, rangeSelectedIds, toggleSelectedId, toolSourceLayers } from "./layer-selection";
import type { ViewerLayer } from "./layers";

function layer(id: string, extra: Partial<ViewerLayer> = {}): ViewerLayer {
  return { id, name: id, sourcePath: `/data/${id}.copc.laz`, ...extra } as ViewerLayer;
}
const layers = [layer("a"), layer("b"), layer("c"), layer("d")];

describe("effectiveSelectedIds", () => {
  it("is empty without a primary", () => {
    expect(effectiveSelectedIds(layers, null, ["a"])).toEqual([]);
  });
  it("falls back to the primary when the stored list does not contain it", () => {
    expect(effectiveSelectedIds(layers, "c", ["a", "b"])).toEqual(["c"]);
  });
  it("drops deleted layers", () => {
    expect(effectiveSelectedIds(layers, "a", ["a", "zzz"])).toEqual(["a"]);
  });
});

describe("toggleSelectedId", () => {
  it("adds a layer and makes it the primary", () => {
    expect(toggleSelectedId(layers, "a", ["a"], "c")).toEqual({ primaryId: "c", ids: ["a", "c"] });
  });
  it("removes a non-primary layer and keeps the primary", () => {
    expect(toggleSelectedId(layers, "c", ["a", "c"], "a")).toEqual({ primaryId: "c", ids: ["c"] });
  });
  it("removing the primary hands it to the most recently added remaining layer", () => {
    expect(toggleSelectedId(layers, "c", ["a", "b", "c"], "c")).toEqual({ primaryId: "b", ids: ["a", "b"] });
  });
  it("removing the last one leaves nothing selected", () => {
    expect(toggleSelectedId(layers, "a", ["a"], "a")).toEqual({ primaryId: null, ids: [] });
  });
});

describe("rangeSelectedIds", () => {
  it("selects the rows between the anchor and the clicked row, in either direction", () => {
    expect(rangeSelectedIds(layers, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeSelectedIds(layers, "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("selects only the clicked row when there is no anchor", () => {
    expect(rangeSelectedIds(layers, null, "c")).toEqual(["c"]);
  });
});

describe("toolSourceLayers", () => {
  it("keeps point-cloud layers with a path, in list order, and drops measurement layers", () => {
    const mixed = [layer("a"), layer("m", { measurement: { kind: "distance", points: [], up: [0, 0, 1] } }), layer("n", { sourcePath: undefined })];
    expect(toolSourceLayers(mixed, ["m", "a", "n"]).map((l) => l.id)).toEqual(["a"]);
  });
});
