import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import type { SectionInfo, ViewerLayer } from "../state/layers";
import type { SectionGroundLine } from "../datasource/section-line";
import type { ExtractFilter, ToolResult } from "../datasource/tools";
import type { ViewerStatus } from "../state/viewer-status";
import type { ToolProgressState } from "../state/viewer-types";
import { sectionLineRequestFor, UNKNOWN_UNIT_CSF_WARNING } from "./csf-params";
import { cancelTool, extractFromLayer, hideSourceLayers, mergeSelectedLayers, type PointCloudToolsContext } from "./point-cloud-tools";

// The Tauri commands are what a fake (non-Web) source reaches; each test decides what they answer.
const tauri = vi.hoisted(() => ({
  extractToCopc: vi.fn(),
  mergeCopcs: vi.fn(),
  cancelLasConversion: vi.fn(async () => {}),
  computeSectionLine: vi.fn(),
}));
vi.mock("../datasource/tauri", () => tauri);

beforeEach(() => vi.clearAllMocks());

const FILTER: ExtractFilter = { kind: "screenPolygon", viewProj: [], polygonNdc: [] };

/** A cross section cut from layer "a". */
const SECTION: SectionInfo = {
  a: [0, 0, 0],
  b: [10, 0, 0],
  up: [0, 0, 1],
  thickness: 1,
  sourceLayerId: "a",
  linePreset: "standard",
};

function pointCloudLayer(id: string, name: string, cloudId = 0): ViewerLayer {
  return { id, name, cloudId, sourcePath: `${id}.copc.laz`, visible: true, info: { crs: { horizontalUnitToMeter: 1, verticalUnitToMeter: 1 } } } as unknown as ViewerLayer;
}

interface Harness {
  ctx: PointCloudToolsContext;
  statuses: ViewerStatus[];
  errors: Array<[string, string | undefined]>;
  progresses: Array<ToolProgressState | null>;
  opened: Array<[string, string]>;
  focused: string[];
  hidden: string[];
  sectionLines: Array<[string, SectionGroundLine]>;
}

function makeHarness(layers: ViewerLayer[], selectedLayerId: string | null, extraSelectedIds: string[] = []): Harness {
  const statuses: ViewerStatus[] = [];
  const errors: Array<[string, string | undefined]> = [];
  const progresses: Array<ToolProgressState | null> = [];
  const opened: Array<[string, string]> = [];
  const focused: string[] = [];
  const hidden: string[] = [];
  const sectionLines: Array<[string, SectionGroundLine]> = [];
  const source = {} as DataSource;
  const ctx: PointCloudToolsContext = {
    getSource: () => source,
    getLayersState: () => ({ layers, selectedLayerId }),
    getViewUp: () => [0, 0, 1],
    extraSelectedIds,
    tempDir: null,
    isMobile: false,
    addOpenedLayer: async (path, name) => {
      opened.push([path, name]);
      return { layerId: "new-layer" };
    },
    setSectionLine: (id, line) => sectionLines.push([id, line]),
    focusLayer: (id) => focused.push(id),
    setLayerVisible: (id, visible) => {
      if (!visible) hidden.push(id);
    },
    setStatus: (s) => statuses.push(s),
    setToolProgress: (p) => progresses.push(p),
    reportError: (message, src) => errors.push([message, src]),
    toolLock: { running: false },
  };
  return { ctx, statuses, errors, progresses, opened, focused, hidden, sectionLines };
}

function result(warnings: string[] = []): ToolResult {
  return { outputPath: "out.copc.laz", warnings } as ToolResult;
}

