import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import type { RasterPreviewImage } from "../datasource/raster";
import type { ViewerLayer } from "../state/layers";
import { CLOSED_RASTER_WINDOW, type RasterWindowState } from "../state/raster-window";
import type { DisplayUnit } from "../state/units";
import type { ToolProgressState } from "../state/viewer-types";
import type { PointCloudToolsContext } from "./point-cloud-tools";
import {
  changeRasterSettings,
  closeRasterWindow,
  exportRaster,
  fileCellSizeOf,
  openRasterWindow,
  rasterRequestOf,
  type RasterContext,
} from "./raster-window";

// The Tauri commands are what a fake (non-Web) source reaches; each test decides what they answer.
const tauri = vi.hoisted(() => ({
  openRasterPreview: vi.fn(),
  renderRasterPreview: vi.fn(),
  closeRasterPreview: vi.fn(async () => {}),
  exportRasterGeoTiff: vi.fn(),
  chooseGeoTiffDestination: vi.fn(),
  saveToolFile: vi.fn(async () => {}),
  extractToCopc: vi.fn(),
  mergeCopcs: vi.fn(),
  computeSectionLine: vi.fn(),
  cancelLasConversion: vi.fn(async () => {}),
}));
vi.mock("../datasource/tauri", () => tauri);

beforeEach(() => vi.clearAllMocks());

function layerOf(hasColor: boolean, horizontalUnitToMeter: number | null = 1): ViewerLayer {
  return {
    id: "a",
    name: "地形.copc.laz",
    cloudId: 0,
    sourcePath: "a.copc.laz",
    visible: true,
    info: { hasColor, crs: { horizontalUnitToMeter, verticalUnitToMeter: 1 } },
  } as unknown as ViewerLayer;
}

function image(min = 1, max = 9): RasterPreviewImage {
  return {
    width: 2,
    height: 1,
    range: { min, max },
    cellSize: 3,
    points: 4,
    filledCells: 2,
    rgba: new Uint8ClampedArray(8) as Uint8ClampedArray<ArrayBuffer>,
  };
}

interface Harness {
  ctx: RasterContext;
  errors: Array<[string, string | undefined]>;
  progresses: Array<ToolProgressState | null>;
  states: RasterWindowState[];
}

function makeHarness(layer: ViewerLayer, display: DisplayUnit = "meter"): Harness {
  const errors: Array<[string, string | undefined]> = [];
  const progresses: Array<ToolProgressState | null> = [];
  const states: RasterWindowState[] = [];
  let state = CLOSED_RASTER_WINDOW;
  const tools: PointCloudToolsContext = {
    getSource: () => ({}) as DataSource,
    getLayersState: () => ({ layers: [layer], selectedLayerId: layer.id }),
    getViewUp: () => [0, 0, 1],
    extraSelectedIds: [],
    tempDir: null,
    isMobile: false,
    addOpenedLayer: async () => ({ layerId: "x" }),
    setSectionLine: () => {},
    setLayerDtm: () => {},
    setLayerColorMode: () => {},
    focusLayer: () => {},
    setLayerVisible: () => {},
    setStatus: () => {},
    setToolProgress: (p) => progresses.push(p),
    reportError: (message, src) => errors.push([message, src]),
    toolLock: { running: false },
  };
  const ctx: RasterContext = {
    tools,
    getState: () => state,
    setState: (next) => {
      state = next;
      states.push(next);
    },
    getDisplayUnit: () => display,
  };
  return { ctx, errors, progresses, states };
}

describe("cell size", () => {
  it("converts the typed display unit to the file unit", () => {
    const settings = { ...CLOSED_RASTER_WINDOW.settings, cellSizeText: "10" };
    // Metres typed, file in metres: as it is. Feet typed, file in metres: 3.048.
    expect(fileCellSizeOf(layerOf(false), settings, "meter")).toBe(10);
    expect(fileCellSizeOf(layerOf(false), settings, "foot")).toBeCloseTo(3.048, 6);
    // Unknown file unit: the number is taken as it is.
    expect(fileCellSizeOf(layerOf(false, null), settings, "foot")).toBe(10);
  });

  it("is null for text that is not a positive number", () => {
    for (const text of ["", "  ", "0", "-1", "abc"]) {
      const settings = { ...CLOSED_RASTER_WINDOW.settings, cellSizeText: text };
      expect(fileCellSizeOf(layerOf(false), settings, "meter")).toBeNull();
      expect(rasterRequestOf(layerOf(false), settings, "meter")).toBeNull();
    }
  });
});

