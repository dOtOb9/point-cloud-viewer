import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import { NO_SECTION_POINTS, type SectionPoints } from "../datasource/section-profile";
import { setLayerSectionLineHistoryInList, type ViewerLayer } from "../state/layers";
import { canRedo, canUndo, fitView, newHistory, type SectionView } from "./section-math";
import {
  closeSectionPanel,
  effectiveSectionView,
  newSectionGesture,
  openSectionPanel,
  redoSectionLine,
  resetSectionLineToComputed,
  resetSectionView,
  sectionPointerCancel,
  sectionPointerDown,
  sectionPointerLeave,
  sectionPointerMove,
  sectionPointerUp,
  setSectionPanelSize,
  showGroundLevelAt,
  undoSectionLine,
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
function makeHarness(initialLayers: ViewerLayer[] = [sectionLayer()], source: DataSource | null = {} as DataSource): Harness {
  // The layers state changes when the history of a section line is set, as the React state would a render later.
  let layers = initialLayers;
  const errors: Array<[string, string | undefined]> = [];
  const ctx: SectionViewContext = {
    openLayerId: null,
    points: NO_SECTION_POINTS,
    loading: false,
    view: null,
    panelSize: { width: 400, height: 300 },
    cursorS: null,
    groundLevel: null,
    trace: null,
    getSource: () => source,
    getLayersState: () => ({ layers, selectedLayerId: null }),
    reportError: (message, src) => errors.push([message, src]),
    setOpenLayerId: (id) => void (ctx.openLayerId = id),
    setPoints: (p) => void (ctx.points = p),
    setLoading: (l) => void (ctx.loading = l),
    setView: (v) => void (ctx.view = v),
    setPanelSize: (s) => void (ctx.panelSize = s),
    setCursorS: (s) => void (ctx.cursorS = s),
    setGroundLevel: (g) => void (ctx.groundLevel = g),
    setTrace: (points) => void (ctx.trace = points),
    setSectionLineHistory: (id, history) => void (layers = setLayerSectionLineHistoryInList(layers, id, history)),
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

  it("does not move the view with one moving finger (that is the trace of G2-5)", () => {
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

describe("ground level (G2-6) and cursor (G2-8)", () => {
  /** Layer with a line z = 10 (s 0..50) then rising 1:1 (s 50..100), in a CRS of the given unit factors. */
  function layerWithLine(unit: number | null): ViewerLayer {
    const base = sectionLayer();
    const crs = unit === null ? null : { horizontalUnitToMeter: unit, verticalUnitToMeter: unit };
    return {
      ...base,
      info: { crs } as ViewerLayer["info"],
      section: { ...base.section!, line: { original: LINE, history: newHistory(LINE) } },
    } as ViewerLayer;
  }
  const LINE = { points: new Float32Array([0, 10, 50, 10, 100, 60]), groundPoints: 3, cells: 3 };

  function openedHarness(unit: number | null, withLine = true) {
    const layer = withLine ? layerWithLine(unit) : { ...layerWithLine(unit), section: { ...sectionLayer().section! } };
    const h = makeHarness([layer]);
    h.ctx.openLayerId = "sec";
    h.ctx.view = { scale: 1, offsetX: 0, offsetY: 100 }; // screen x = s
    return h;
  }

  it("a right click reads GL and the +-1 m slope at the clicked s", () => {
    const { ctx } = openedHarness(1);
    sectionPointerDown(ctx, pointer(1, "mouse", 2, 75, 50, 0));
    sectionPointerUp(ctx, pointer(1, "mouse", 2, 75, 50, 50));
    expect(ctx.groundLevel!.z).toBeCloseTo(35);
    expect(ctx.groundLevel!.slopeDegrees).toBeCloseTo(45);
  });

  it("a one-finger long press does the same", () => {
    const { ctx } = openedHarness(1);
    sectionPointerDown(ctx, pointer(1, "touch", 0, 25, 50, 0));
    sectionPointerUp(ctx, pointer(1, "touch", 0, 25, 50, 700));
    expect(ctx.groundLevel!.z).toBeCloseTo(10);
    expect(ctx.groundLevel!.slopeDegrees).toBeCloseTo(0);
  });

  it("uses a 1 m window in a feet file (1 ft = 0.3048 m)", () => {
    const { ctx } = openedHarness(0.3048);
    showGroundLevelAt(ctx, 50); // exactly at the bend: window 1 / 0.3048 ft on each side
    const half = 1 / 0.3048;
    // z(s - half) = 10, z(s + half) = 10 + half, over 2 * half: slope 0.5
    expect(ctx.groundLevel!.slopePercent).toBeCloseTo(50);
    expect(half).toBeGreaterThan(3);
  });

  it("clears the reading outside the line and when the layer has no line", () => {
    const { ctx } = openedHarness(1);
    ctx.groundLevel = { s: 1, z: 1, slopeDegrees: 0, slopePercent: 0 };
    showGroundLevelAt(ctx, 150);
    expect(ctx.groundLevel).toBeNull();
    const none = openedHarness(1, false);
    none.ctx.groundLevel = { s: 1, z: 1, slopeDegrees: 0, slopePercent: 0 };
    showGroundLevelAt(none.ctx, 20);
    expect(none.ctx.groundLevel).toBeNull();
  });

  it("follows the mouse with cursorS and forgets it on leave and close", () => {
    const { ctx } = openedHarness(1);
    sectionPointerMove(ctx, pointer(1, "mouse", 0, 42, 10, 0));
    expect(ctx.cursorS).toBeCloseTo(42);
    sectionPointerLeave(ctx);
    expect(ctx.cursorS).toBeNull();
    sectionPointerMove(ctx, pointer(1, "mouse", 0, 42, 10, 0));
    closeSectionPanel(ctx);
    expect(ctx.cursorS).toBeNull();
    expect(ctx.groundLevel).toBeNull();
  });
});

describe("tracing the section line (G2-5)", () => {
  const LINE = { points: new Float32Array([0, 10, 50, 10, 100, 60]), groundPoints: 3, cells: 3 };

  /** The open layer "sec" with LINE; the view maps screen (x, y) to s = x and z = 100 - y. */
  function traceHarness(withLine = true) {
    const base = sectionLayer();
    const section = withLine ? { ...base.section!, line: { original: LINE, history: newHistory(LINE) } } : base.section!;
    const h = makeHarness([{ ...base, info: { crs: null }, section } as unknown as ViewerLayer]);
    h.ctx.openLayerId = "sec";
    h.ctx.view = { scale: 1, offsetX: 0, offsetY: 100 };
    // Read the line back through the context (the harness keeps the layers state).
    const line = () => h.ctx.getLayersState().layers[0].section!.line;
    return { ...h, line };
  }
  const pairs = (a: Float32Array) => [...a];

  /** Press at (x0, y0), move to each point, release at the last one. */
  function dragMouse(ctx: SectionViewContext, button: number, points: Array<[number, number]>) {
    sectionPointerDown(ctx, pointer(1, "mouse", button, points[0][0], points[0][1], 0));
    points.slice(1).forEach(([x, y], i) => sectionPointerMove(ctx, pointer(1, "mouse", button, x, y, 10 * (i + 1))));
    const [x, y] = points[points.length - 1];
    sectionPointerUp(ctx, pointer(1, "mouse", button, x, y, 100));
  }

  it("(a) a left drag replaces the covered range and pushes the result on the history", () => {
    const { ctx, line } = traceHarness();
    // z = 100 - y: the trace is s 40..60 at z 30.
    dragMouse(ctx, 0, [[40, 70], [50, 70], [60, 70]]);
    const history = line()!.history;
    expect(history.past).toHaveLength(1);
    expect(history.past[0]).toBe(LINE);
    expect(pairs(history.present.points)).toEqual([0, 10, 40, 30, 50, 30, 60, 30, 100, 60]);
    expect(history.present.edited).toBe(true);
    expect(history.present.groundPoints).toBe(3);
    expect(line()!.original).toBe(LINE); // the original is never changed
  });

  it("(a) shows the path while tracing and clears it on release", () => {
    const { ctx } = traceHarness();
    sectionPointerDown(ctx, pointer(1, "mouse", 0, 40, 70, 0));
    sectionPointerMove(ctx, pointer(1, "mouse", 0, 50, 70, 10));
    sectionPointerMove(ctx, pointer(1, "mouse", 0, 60, 80, 20));
    expect(ctx.trace).toEqual([
      { s: 40, z: 30 },
      { s: 50, z: 30 },
      { s: 60, z: 20 },
    ]);
    sectionPointerUp(ctx, pointer(1, "mouse", 0, 60, 80, 30));
    expect(ctx.trace).toBeNull();
  });

  it("(b) a left click that does not move leaves the history alone", () => {
    const { ctx, line } = traceHarness();
    const before = line()!.history;
    dragMouse(ctx, 0, [[40, 70], [42, 71]]); // 2.2 px: under the drag threshold
    expect(line()!.history).toBe(before);
    expect(ctx.trace).toBeNull();
    dragMouse(ctx, 0, [[40, 70]]);
    expect(line()!.history).toBe(before);
  });

  it("(c) the right button still pans and reads the GL, and does not trace", () => {
    const { ctx, line } = traceHarness();
    const before = line()!.history;
    dragMouse(ctx, 2, [[100, 100], [110, 95], [120, 95]]);
    expect(ctx.view).toEqual({ scale: 1, offsetX: 20, offsetY: 95 });
    expect(ctx.trace).toBeNull();
    expect(line()!.history).toBe(before);
    ctx.view = { scale: 1, offsetX: 0, offsetY: 100 };
    sectionPointerDown(ctx, pointer(2, "mouse", 2, 25, 50, 200));
    sectionPointerUp(ctx, pointer(2, "mouse", 2, 25, 50, 250));
    expect(ctx.groundLevel!.z).toBeCloseTo(10);
    expect(line()!.history).toBe(before);
  });

  it("(d) a one-finger trace is pushed on the history", () => {
    const { ctx, line } = traceHarness();
    sectionPointerDown(ctx, pointer(1, "touch", 0, 40, 70, 0));
    sectionPointerMove(ctx, pointer(1, "touch", 0, 50, 70, 10));
    sectionPointerMove(ctx, pointer(1, "touch", 0, 60, 70, 20));
    expect(ctx.trace).toHaveLength(3);
    sectionPointerUp(ctx, pointer(1, "touch", 0, 60, 70, 30));
    expect(pairs(line()!.history.present.points)).toEqual([0, 10, 40, 30, 50, 30, 60, 30, 100, 60]);
    expect(ctx.trace).toBeNull();
  });

  it("(d) a second finger throws the trace away, and lifting the fingers pushes nothing", () => {
    const { ctx, line } = traceHarness();
    const before = line()!.history;
    sectionPointerDown(ctx, pointer(1, "touch", 0, 40, 70, 0));
    sectionPointerMove(ctx, pointer(1, "touch", 0, 50, 70, 10));
    expect(ctx.trace).not.toBeNull();
    sectionPointerDown(ctx, pointer(2, "touch", 0, 200, 70, 20));
    expect(ctx.trace).toBeNull();
    sectionPointerMove(ctx, pointer(1, "touch", 0, 60, 70, 30)); // pinch / pan now, no new trace
    expect(ctx.trace).toBeNull();
    sectionPointerUp(ctx, pointer(2, "touch", 0, 200, 70, 40));
    sectionPointerMove(ctx, pointer(1, "touch", 0, 70, 70, 50)); // the remaining finger must not start a trace
    expect(ctx.trace).toBeNull();
    sectionPointerUp(ctx, pointer(1, "touch", 0, 70, 70, 60));
    expect(line()!.history).toBe(before);
  });

  it("(d) a cancelled trace is dropped", () => {
    const { ctx, line } = traceHarness();
    const before = line()!.history;
    sectionPointerDown(ctx, pointer(1, "touch", 0, 40, 70, 0));
    sectionPointerMove(ctx, pointer(1, "touch", 0, 60, 70, 10));
    sectionPointerCancel(ctx, pointer(1, "touch", 0, 60, 70, 20));
    expect(ctx.trace).toBeNull();
    expect(line()!.history).toBe(before);
  });

  it("(e) undo, redo and back to the computed line (which can itself be undone)", () => {
    const { ctx, line } = traceHarness();
    dragMouse(ctx, 0, [[40, 70], [60, 70]]);
    const edited = line()!.history.present;
    dragMouse(ctx, 0, [[10, 90], [20, 90]]);
    const edited2 = line()!.history.present;
    expect(line()!.history.past).toHaveLength(2);

    undoSectionLine(ctx);
    expect(line()!.history.present).toBe(edited);
    expect(canRedo(line()!.history)).toBe(true);
    redoSectionLine(ctx);
    expect(line()!.history.present).toBe(edited2);

    resetSectionLineToComputed(ctx);
    expect(line()!.history.present).toBe(LINE);
    expect(canUndo(line()!.history)).toBe(true);
    undoSectionLine(ctx);
    expect(line()!.history.present).toBe(edited2);

    // Nothing to redo any more after a new edit; undo past the start does nothing.
    undoSectionLine(ctx);
    undoSectionLine(ctx);
    undoSectionLine(ctx);
    expect(line()!.history.present).toBe(LINE);
    const start = line()!.history;
    undoSectionLine(ctx);
    expect(line()!.history).toBe(start);
  });

  it("(e) back to the computed line does nothing when the line is not edited", () => {
    const { ctx, line } = traceHarness();
    const before = line()!.history;
    resetSectionLineToComputed(ctx);
    expect(line()!.history).toBe(before);
  });

  it("(f) without a line, tracing and the buttons do nothing", () => {
    const { ctx, line } = traceHarness(false);
    dragMouse(ctx, 0, [[40, 70], [60, 70]]);
    expect(ctx.trace).toBeNull();
    undoSectionLine(ctx);
    redoSectionLine(ctx);
    resetSectionLineToComputed(ctx);
    expect(line()).toBeUndefined();
    // With no panel open at all too.
    const closed = traceHarness();
    closed.ctx.openLayerId = null;
    const before = closed.line()!.history;
    dragMouse(closed.ctx, 0, [[40, 70], [60, 70]]);
    undoSectionLine(closed.ctx);
    expect(closed.line()!.history).toBe(before);
  });
});