describe("extractFromLayer", () => {
  it("adds the result as a new layer and sets the status ready", async () => {
    tauri.extractToCopc.mockResolvedValueOnce(result());
    const h = makeHarness([pointCloudLayer("a", "地形")], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "カット");
    expect(h.opened).toEqual([["out.copc.laz", "カット - 地形"]]);
    expect(h.hidden).toEqual(["a"]);
    expect(h.statuses).toEqual([{ kind: "ready" }]);
    expect(h.errors).toEqual([]);
    expect(h.progresses[0]).toEqual({ title: "カット（地形）", pointsRead: 0, totalPoints: 0 });
    expect(h.progresses[h.progresses.length - 1]).toBeNull();
    expect(h.ctx.toolLock.running).toBe(false);
  });

  it("sends warnings to the error log but still opens the layer", async () => {
    tauri.extractToCopc.mockResolvedValueOnce(result(["注意です"]));
    const h = makeHarness([pointCloudLayer("a", "地形")], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "カット");
    expect(h.errors).toEqual([["注意です", "tool"]]);
    expect(h.opened).toHaveLength(1);
  });

  it("sends the failure message as it is to the error log and adds no layer", async () => {
    tauri.extractToCopc.mockRejectedValueOnce(new Error("読み込みに失敗"));
    const h = makeHarness([pointCloudLayer("a", "地形")], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "断面");
    expect(h.errors).toEqual([["読み込みに失敗", "tool"]]);
    expect(h.hidden).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.statuses).toEqual([]);
    expect(h.progresses[h.progresses.length - 1]).toBeNull();
    expect(h.ctx.toolLock.running).toBe(false);
  });

  it("reports a cancellation with the tool title", async () => {
    tauri.extractToCopc.mockRejectedValueOnce(new Error("変換をキャンセルしました"));
    const h = makeHarness([pointCloudLayer("a", "地形")], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "カット");
    expect(h.errors).toEqual([["カット（地形）をキャンセルしました", "tool"]]);
    expect(h.hidden).toEqual([]);
  });

  it("refuses to start while another tool runs, without touching the running one", async () => {
    const h = makeHarness([pointCloudLayer("a", "地形")], "a");
    h.ctx.toolLock.running = true;
    await extractFromLayer(h.ctx, "a", FILTER, "カット");
    expect(h.errors).toEqual([["別の点群ツールを実行中です。終わってからやり直してください", "tool"]]);
    expect(tauri.extractToCopc).not.toHaveBeenCalled();
    expect(h.ctx.toolLock.running).toBe(true);
    expect(h.progresses).toEqual([]);
  });

  it("refuses a layer that is not a point cloud", async () => {
    const h = makeHarness([], null);
    await extractFromLayer(h.ctx, "missing", FILTER, "カット");
    expect(h.errors).toEqual([["点群のレイヤーを選んでください", "tool"]]);
  });

  it("does not compute a section line when the tool fails", async () => {
    const section = SECTION;
    tauri.extractToCopc.mockRejectedValueOnce(new Error("失敗"));
    const h = makeHarness([pointCloudLayer("a", "地形")], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "断面", [0, 1, 0], section);
    expect(tauri.computeSectionLine).not.toHaveBeenCalled();
  });
});

