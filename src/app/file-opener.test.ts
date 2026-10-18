import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudInfo, ConversionResult, DataSource, PrepareOutcome } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { ViewerLayer } from "../state/layers";
import type { ViewerStatus } from "../state/viewer-status";
import { FileOpener, type FileOpenerDeps } from "./file-opener";

// The Tauri bridge is not needed here, and the breakdown text is tested on its own (conversion-breakdown.test.ts).
vi.mock("../datasource/tauri", () => ({ reportToBackendConsole: vi.fn(async () => {}) }));
vi.mock("../datasource/conversion-breakdown", () => ({ formatConversionBreakdown: () => "BREAKDOWN" }));

const INFO: CloudInfo = {
  pointCount: 1000,
  min: [0, 0, 0],
  max: [1, 1, 1],
  scale: [0.01, 0.01, 0.01],
  offset: [0, 0, 0],
  hasColor: true,
  crs: { name: "", kind: "none" },
};

const CONVERSION: ConversionResult = {
  outputName: "out.copc.laz",
  platform: "web",
  sourceFormat: "las",
  // The breakdown formatter is mocked, so the timings are never read.
  stageTimings: {} as ConversionResult["stageTimings"],
  warnings: [],
  download: { url: "blob:fake", fileName: "out.copc.laz" },
};

interface Harness {
  opener: FileOpener;
  statuses: ViewerStatus[];
  errors: Array<[string, string | undefined]>;
  layers: ViewerLayer[];
  prepareToOpen: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  addLayer: ReturnType<typeof vi.fn>;
  state: { toolRunning: boolean };
  deps: FileOpenerDeps;
}

/** A FileOpener over a fake DataSource (`prepareToOpen` answers `outcome`) and a fake renderer. No React. */
function makeOpener(outcome: PrepareOutcome | (() => Promise<PrepareOutcome>)): Harness {
  const statuses: ViewerStatus[] = [];
  const errors: Array<[string, string | undefined]> = [];
  const layers: ViewerLayer[] = [];
  const state = { toolRunning: false };
  const prepareToOpen = vi.fn(async () => (typeof outcome === "function" ? outcome() : outcome));
  const open = vi.fn(async () => ({
    cloudId: 7,
    info: INFO,
    nodes: [{ key: "0-0-0-0", pointCount: 1000, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] }],
  }));
  const addLayer = vi.fn();
  const source = { prepareToOpen, open, readNode: vi.fn(), cancelConversion: vi.fn() } as unknown as DataSource;
  const renderer = { addLayer } as unknown as PointCloudRenderer;
  let nextId = 1;
  const deps: FileOpenerDeps = {
    getSource: () => source,
    getRenderer: () => renderer,
    setStatus: (s) => statuses.push(s),
    reportError: (message, src) => errors.push([message, src]),
    addLayerToList: (layer) => layers.push(layer),
    nextLayerId: () => `layer-${nextId++}`,
    getTempDir: () => null,
    isMobile: false,
    pointShape: "square",
    isToolRunning: () => state.toolRunning,
    refreshOpfsStorageInfo: async () => {},
  };
  return { opener: new FileOpener(deps), statuses, errors, layers, prepareToOpen, open, addLayer, state, deps };
}

function fakeFile(name: string): File {
  return new File([""], name);
}

describe("FileOpener.openFiles", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("opens a COPC with no conversion: no breakdown, no download", async () => {
    const h = makeOpener({ kind: "ready", path: "a.copc.laz", conversion: null });
    await h.opener.openFiles(["C:/data/a.copc.laz"]);
    expect(h.statuses).toEqual([{ kind: "opening" }, { kind: "ready" }]);
    expect(h.layers).toHaveLength(1);
    expect(h.layers[0]).toMatchObject({
      name: "a.copc.laz",
      sourcePath: "a.copc.laz",
      conversionBreakdownText: null,
      download: null,
    });
    expect(h.addLayer).toHaveBeenCalledTimes(1);
    expect(h.errors).toEqual([]);
  });

  it("attaches the breakdown and the download of a conversion, and reports each warning", async () => {
    const h = makeOpener({
      kind: "ready",
      path: "out.copc.laz",
      conversion: { ...CONVERSION, warnings: ["no CRS in a.las", "no CRS in b.las"] },
    });
    await h.opener.openFiles([fakeFile("a.las")]);
    expect(h.layers[0]).toMatchObject({
      name: "out.copc.laz",
      conversionBreakdownText: "BREAKDOWN",
      download: { url: "blob:fake", fileName: "out.copc.laz" },
    });
    expect(h.errors).toEqual([
      ["no CRS in a.las", "conversion"],
      ["no CRS in b.las", "conversion"],
    ]);
  });

  it("failed: summary in the status, details in the error log", async () => {
    const h = makeOpener({ kind: "failed", summary: "short", details: "long details" });
    await h.opener.openFiles([fakeFile("a.las")]);
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "error", message: "short" });
    expect(h.errors).toEqual([["long details", "conversion"]]);
    expect(h.layers).toEqual([]);
  });

  it("cancelled: status goes back to idle and the banner says so", async () => {
    const h = makeOpener({ kind: "cancelled" });
    await h.opener.openFiles([fakeFile("a.las")]);
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "idle" });
    expect(h.errors).toEqual([["変換をキャンセルしました", "conversion"]]);
  });

  it("refuses several files with a non-LAS one before prepareToOpen", async () => {
    const h = makeOpener({ kind: "cancelled" });
    await h.opener.openFiles([fakeFile("a.las"), fakeFile("b.ply"), fakeFile("c.pcd")]);
    expect(h.prepareToOpen).not.toHaveBeenCalled();
    expect(h.statuses[h.statuses.length - 1]).toMatchObject({ kind: "error" });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0][0]).toContain("b.ply、c.pcd");
  });

  it("revokes the download URL when adding the layer throws", async () => {
    const h = makeOpener({ kind: "ready", path: "out.copc.laz", conversion: CONVERSION });
    h.open.mockRejectedValueOnce(new Error("open failed"));
    const revoke = vi.fn();
    vi.stubGlobal("URL", { revokeObjectURL: revoke });
    try {
      await h.opener.openFiles([fakeFile("a.las")]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(revoke).toHaveBeenCalledWith("blob:fake");
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "error", message: "Error: open failed" });
  });

  it("does nothing for an empty selection", async () => {
    const h = makeOpener({ kind: "cancelled" });
    await h.opener.openFiles([]);
    expect(h.statuses).toEqual([]);
    expect(h.prepareToOpen).not.toHaveBeenCalled();
  });
});