describe("openRasterWindow", () => {
  it("reads the thinned points once, draws the first picture, and starts with RGB for a coloured layer", async () => {
    tauri.openRasterPreview.mockResolvedValueOnce({ id: 7, info: { heldPoints: 10, depth: 1, truncated: false } });
    tauri.renderRasterPreview.mockResolvedValueOnce(image());
    const h = makeHarness(layerOf(true));
    await openRasterWindow(h.ctx, "a");
    expect(tauri.openRasterPreview).toHaveBeenCalledWith("a.copc.laz");
    expect(tauri.renderRasterPreview).toHaveBeenCalledWith(7, { cellSize: 1, value: "rgbMean", groundOnly: false });
    const state = h.ctx.getState();
    expect(state.open).toBe(true);
    expect(state.session?.id).toBe(7);
    expect(state.image?.range).toEqual({ min: 1, max: 9 });
    expect(state.busy).toBeNull();
    expect(h.errors).toEqual([]);
  });

  it("starts with the height mean for a layer without colour", async () => {
    tauri.openRasterPreview.mockResolvedValueOnce({ id: 1, info: { heldPoints: 1, depth: 0, truncated: false } });
    tauri.renderRasterPreview.mockResolvedValueOnce(image());
    const h = makeHarness(layerOf(false));
    await openRasterWindow(h.ctx, "a");
    expect(h.ctx.getState().settings.value).toBe("zMean");
  });

  it("shows the failure in the window and in the error log", async () => {
    tauri.openRasterPreview.mockRejectedValueOnce(new Error("点群(COPC)として開けませんでした"));
    const h = makeHarness(layerOf(true));
    await openRasterWindow(h.ctx, "a");
    expect(h.errors).toEqual([["点群(COPC)として開けませんでした", "tool"]]);
    const state = h.ctx.getState();
    expect(state.error).toBe("点群(COPC)として開けませんでした");
    expect(state.busy).toBeNull();
    expect(tauri.renderRasterPreview).not.toHaveBeenCalled();
  });

  it("frees the points when the window was closed while they were being read", async () => {
    let finish: (v: unknown) => void = () => {};
    tauri.openRasterPreview.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const h = makeHarness(layerOf(true));
    const opening = openRasterWindow(h.ctx, "a");
    h.ctx.setState(CLOSED_RASTER_WINDOW);
    finish({ id: 3, info: { heldPoints: 1, depth: 0, truncated: false } });
    await opening;
    expect(tauri.closeRasterPreview).toHaveBeenCalledWith(3);
    expect(tauri.renderRasterPreview).not.toHaveBeenCalled();
  });
});

describe("changeRasterSettings", () => {
  async function opened(): Promise<Harness> {
    tauri.openRasterPreview.mockResolvedValueOnce({ id: 7, info: { heldPoints: 10, depth: 1, truncated: false } });
    tauri.renderRasterPreview.mockResolvedValueOnce(image());
    const h = makeHarness(layerOf(true));
    await openRasterWindow(h.ctx, "a");
    tauri.renderRasterPreview.mockClear();
    return h;
  }

  it("draws again from the kept points when value, class or cell size changes", async () => {
    const h = await opened();
    tauri.renderRasterPreview.mockResolvedValueOnce(image(5, 50));
    await changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, value: "count" });
    expect(tauri.renderRasterPreview).toHaveBeenLastCalledWith(7, { cellSize: 1, value: "count", groundOnly: false });
    expect(h.ctx.getState().image?.range).toEqual({ min: 5, max: 50 });
    tauri.renderRasterPreview.mockResolvedValueOnce(image());
    await changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, groundOnly: true, cellSizeText: "2" });
    expect(tauri.renderRasterPreview).toHaveBeenLastCalledWith(7, { cellSize: 2, value: "count", groundOnly: true });
    // The preview never reads the file: no second open.
    expect(tauri.openRasterPreview).toHaveBeenCalledTimes(1);
  });

  it("does not draw again when only the TIFF kind changes", async () => {
    const h = await opened();
    await changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, tiff: "values" });
    expect(tauri.renderRasterPreview).not.toHaveBeenCalled();
    expect(h.ctx.getState().settings.tiff).toBe("values");
  });

  it("keeps the last picture while the cell size text is not a number", async () => {
    const h = await opened();
    await changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, cellSizeText: "" });
    expect(tauri.renderRasterPreview).not.toHaveBeenCalled();
    expect(h.ctx.getState().image).not.toBeNull();
  });

  it("drops the answer for older settings", async () => {
    const h = await opened();
    let answerFirst: (v: RasterPreviewImage) => void = () => {};
    tauri.renderRasterPreview.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    const first = changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, value: "count" });
    tauri.renderRasterPreview.mockResolvedValueOnce(image(100, 200));
    await changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, value: "zMax" });
    answerFirst(image(1, 2)); // the slow answer for "count" arrives last
    await first;
    expect(h.ctx.getState().image?.range).toEqual({ min: 100, max: 200 });
  });

  it("shows a failed picture as an error without a picture", async () => {
    const h = await opened();
    tauri.renderRasterPreview.mockRejectedValueOnce(new Error("ラスタにできる点がありません"));
    await changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, groundOnly: true });
    expect(h.ctx.getState().error).toBe("ラスタにできる点がありません");
    expect(h.ctx.getState().image).toBeNull();
  });
});

