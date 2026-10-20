import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import { NO_SECTION_POINTS, type SectionPoints } from "../datasource/section-profile";
import type { ViewerLayer } from "../state/layers";
import { fitView, type SectionView } from "./section-math";
import {
  closeSectionPanel,
  effectiveSectionView,
  newSectionGesture,
  openSectionPanel,
  resetSectionView,
  sectionPointerCancel,
  sectionPointerDown,
  sectionPointerMove,
  sectionPointerUp,
  setSectionPanelSize,
  wheelZoomFactor,
  zoomSectionWheel,
  type SectionPointer,
  type SectionViewContext,
} from "./section-view";

// The Tauri command is what a fake (non-Web) source reaches.
const tauri = vi.hoisted(() => ({ readSectionProfile: vi.fn() }));
vi.mock("../datasource/tauri", () => tauri);

beforeEach(() => vi.clearAllMocks());

const POINTS: SectionPoints = {
  count: 2,
  thinned: false,
  hasColor: true,
  sRange: { min: 0, max: 100 },
  zRange: { min: 0, max: 50 },
  floats: new Float32Array(6),
  words: new Uint32Array(6),
};

function sectionLayer(): ViewerLayer {
  return {
    id: "sec",
    name: "断面 - 地形",
    sourcePath: "sec.copc.laz",
    cloudId: 7,
    section: { a: [0, 0, 0], b: [100, 0, 0], up: [0, 0, 1], thickness: 1 },
  } as unknown as ViewerLayer;
}

interface Harness {
  ctx: SectionViewContext;
  errors: Array<[string, string | undefined]>;
}

/** A context whose setters write into the same object, so the state can be read back (like React would, a render later). */
function makeHarness(layers: ViewerLayer[] = [sectionLayer()], source: DataSource | null = {} as DataSource): Harness {
  const errors: Array<[string, string | undefined]> = [];
  const ctx: SectionViewContext = {
    openLayerId: null,
    points: NO_SECTION_POINTS,
    loading: false,
    view: null,
    panelSize: { width: 400, height: 300 },
    getSource: () => source,
    getLayersState: () => ({ layers, selectedLayerId: null }),
    reportError: (message, src) => errors.push([message, src]),
    setOpenLayerId: (id) => void (ctx.openLayerId = id),
    setPoints: (p) => void (ctx.points = p),
    setLoading: (l) => void (ctx.loading = l),
    setView: (v) => void (ctx.view = v),
    setPanelSize: (s) => void (ctx.panelSize = s),
    token: { generation: 0 },
    gesture: newSectionGesture(),
  };
  return { ctx, errors };
}

