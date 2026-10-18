import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { CloudInfo, ConversionResult, DataSource, PrepareOutcome } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { ViewerLayer } from "../state/layers";
import type { ViewerStatus } from "../state/viewer-status";
import { addOpenedLayer, cancelConversion, openFiles, type OpenFilesContext } from "./open-files";

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

const BUSY_MESSAGE = "ファイルを開いている途中・変換中は、新しいファイルを開けません。終わってからもう一度開いてください";

interface Harness {
  ctx: OpenFilesContext;
  statuses: ViewerStatus[];
  errors: Array<[string, string | undefined]>;
  layers: ViewerLayer[];
  progresses: Array<ConversionProgress | null>;
  fileNames: string[];
  prepareToOpen: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  addLayer: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  state: { toolRunning: boolean };
}

/** A context over a fake DataSource (`prepareToOpen` answers `outcome`) and a fake renderer. No React. */
function makeHarness(outcome: PrepareOutcome | (() => Promise<PrepareOutcome>)): Harness {
  const statuses: ViewerStatus[] = [];
  const errors: Array<[string, string | undefined]> = [];
  const layers: ViewerLayer[] = [];
  const progresses: Array<ConversionProgress | null> = [];
  const fileNames: string[] = [];
  const state = { toolRunning: false };
  const prepareToOpen = vi.fn(async () => (typeof outcome === "function" ? outcome() : outcome));
  const open = vi.fn(async () => ({
    cloudId: 7,
    info: INFO,
    nodes: [{ key: "0-0-0-0", pointCount: 1000, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] }],
  }));
  const addLayer = vi.fn();
  const cancel = vi.fn();
  const source = { prepareToOpen, open, readNode: vi.fn(), cancelConversion: cancel } as unknown as DataSource;
  const renderer = { addLayer } as unknown as PointCloudRenderer;
  let nextId = 1;
  const ctx: OpenFilesContext = {
    getSource: () => source,
    getRenderer: () => renderer,
    setStatus: (s) => statuses.push(s),
    reportError: (message, src) => errors.push([message, src]),
    setConversionProgress: (p) => progresses.push(p),
    setConvertingFileName: (n) => fileNames.push(n),
    addLayerToList: (layer) => layers.push(layer),
    nextLayerId: () => `layer-${nextId++}`,
    tempDir: null,
    isMobile: false,
    pointShape: "square",
    isToolRunning: () => state.toolRunning,
    refreshOpfsStorageInfo: async () => {},
    openLock: { busy: false },
  };
  return { ctx, statuses, errors, layers, progresses, fileNames, prepareToOpen, open, addLayer, cancel, state };
}

function fakeFile(name: string): File {
  return new File([""], name);
}

describe("openFiles", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("opens a COPC with no conversion: no breakdown, no download", async () => {
    const h = makeHarness({ kind: "ready", path: "a.copc.laz", conversion: null });
    await openFiles(h.ctx, ["C:/data/a.copc.laz"]);
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
    const h = makeHarness({
      kind: "ready",
      path: "out.copc.laz",
      conversion: { ...CONVERSION, warnings: ["no CRS in a.las", "no CRS in b.las"] },
    });
    await openFiles(h.ctx, [fakeFile("a.las")]);
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
    const h = makeHarness({ kind: "failed", summary: "short", details: "long details" });
    await openFiles(h.ctx, [fakeFile("a.las")]);
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "error", message: "short" });
    expect(h.errors).toEqual([["long details", "conversion"]]);
    expect(h.layers).toEqual([]);
  });

  it("cancelled: status goes back to idle and the banner says so", async () => {
    const h = makeHarness({ kind: "cancelled" });
    await openFiles(h.ctx, [fakeFile("a.las")]);
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "idle" });
    expect(h.errors).toEqual([["変換をキャンセルしました", "conversion"]]);
  });

  it("refuses several files with a non-LAS one before prepareToOpen", async () => {
    const h = makeHarness({ kind: "cancelled" });
    await openFiles(h.ctx, [fakeFile("a.las"), fakeFile("b.ply"), fakeFile("c.pcd")]);
    expect(h.prepareToOpen).not.toHaveBeenCalled();
    expect(h.statuses[h.statuses.length - 1]).toMatchObject({ kind: "error" });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0][0]).toContain("b.ply、c.pcd");
  });

  it("revokes the download URL when adding the layer throws", async () => {
    const h = makeHarness({ kind: "ready", path: "out.copc.laz", conversion: CONVERSION });
    h.open.mockRejectedValueOnce(new Error("open failed"));
    const revoke = vi.fn();
    vi.stubGlobal("URL", { revokeObjectURL: revoke });
    try {
      await openFiles(h.ctx, [fakeFile("a.las")]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(revoke).toHaveBeenCalledWith("blob:fake");
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "error", message: "Error: open failed" });
  });

  it("does nothing for an empty selection", async () => {
    const h = makeHarness({ kind: "cancelled" });
    await openFiles(h.ctx, []);
    expect(h.statuses).toEqual([]);
    expect(h.prepareToOpen).not.toHaveBeenCalled();
  });
});

