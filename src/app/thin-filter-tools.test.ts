import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import type { FilterRequest, ThinRequest } from "../datasource/thin-filter";
import type { ToolResult } from "../datasource/tools";
import type { ViewerLayer } from "../state/layers";
import { filterLayer, thinLayer, type PointCloudToolsContext } from "./point-cloud-tools";

// What a fake (non-Web) source reaches: the Tauri commands.
const tauri = vi.hoisted(() => ({
  extractToCopc: vi.fn(),
  mergeCopcs: vi.fn(),
  cancelLasConversion: vi.fn(async () => {}),
  computeSectionLine: vi.fn(),
  thinCopc: vi.fn(),
  filterCopc: vi.fn(),
}));
vi.mock("../datasource/tauri", () => tauri);

beforeEach(() => vi.clearAllMocks());

const THIN: ThinRequest = { kind: "grid", size: 1, keep: "nearestCentre" };
const ROR: FilterRequest = { kind: "ror", radius: 3, minNeighbors: 4 };
const SOR: FilterRequest = { kind: "sor", k: 8, nSigma: 2, searchRadius: 15 };

function pointCloudLayer(id: string, name: string): ViewerLayer {
  return { id, name, cloudId: 0, sourcePath: `${id}.copc.laz`, visible: true, info: {} } as unknown as ViewerLayer;
}

/** A measurement layer: it has no `sourcePath`. */
function measureLayer(id: string): ViewerLayer {
  return { id, name: "計測", visible: true, kind: "measure" } as unknown as ViewerLayer;
}

function makeHarness(layers: ViewerLayer[]) {
  const errors: Array<[string, string | undefined]> = [];
  const opened: Array<[string, string]> = [];
  const hidden: string[] = [];
  const progresses: unknown[] = [];
  const ctx: PointCloudToolsContext = {
    getSource: () => ({}) as DataSource,
    getLayersState: () => ({ layers, selectedLayerId: layers[0]?.id ?? null }),
    getViewUp: () => [0, 0, 1],
    extraSelectedIds: [],
    tempDir: null,
    isMobile: false,
    addOpenedLayer: async (path, name) => {
      opened.push([path, name]);
      return { layerId: "new-layer" };
    },
    setSectionLine: () => {},
    setLayerDtm: () => {},
    setLayerColorMode: () => {},
    focusLayer: () => {},
    setLayerVisible: (id, visible) => {
      if (!visible) hidden.push(id);
    },
    setStatus: () => {},
    setToolProgress: (p) => progresses.push(p),
    reportError: (message, src) => errors.push([message, src]),
    toolLock: { running: false },
  };
  return { ctx, errors, opened, hidden, progresses };
}

const OK = { outputPath: "out.copc.laz", pointCount: 5, warnings: [] } as ToolResult;

describe("thinLayer", () => {
  it("opens a new layer called 間引き - name and hides the source", async () => {
    tauri.thinCopc.mockResolvedValueOnce(OK);
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await thinLayer(h.ctx, "a", THIN);
    expect(tauri.thinCopc).toHaveBeenCalledWith("a.copc.laz", THIN, expect.anything());
    expect(h.opened).toEqual([["out.copc.laz", "間引き - 地形"]]);
    expect(h.hidden).toEqual(["a"]);
    expect(h.errors).toEqual([]);
    expect(h.progresses[0]).toEqual({ title: "間引き（地形）", pointsRead: 0, totalPoints: 0 });
    expect(h.ctx.toolLock.running).toBe(false);
  });

  it("zero points: the message goes to the error log, no layer, the source stays visible", async () => {
    tauri.thinCopc.mockRejectedValueOnce(new Error("残る点がありません"));
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await thinLayer(h.ctx, "a", THIN);
    expect(h.errors).toEqual([["残る点がありません", "tool"]]);
    expect(h.opened).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(h.ctx.toolLock.running).toBe(false);
  });

  it("a failure keeps the source visible", async () => {
    tauri.thinCopc.mockRejectedValueOnce(new Error("点を読めませんでした: x"));
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await thinLayer(h.ctx, "a", THIN);
    expect(h.errors).toEqual([["点を読めませんでした: x", "tool"]]);
    expect(h.hidden).toEqual([]);
  });

  it("a cancel is reported with the tool title and keeps the source visible", async () => {
    tauri.thinCopc.mockRejectedValueOnce(new Error("キャンセルされた"));
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await thinLayer(h.ctx, "a", THIN);
    expect(h.errors).toEqual([["間引き（地形）をキャンセルしました", "tool"]]);
    expect(h.hidden).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("refuses a layer that is not a point cloud, or does not exist", async () => {
    const h = makeHarness([measureLayer("m")]);
    await thinLayer(h.ctx, "m", THIN);
    await thinLayer(h.ctx, "missing", THIN);
    expect(h.errors).toEqual([
      ["点群のレイヤーを選んでください", "tool"],
      ["点群のレイヤーを選んでください", "tool"],
    ]);
    expect(tauri.thinCopc).not.toHaveBeenCalled();
  });
});

describe("filterLayer", () => {
  it("opens a new layer called フィルタ - name for ROR and for SOR", async () => {
    tauri.filterCopc.mockResolvedValue(OK);
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await filterLayer(h.ctx, "a", ROR);
    await filterLayer(h.ctx, "a", SOR);
    expect(tauri.filterCopc.mock.calls.map((c) => c[1])).toEqual([ROR, SOR]);
    expect(h.opened).toEqual([
      ["out.copc.laz", "フィルタ - 地形"],
      ["out.copc.laz", "フィルタ - 地形"],
    ]);
    expect(h.hidden).toEqual(["a", "a"]);
  });

  it("zero points leaves the source visible", async () => {
    tauri.filterCopc.mockRejectedValueOnce(new Error("残る点がありません"));
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await filterLayer(h.ctx, "a", ROR);
    expect(h.errors).toEqual([["残る点がありません", "tool"]]);
    expect(h.hidden).toEqual([]);
  });

  it("refuses to start while another tool runs", async () => {
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    h.ctx.toolLock.running = true;
    await filterLayer(h.ctx, "a", SOR);
    expect(h.errors).toEqual([["別の点群ツールを実行中です。終わってからやり直してください", "tool"]]);
    expect(tauri.filterCopc).not.toHaveBeenCalled();
    expect(h.ctx.toolLock.running).toBe(true);
  });
});