describe("exportRaster (desktop)", () => {
  async function opened(): Promise<Harness> {
    tauri.openRasterPreview.mockResolvedValueOnce({ id: 7, info: { heldPoints: 10, depth: 1, truncated: false } });
    tauri.renderRasterPreview.mockResolvedValueOnce(image(3, 8));
    const h = makeHarness(layerOf(true));
    await openRasterWindow(h.ctx, "a");
    return h;
  }

  it("asks where to save, exports with the preview's range, and copies the file there", async () => {
    const h = await opened();
    tauri.chooseGeoTiffDestination.mockResolvedValueOnce("C:/out/x.tif");
    tauri.exportRasterGeoTiff.mockResolvedValueOnce({ width: 5, height: 4, warnings: ["座標系がありません"], path: "tmp.tif", download: null });
    await exportRaster(h.ctx);
    expect(tauri.chooseGeoTiffDestination).toHaveBeenCalledWith("地形-raster.tif");
    expect(tauri.exportRasterGeoTiff).toHaveBeenCalledWith(
      "a.copc.laz",
      { cellSize: 1, value: "rgbMean", groundOnly: false, tiff: "colored", range: [3, 8] },
      expect.anything(),
    );
    expect(tauri.saveToolFile).toHaveBeenCalledWith("tmp.tif", "C:/out/x.tif");
    expect(h.errors).toEqual([["座標系がありません", "tool"]]);
    expect(h.ctx.getState().exported?.width).toBe(5);
    expect(h.progresses[0]).toEqual({ title: "ラスタ化の書き出し（地形.copc.laz）", pointsRead: 0, totalPoints: 0 });
    expect(h.progresses[h.progresses.length - 1]).toBeNull();
    expect(h.ctx.tools.toolLock.running).toBe(false);
  });

  it("does nothing when the save dialog is closed", async () => {
    const h = await opened();
    tauri.chooseGeoTiffDestination.mockResolvedValueOnce(null);
    await exportRaster(h.ctx);
    expect(tauri.exportRasterGeoTiff).not.toHaveBeenCalled();
    expect(h.progresses).toEqual([]);
  });

  it("sends the raw-value kind and no range-dependence to Rust", async () => {
    const h = await opened();
    await changeRasterSettings(h.ctx, { ...h.ctx.getState().settings, tiff: "values" });
    tauri.chooseGeoTiffDestination.mockResolvedValueOnce("C:/out/x.tif");
    tauri.exportRasterGeoTiff.mockResolvedValueOnce({ width: 1, height: 1, warnings: [], path: "t.tif", download: null });
    await exportRaster(h.ctx);
    expect(tauri.exportRasterGeoTiff.mock.calls[0][1]).toMatchObject({ tiff: "values" });
  });

  it("reports a failure and a cancel, and frees the tool lock", async () => {
    const h = await opened();
    tauri.chooseGeoTiffDestination.mockResolvedValue("C:/out/x.tif");
    tauri.exportRasterGeoTiff.mockRejectedValueOnce(new Error("ラスタが大きすぎます"));
    await exportRaster(h.ctx);
    tauri.exportRasterGeoTiff.mockRejectedValueOnce(new Error("キャンセルされた"));
    await exportRaster(h.ctx);
    expect(h.errors).toEqual([
      ["ラスタが大きすぎます", "tool"],
      ["ラスタ化の書き出し（地形.copc.laz）をキャンセルしました", "tool"],
    ]);
    expect(tauri.saveToolFile).not.toHaveBeenCalled();
    expect(h.ctx.tools.toolLock.running).toBe(false);
    expect(h.ctx.getState().exported).toBeNull();
  });

  it("refuses to start while another tool runs", async () => {
    const h = await opened();
    h.ctx.tools.toolLock.running = true;
    await exportRaster(h.ctx);
    expect(tauri.chooseGeoTiffDestination).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(1);
  });
});

describe("closeRasterWindow", () => {
  it("frees the kept points and resets the state", async () => {
    tauri.openRasterPreview.mockResolvedValueOnce({ id: 7, info: { heldPoints: 10, depth: 1, truncated: false } });
    tauri.renderRasterPreview.mockResolvedValueOnce(image());
    const h = makeHarness(layerOf(true));
    await openRasterWindow(h.ctx, "a");
    await closeRasterWindow(h.ctx);
    expect(tauri.closeRasterPreview).toHaveBeenCalledWith(7);
    expect(h.ctx.getState()).toEqual(CLOSED_RASTER_WINDOW);
  });
});
