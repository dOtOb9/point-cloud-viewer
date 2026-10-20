import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import type { ExtractFilter, ToolResult } from "../datasource/tools";
import type { ViewerLayer } from "../state/layers";
import type { ViewerStatus } from "../state/viewer-status";
import type { ToolProgressState } from "../state/viewer-types";
import { cancelTool, extractFromLayer, mergeSelectedLayers, type PointCloudToolsContext } from "./point-cloud-tools";

// The Tauri commands are what a fake (non-Web) source reaches; each test decides what they answer.
const tauri = vi.hoisted(() => ({
  extractToCopc: vi.fn(),
  mergeCopcs: vi.fn(),
  cancelLasConversion: vi.fn(async () => {}),
}));
vi.mock("../datasource/tauri", () => tauri);

beforeEach(() => vi.clearAllMocks());

const FILTER: ExtractFilter = { kind: "screenPolygon", viewProj: [], polygonNdc: [] };

function pointCloudLayer(id: string, name: string): ViewerLayer {
  return { id, name, sourcePath: `${id}.copc.laz`, visible: true } as unknown as ViewerLayer;
}

interface Harness {
  ctx: PointCloudToolsContext;
  statuses: ViewerStatus[];
  errors: Array<[string, string | undefined]>;
  progresses: Array<ToolProgressState | null>;
  opened: Array<[string, string]>;
  focused: string[];
}

function makeHarness(layers: ViewerLayer[], selectedLayerId: string | null, extraSelectedIds: string[] = []): Harness {
  const statuses: ViewerStatus[] = [];
  const errors: Array<[string, string | undefined]> = [];
  const progresses: Array<ToolProgressState | null> = [];
  const opened: Array<[string, string]> = [];
  const focused: string[] = [];
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
    focusLayer: (id) => focused.push(id),
    setStatus: (s) => statuses.push(s),
    setToolProgress: (p) => progresses.push(p),
    reportError: (message, src) => errors.push([message, src]),
    toolLock: { running: false },
  };
  return { ctx, statuses, errors, progresses, opened, focused };
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
});

describe("mergeSelectedLayers", () => {
  it("merges two selected layers into one new layer", async () => {
    tauri.mergeCopcs.mockResolvedValueOnce(result());
    const h = makeHarness([pointCloudLayer("a", "A"), pointCloudLayer("b", "B")], "b", ["a", "b"]);
    await mergeSelectedLayers(h.ctx);
    expect(tauri.mergeCopcs).toHaveBeenLastCalledWith(["a.copc.laz", "b.copc.laz"], expect.anything());
    expect(h.opened).toEqual([["out.copc.laz", "合成 (2)"]]);
    expect(h.statuses).toEqual([{ kind: "ready" }]);
  });

  it("asks for two or more layers", async () => {
    const h = makeHarness([pointCloudLayer("a", "A")], "a");
    await mergeSelectedLayers(h.ctx);
    expect(h.errors).toHaveLength(1);
    expect(h.opened).toEqual([]);
  });
});

describe("cancelTool", () => {
  it("calls the shared cancel command on desktop", () => {
    const h = makeHarness([], null);
    cancelTool(h.ctx);
    expect(tauri.cancelLasConversion).toHaveBeenCalledTimes(1);
  });
});