describe("openFiles progress and file name", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  /** A prepareToOpen that reports two progress values (the second while a tool runs, if asked). */
  function runWithProgress(toolRunningAtSecond: boolean) {
    const progressA = { phase: "reading", pointsRead: 1, totalPoints: 10, elapsedSecs: 0.1 } as const;
    const progressB = { phase: "postProcessing", elapsedSecs: 0.5 } as const;
    const h: Harness = makeHarness(async () => {
      const options = h.prepareToOpen.mock.calls[0][1] as { onProgress: (p: unknown) => void };
      options.onProgress(progressA);
      h.state.toolRunning = toolRunningAtSecond;
      options.onProgress(progressB);
      return { kind: "ready", path: "x.copc.laz", conversion: null };
    });
    return { h, progressA, progressB };
  }

  it("sends progress while converting and clears it afterwards", async () => {
    const { h, progressA, progressB } = runWithProgress(false);
    await openFiles(h.ctx, [fakeFile("a.las")]);
    // null at the start, the two values, null when the conversion is over.
    expect(h.progresses).toEqual([null, progressA, progressB, null]);
    expect(h.fileNames).toEqual(["a.las"]);
  });

  it("ignores progress while a point-cloud tool runs", async () => {
    const { h, progressA } = runWithProgress(true);
    await openFiles(h.ctx, [fakeFile("a.las")]);
    expect(h.progresses).toEqual([null, progressA, null]);
  });
});

describe("openFiles lock", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  /** A prepareToOpen that stays pending until `finish` is called. */
  function pendingOpen() {
    let finish: (outcome: PrepareOutcome | Error) => void = () => {};
    const h = makeHarness(
      () =>
        new Promise<PrepareOutcome>((resolve, reject) => {
          finish = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
        }),
    );
    return { h, finish: (outcome: PrepareOutcome | Error) => finish(outcome) };
  }

  it("refuses a second open while the first awaits prepareToOpen, and leaves the status alone", async () => {
    const { h, finish } = pendingOpen();
    const first = openFiles(h.ctx, [fakeFile("a.las")]);
    const statusesBefore = [...h.statuses];
    await openFiles(h.ctx, [fakeFile("b.las")]);
    expect(h.prepareToOpen).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual(statusesBefore);
    expect(h.errors).toEqual([[BUSY_MESSAGE, "conversion"]]);
    finish({ kind: "cancelled" });
    await first;
  });

  it("releases the lock after a success", async () => {
    const h = makeHarness({ kind: "ready", path: "a.copc.laz", conversion: null });
    await openFiles(h.ctx, ["a.copc.laz"]);
    expect(h.ctx.openLock.busy).toBe(false);
    await openFiles(h.ctx, ["a.copc.laz"]);
    expect(h.prepareToOpen).toHaveBeenCalledTimes(2);
    expect(h.errors).toEqual([]);
  });

  it("releases the lock after a failure", async () => {
    const h = makeHarness({ kind: "failed", summary: "short", details: "long" });
    await openFiles(h.ctx, [fakeFile("a.las")]);
    expect(h.ctx.openLock.busy).toBe(false);
    await openFiles(h.ctx, [fakeFile("a.las")]);
    expect(h.prepareToOpen).toHaveBeenCalledTimes(2);
  });

  it("releases the lock after prepareToOpen throws", async () => {
    const { h, finish } = pendingOpen();
    const first = openFiles(h.ctx, [fakeFile("a.las")]);
    finish(new Error("boom"));
    await first;
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "error", message: "Error: boom" });
    expect(h.ctx.openLock.busy).toBe(false);
    const second = openFiles(h.ctx, [fakeFile("b.las")]);
    expect(h.prepareToOpen).toHaveBeenCalledTimes(2);
    finish({ kind: "cancelled" });
    await second;
  });
});

describe("addOpenedLayer", () => {
  it("throws when the viewer is not initialised", async () => {
    const h = makeHarness({ kind: "cancelled" });
    await expect(addOpenedLayer({ ...h.ctx, getSource: () => null }, "a.copc.laz", "a", null)).rejects.toThrow(
      "ビューアが初期化されていません",
    );
  });

  it("reports a CRS read error but still adds the layer", async () => {
    const h = makeHarness({ kind: "cancelled" });
    h.open.mockResolvedValueOnce({ cloudId: 1, info: { ...INFO, crs: { name: "", kind: "none", error: "bad vlr" } }, nodes: [] });
    await addOpenedLayer(h.ctx, "a.copc.laz", "a", null);
    expect(h.layers).toHaveLength(1);
    expect(h.errors).toEqual([["座標系(CRS)を読み取れませんでした: bad vlr", "crs"]]);
  });
});

describe("cancelConversion", () => {
  it("asks the data source to cancel", () => {
    const h = makeHarness({ kind: "cancelled" });
    cancelConversion(h.ctx);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });
});