describe("openSectionPanel", () => {
  it("reads the points of the section layer and shows them", async () => {
    tauri.readSectionProfile.mockResolvedValueOnce(POINTS);
    const { ctx, errors } = makeHarness();
    const done = openSectionPanel(ctx, "sec");
    expect(ctx.openLayerId).toBe("sec");
    expect(ctx.loading).toBe(true);
    await done;
    expect(tauri.readSectionProfile).toHaveBeenCalledWith(7, { a: [0, 0, 0], b: [100, 0, 0], up: [0, 0, 1] }, 2_000_000);
    expect(ctx.points).toBe(POINTS);
    expect(ctx.loading).toBe(false);
    expect(ctx.view).toBeNull();
    expect(errors).toEqual([]);
  });

  it("sends a failure to the error log as it is and closes the panel", async () => {
    tauri.readSectionProfile.mockRejectedValueOnce(new Error("読めない"));
    const { ctx, errors } = makeHarness();
    await openSectionPanel(ctx, "sec");
    expect(errors).toEqual([["断面図の点を読めませんでした: 読めない", "tool"]]);
    expect(ctx.openLayerId).toBeNull();
    expect(ctx.loading).toBe(false);
  });

  it("refuses a layer without section information", async () => {
    const plain = { id: "p", name: "p", sourcePath: "p.copc.laz", cloudId: 1 } as unknown as ViewerLayer;
    const { ctx, errors } = makeHarness([plain]);
    await openSectionPanel(ctx, "p");
    expect(errors).toHaveLength(1);
    expect(ctx.openLayerId).toBeNull();
    expect(tauri.readSectionProfile).not.toHaveBeenCalled();
  });

  it("drops a read that finishes after the panel was closed", async () => {
    let finish: (p: SectionPoints) => void = () => {};
    tauri.readSectionProfile.mockReturnValueOnce(new Promise<SectionPoints>((resolve) => (finish = resolve)));
    const { ctx } = makeHarness();
    const done = openSectionPanel(ctx, "sec");
    closeSectionPanel(ctx);
    finish(POINTS);
    await done;
    expect(ctx.openLayerId).toBeNull();
    expect(ctx.points).toBe(NO_SECTION_POINTS);
  });

  it("drops an older read when a newer one was started", async () => {
    let finishOld: (p: SectionPoints) => void = () => {};
    tauri.readSectionProfile.mockReturnValueOnce(new Promise<SectionPoints>((resolve) => (finishOld = resolve)));
    tauri.readSectionProfile.mockResolvedValueOnce({ ...POINTS, count: 99 });
    const { ctx } = makeHarness();
    const older = openSectionPanel(ctx, "sec");
    await openSectionPanel(ctx, "sec");
    finishOld(POINTS);
    await older;
    expect(ctx.points.count).toBe(99);
  });
});

describe("view", () => {
  it("fits all points into the panel until the user moves the view", () => {
    const { ctx } = makeHarness();
    ctx.points = POINTS;
    expect(effectiveSectionView(ctx)).toEqual(fitView(ctx.panelSize, POINTS.sRange, POINTS.zRange, 40));
  });

  it("keeps the user's view on resize, and 全体表示 goes back to the fit", () => {
    const { ctx } = makeHarness();
    ctx.points = POINTS;
    const mine: SectionView = { scale: 2, offsetX: 5, offsetY: 6 };
    ctx.view = mine;
    setSectionPanelSize(ctx, { width: 500, height: 200 });
    expect(ctx.panelSize).toEqual({ width: 500, height: 200 });
    expect(ctx.view).toBe(mine);
    resetSectionView(ctx);
    expect(ctx.view).toBeNull();
  });

  it("zooms about the cursor with the wheel: the point under the cursor stays", () => {
    const { ctx } = makeHarness();
    ctx.view = { scale: 2, offsetX: 10, offsetY: 100 };
    const cursor = { x: 50, y: 60 };
    const before = { s: (cursor.x - 10) / 2, z: (100 - cursor.y) / 2 };
    zoomSectionWheel(ctx, cursor, -100, 0); // wheel up: zoom in
    const view = ctx.view as SectionView;
    expect(view.scale).toBeGreaterThan(2);
    expect((cursor.x - view.offsetX) / view.scale).toBeCloseTo(before.s);
    expect((view.offsetY - cursor.y) / view.scale).toBeCloseTo(before.z);
  });

  it("makes a wheel notch about 10 percent, in lines and pages too", () => {
    expect(wheelZoomFactor(-100, 0)).toBeCloseTo(1.105, 3);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0));
    expect(wheelZoomFactor(-1, 2)).toBeCloseTo(wheelZoomFactor(-400, 0));
  });
});

function pointer(id: number, type: string, button: number, x: number, y: number, timeMs: number): SectionPointer {
  return { pointerId: id, pointerType: type, button, x, y, timeMs };
}