describe("FileOpener progress and snapshot", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  /** A prepareToOpen that reports two progress values (one while a tool runs) and records what the snapshot held. */
  function runWithProgress(toolRunningAtSecond: boolean) {
    const seen: Array<unknown> = [];
    const progressA = { phase: "reading", pointsRead: 1, totalPoints: 10, elapsedSecs: 0.1 } as const;
    const progressB = { phase: "postProcessing", elapsedSecs: 0.5 } as const;
    const h: Harness = makeOpener(async () => {
      const options = h.prepareToOpen.mock.calls[0][1] as { onProgress: (p: unknown) => void };
      options.onProgress(progressA);
      seen.push(h.opener.getSnapshot().conversionProgress);
      h.state.toolRunning = toolRunningAtSecond;
      options.onProgress(progressB);
      seen.push(h.opener.getSnapshot().conversionProgress);
      return { kind: "ready", path: "x.copc.laz", conversion: null };
    });
    return { h, seen, progressA, progressB };
  }

  it("keeps progress while converting and clears it afterwards", async () => {
    const { h, seen, progressA, progressB } = runWithProgress(false);
    await h.opener.openFiles([fakeFile("a.las")]);
    expect(seen).toEqual([progressA, progressB]);
    expect(h.opener.getSnapshot().conversionProgress).toBeNull();
    expect(h.opener.getSnapshot().convertingFileName).toBe("a.las");
  });

  it("ignores progress while a point-cloud tool runs", async () => {
    const { h, seen, progressA } = runWithProgress(true);
    await h.opener.openFiles([fakeFile("a.las")]);
    expect(seen).toEqual([progressA, progressA]);
  });

  it("returns a new snapshot object after a change and the same object otherwise", async () => {
    const h = makeOpener({ kind: "cancelled" });
    const before = h.opener.getSnapshot();
    expect(h.opener.getSnapshot()).toBe(before);
    const listener = vi.fn();
    const unsubscribe = h.opener.subscribe(listener);
    await h.opener.openFiles([fakeFile("a.las")]);
    const after = h.opener.getSnapshot();
    expect(after).not.toBe(before);
    expect(before.convertingFileName).toBeNull();
    expect(after.convertingFileName).toBe("a.las");
    expect(listener).toHaveBeenCalled();
    // Opening the same file again changes nothing in the snapshot, so the object stays the same.
    const calls = listener.mock.calls.length;
    await h.opener.openFiles([fakeFile("a.las")]);
    expect(h.opener.getSnapshot()).toBe(after);
    expect(listener.mock.calls.length).toBe(calls);
    unsubscribe();
  });
});

describe("FileOpener.addOpenedLayer", () => {
  it("throws when the viewer is not initialised", async () => {
    const h = makeOpener({ kind: "cancelled" });
    const opener = new FileOpener({ ...h.deps, getSource: () => null });
    await expect(opener.addOpenedLayer("a.copc.laz", "a", null)).rejects.toThrow("ビューアが初期化されていません");
  });

  it("reports a CRS read error but still adds the layer", async () => {
    const h = makeOpener({ kind: "cancelled" });
    h.open.mockResolvedValueOnce({ cloudId: 1, info: { ...INFO, crs: { name: "", kind: "none", error: "bad vlr" } }, nodes: [] });
    await h.opener.addOpenedLayer("a.copc.laz", "a", null);
    expect(h.layers).toHaveLength(1);
    expect(h.errors).toEqual([["座標系(CRS)を読み取れませんでした: bad vlr", "crs"]]);
  });
});