// --- G2: section line ---
describe("the section line after a cross section", () => {
  const LINE: SectionGroundLine = { points: new Float32Array([0, 1, 5, 2]), groundPoints: 10, cells: 100 };

  it("computes the line from the source layer and stores it on the new layer", async () => {
    tauri.extractToCopc.mockResolvedValue(result());
    tauri.computeSectionLine.mockResolvedValueOnce(LINE);
    const h = makeHarness([pointCloudLayer("a", "地形", 7)], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "断面", [0, 1, 0], SECTION);
    expect(tauri.computeSectionLine).toHaveBeenCalledWith(
      7,
      { a: [0, 0, 0], b: [10, 0, 0], up: [0, 0, 1] },
      sectionLineRequestFor("standard", { horizontalToMeter: 1, verticalToMeter: 1 }).request,
      expect.anything(),
    );
    expect(h.sectionLines).toEqual([["new-layer", LINE]]);
    expect(h.errors).toEqual([]);
    expect(h.ctx.toolLock.running).toBe(false);
    expect(h.progresses[h.progresses.length - 1]).toBeNull();
  });

  it("sends the owner's metre values converted to the source layer's unit, and warns for an unknown unit", async () => {
    tauri.extractToCopc.mockResolvedValue(result());
    tauri.computeSectionLine.mockResolvedValue(LINE);
    const feet = pointCloudLayer("a", "地形", 7);
    (feet as unknown as { info: unknown }).info = { crs: { horizontalUnitToMeter: 0.3048, verticalUnitToMeter: 0.3048 } };
    const h = makeHarness([feet], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "断面", [0, 1, 0], SECTION);
    const sent = tauri.computeSectionLine.mock.calls[0][2];
    expect(sent.csf.clothResolution).toBeCloseTo(0.5 / 0.3048, 9);
    expect(sent.csf.classThresholdLower).toBeCloseTo(1 / 0.3048, 9);
    expect(h.errors).toEqual([]);

    tauri.computeSectionLine.mockClear();
    const unknown = pointCloudLayer("a", "地形", 7);
    (unknown as unknown as { info: unknown }).info = { crs: { horizontalUnitToMeter: null, verticalUnitToMeter: null } };
    const h2 = makeHarness([unknown], "a");
    await extractFromLayer(h2.ctx, "a", FILTER, "断面", [0, 1, 0], SECTION);
    expect(tauri.computeSectionLine.mock.calls[0][2].csf.clothResolution).toBe(0.5);
    expect(h2.errors).toEqual([[UNKNOWN_UNIT_CSF_WARNING, "tool"]]);
  });

  it("shows the progress as a percentage in the tool progress state", async () => {
    tauri.extractToCopc.mockResolvedValue(result());
    tauri.computeSectionLine.mockImplementationOnce(async (_id, _line, _request, options) => {
      options.onProgress({ pointsRead: 250, totalPoints: 1000 });
      return LINE;
    });
    const h = makeHarness([pointCloudLayer("a", "地形", 7)], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "断面", [0, 1, 0], SECTION);
    expect(h.progresses).toContainEqual({
      title: "断面線の計算（地形）",
      pointsRead: 250,
      totalPoints: 1000,
      showAsPercent: true,
    });
  });

  it("reports a failure to the error log and keeps the panel without a line", async () => {
    tauri.extractToCopc.mockResolvedValue(result());
    tauri.computeSectionLine.mockRejectedValueOnce(new Error("断面線の範囲に点がありません"));
    const h = makeHarness([pointCloudLayer("a", "地形", 7)], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "断面", [0, 1, 0], SECTION);
    expect(h.errors).toEqual([["断面線の範囲に点がありません", "tool"]]);
    expect(h.sectionLines).toEqual([]);
    expect(h.ctx.toolLock.running).toBe(false);
  });

  it("reports a cancel with the tool title", async () => {
    tauri.extractToCopc.mockResolvedValue(result());
    tauri.computeSectionLine.mockRejectedValueOnce(new Error("キャンセルされた"));
    const h = makeHarness([pointCloudLayer("a", "地形", 7)], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "断面", [0, 1, 0], SECTION);
    expect(h.errors).toEqual([["断面線の計算（地形）をキャンセルしました", "tool"]]);
    expect(h.sectionLines).toEqual([]);
  });

  it("is not computed for a cut", async () => {
    tauri.extractToCopc.mockResolvedValue(result());
    const h = makeHarness([pointCloudLayer("a", "地形")], "a");
    await extractFromLayer(h.ctx, "a", FILTER, "カット");
    expect(tauri.computeSectionLine).not.toHaveBeenCalled();
  });
});

describe("mergeSelectedLayers", () => {
  it("merges two selected layers into one new layer", async () => {
    tauri.mergeCopcs.mockResolvedValueOnce(result());
    const h = makeHarness([pointCloudLayer("a", "A"), pointCloudLayer("b", "B")], "b", ["a", "b"]);
    await mergeSelectedLayers(h.ctx);
    expect(tauri.mergeCopcs).toHaveBeenLastCalledWith(["a.copc.laz", "b.copc.laz"], expect.anything());
    expect(h.opened).toEqual([["out.copc.laz", "合成 (2)"]]);
    expect(h.hidden).toEqual(["a", "b"]);
    expect(h.statuses).toEqual([{ kind: "ready" }]);
  });

  it("asks for two or more layers", async () => {
    const h = makeHarness([pointCloudLayer("a", "A")], "a");
    await mergeSelectedLayers(h.ctx);
    expect(h.errors).toHaveLength(1);
    expect(h.opened).toEqual([]);
  });
});


describe("hideSourceLayers", () => {
  it("hides exactly the given layers", () => {
    const h = makeHarness([], null);
    hideSourceLayers(h.ctx, ["x", "y"]);
    expect(h.hidden).toEqual(["x", "y"]);
  });
});

describe("cancelTool", () => {
  it("calls the shared cancel command on desktop", () => {
    const h = makeHarness([], null);
    cancelTool(h.ctx);
    expect(tauri.cancelLasConversion).toHaveBeenCalledTimes(1);
  });
});
