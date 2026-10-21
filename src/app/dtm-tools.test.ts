import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import type { DtmInfo, DtmRequest, DtmResult } from "../datasource/dtm";
import type { ColorMode } from "../renderer/colormap";
import type { ViewerLayer } from "../state/layers";
import { makeDtm, saveDtmFile, type PointCloudToolsContext } from "./point-cloud-tools";
import { CSF_PRESETS_METRES } from "./csf-params";

// What a fake (non-Web) source reaches: the Tauri commands.
const tauri = vi.hoisted(() => ({
  extractToCopc: vi.fn(),
  mergeCopcs: vi.fn(),
  cancelLasConversion: vi.fn(async () => {}),
  computeSectionLine: vi.fn(),
  dtmCopc: vi.fn(),
  chooseGeoTiffDestination: vi.fn(),
  chooseLandXmlDestination: vi.fn(),
  saveToolFile: vi.fn(async () => {}),
}));
vi.mock("../datasource/tauri", () => tauri);

beforeEach(() => vi.clearAllMocks());

const REQUEST: DtmRequest = {
  csf: CSF_PRESETS_METRES.standard,
  cellSize: 0.5,
  output: { geotiff: true, landxml: false, tiff: "colored", unit: "meter" },
};

const INFO: DtmInfo = {
  cellSize: 0.5,
  width: 100,
  height: 80,
  tinPoints: 5000,
  tinTriangles: 9900,
  groundPoints: 20000,
  geotiff: { fileName: "地形-dtm.tif", path: "C:/tmp/pcv-tools/x.tif", downloadUrl: null },
  landxml: null,
};

const OK: DtmResult = { outputPath: "out.copc.laz", pointCount: 30000, warnings: [], dtm: INFO };

function pointCloudLayer(id: string, name: string): ViewerLayer {
  return { id, name, cloudId: 0, sourcePath: `${id}.copc.laz`, visible: true, info: {} } as unknown as ViewerLayer;
}

function measureLayer(id: string): ViewerLayer {
  return { id, name: "計測", visible: true, kind: "measure" } as unknown as ViewerLayer;
}

function makeHarness(layers: ViewerLayer[]) {
  const errors: Array<[string, string | undefined]> = [];
  const opened: Array<[string, string]> = [];
  const hidden: string[] = [];
  const progresses: unknown[] = [];
  const dtmSet: Array<[string, DtmInfo]> = [];
  const colorModes: Array<[string, ColorMode]> = [];
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
    setLayerDtm: (id, dtm) => dtmSet.push([id, dtm]),
    setLayerColorMode: (id, mode) => colorModes.push([id, mode]),
    focusLayer: () => {},
    setLayerVisible: (id, visible) => {
      if (!visible) hidden.push(id);
    },
    setStatus: () => {},
    setToolProgress: (p) => progresses.push(p),
    reportError: (message, src) => errors.push([message, src]),
    toolLock: { running: false },
  };
  return { ctx, errors, opened, hidden, progresses, dtmSet, colorModes };
}

describe("makeDtm", () => {
  it("opens 地表 - name, hides the source, keeps the DTM on the new layer and colours it by class", async () => {
    tauri.dtmCopc.mockResolvedValueOnce(OK);
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await makeDtm(h.ctx, "a", REQUEST);
    expect(tauri.dtmCopc).toHaveBeenCalledWith("a.copc.laz", REQUEST, expect.anything());
    expect(h.opened).toEqual([["out.copc.laz", "地表 - 地形"]]);
    expect(h.hidden).toEqual(["a"]);
    expect(h.dtmSet).toEqual([["new-layer", INFO]]);
    expect(h.colorModes).toEqual([["new-layer", "classification"]]);
    expect(h.errors).toEqual([]);
    // The progress is a fraction, so it is shown as a percent.
    expect(h.progresses[0]).toEqual({ title: "DTM（地形）", pointsRead: 0, totalPoints: 0, showAsPercent: true });
    expect(h.ctx.toolLock.running).toBe(false);
  });

  it("a failure goes to the error log and the source stays visible", async () => {
    tauri.dtmCopc.mockRejectedValueOnce(new Error("布の粒子が 50.0 百万個必要で、上限を超えます"));
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await makeDtm(h.ctx, "a", REQUEST);
    expect(h.errors).toEqual([["布の粒子が 50.0 百万個必要で、上限を超えます", "tool"]]);
    expect(h.opened).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(h.dtmSet).toEqual([]);
    expect(h.colorModes).toEqual([]);
    expect(h.ctx.toolLock.running).toBe(false);
  });

  it("a cancel is reported with the tool title and the source stays visible", async () => {
    tauri.dtmCopc.mockRejectedValueOnce(new Error("キャンセルされた"));
    const h = makeHarness([pointCloudLayer("a", "地形")]);
    await makeDtm(h.ctx, "a", REQUEST);
    expect(h.errors).toEqual([["DTM（地形）をキャンセルしました", "tool"]]);
    expect(h.hidden).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.dtmSet).toEqual([]);
  });

  it("refuses a layer that is not a point cloud, or does not exist", async () => {
    const h = makeHarness([measureLayer("m")]);
    await makeDtm(h.ctx, "m", REQUEST);
    await makeDtm(h.ctx, "missing", REQUEST);
    expect(h.errors).toEqual([
      ["点群のレイヤーを選んでください", "tool"],
      ["点群のレイヤーを選んでください", "tool"],
    ]);
    expect(tauri.dtmCopc).not.toHaveBeenCalled();
  });
});

describe("saveDtmFile", () => {
  const file = INFO.geotiff as NonNullable<DtmInfo["geotiff"]>;

  it("copies the file where the user chose", async () => {
    tauri.chooseGeoTiffDestination.mockResolvedValueOnce("D:/out/dtm.tif");
    const h = makeHarness([]);
    await saveDtmFile(h.ctx, file, "geotiff");
    expect(tauri.chooseGeoTiffDestination).toHaveBeenCalledWith("地形-dtm.tif");
    expect(tauri.saveToolFile).toHaveBeenCalledWith("C:/tmp/pcv-tools/x.tif", "D:/out/dtm.tif");
    expect(h.errors).toEqual([]);
  });

  it("uses the LandXML dialog for LandXML", async () => {
    tauri.chooseLandXmlDestination.mockResolvedValueOnce("D:/out/dtm.xml");
    const h = makeHarness([]);
    await saveDtmFile(h.ctx, { fileName: "a-dtm.xml", path: "C:/tmp/pcv-tools/y.xml", downloadUrl: null }, "landxml");
    expect(tauri.chooseLandXmlDestination).toHaveBeenCalledWith("a-dtm.xml");
    expect(tauri.saveToolFile).toHaveBeenCalledWith("C:/tmp/pcv-tools/y.xml", "D:/out/dtm.xml");
  });

  it("does nothing when the dialog is closed", async () => {
    tauri.chooseGeoTiffDestination.mockResolvedValueOnce(null);
    const h = makeHarness([]);
    await saveDtmFile(h.ctx, file, "geotiff");
    expect(tauri.saveToolFile).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it("a failed copy goes to the error log", async () => {
    tauri.chooseGeoTiffDestination.mockResolvedValueOnce("D:/out/dtm.tif");
    tauri.saveToolFile.mockRejectedValueOnce(new Error("ファイルを保存できませんでした"));
    const h = makeHarness([]);
    await saveDtmFile(h.ctx, file, "geotiff");
    expect(h.errors).toEqual([["ファイルを保存できませんでした", "tool"]]);
  });
});