describe("mouse", () => {
  it("pans with a right-button drag, including the first few pixels", () => {
    const { ctx } = makeHarness();
    ctx.view = { scale: 1, offsetX: 0, offsetY: 0 };
    sectionPointerDown(ctx, pointer(1, "mouse", 2, 100, 100, 0));
    sectionPointerMove(ctx, pointer(1, "mouse", 2, 103, 100, 10)); // 3 px: not yet a drag
    expect(ctx.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    sectionPointerMove(ctx, pointer(1, "mouse", 2, 110, 95, 20)); // now a drag: moves by the whole distance from the press
    expect(ctx.view).toEqual({ scale: 1, offsetX: 10, offsetY: -5 });
    sectionPointerMove(ctx, pointer(1, "mouse", 2, 120, 95, 30));
    expect(ctx.view).toEqual({ scale: 1, offsetX: 20, offsetY: -5 });
    sectionPointerUp(ctx, pointer(1, "mouse", 2, 120, 95, 40));
    expect(ctx.gesture.pointers.size).toBe(0);
  });

  it("pans after a long press even if the first movement is small", () => {
    const { ctx } = makeHarness();
    ctx.view = { scale: 1, offsetX: 0, offsetY: 0 };
    sectionPointerDown(ctx, pointer(1, "mouse", 2, 100, 100, 0));
    sectionPointerMove(ctx, pointer(1, "mouse", 2, 102, 100, 400)); // held 400 ms: a pan from the first move
    expect(ctx.view).toEqual({ scale: 1, offsetX: 2, offsetY: 0 });
  });

  it("does not pan with the left button, and a short right press is a click that moves nothing", () => {
    const { ctx } = makeHarness();
    ctx.view = { scale: 1, offsetX: 0, offsetY: 0 };
    sectionPointerDown(ctx, pointer(1, "mouse", 0, 100, 100, 0));
    sectionPointerMove(ctx, pointer(1, "mouse", 0, 150, 100, 10));
    sectionPointerUp(ctx, pointer(1, "mouse", 0, 150, 100, 20));
    sectionPointerDown(ctx, pointer(2, "mouse", 2, 100, 100, 100));
    sectionPointerUp(ctx, pointer(2, "mouse", 2, 100, 100, 150)); // right click: the G2-6 stub, nothing visible yet
    expect(ctx.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });
});

describe("touch", () => {
  it("pinches about the midpoint and pans with two fingers", () => {
    const { ctx } = makeHarness();
    ctx.view = { scale: 1, offsetX: 0, offsetY: 0 };
    sectionPointerDown(ctx, pointer(1, "touch", 0, 100, 100, 0));
    sectionPointerDown(ctx, pointer(2, "touch", 0, 200, 100, 0));
    // Fingers move apart symmetrically: the midpoint (150, 100) stays, the distance doubles.
    sectionPointerMove(ctx, pointer(1, "touch", 0, 50, 100, 10));
    sectionPointerMove(ctx, pointer(2, "touch", 0, 250, 100, 10));
    const view = ctx.view as SectionView;
    expect(view.scale).toBeCloseTo(2, 5); // 150/100 then 200/150: the distance went from 100 to 200
    // Each finger is still near the section point it started on (100 and 200). Not exact: the fingers arrive one
    // event at a time and `twoFingerStep` works on the midpoint, so the error is a few pixels while one finger lags.
    expect(Math.abs((50 - view.offsetX) / view.scale - 100)).toBeLessThan(5);
    expect(Math.abs((250 - view.offsetX) / view.scale - 200)).toBeLessThan(5);
  });

  it("does nothing with one moving finger yet (line editing is G2-5)", () => {
    const { ctx } = makeHarness();
    ctx.view = { scale: 1, offsetX: 0, offsetY: 0 };
    sectionPointerDown(ctx, pointer(1, "touch", 0, 100, 100, 0));
    sectionPointerMove(ctx, pointer(1, "touch", 0, 160, 100, 10));
    expect(ctx.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it("forgets a cancelled pointer", () => {
    const { ctx } = makeHarness();
    sectionPointerDown(ctx, pointer(1, "touch", 0, 100, 100, 0));
    sectionPointerCancel(ctx, pointer(1, "touch", 0, 100, 100, 5));
    expect(ctx.gesture.pointers.size).toBe(0);
    expect(ctx.gesture.multiTouch).toBe(false);
  });
});
