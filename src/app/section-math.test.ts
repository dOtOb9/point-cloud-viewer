import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  LONG_PRESS_MS,
  MAX_SCALE,
  TOUCH_LONG_PRESS_MS,
  canRedo,
  canUndo,
  classifyOneFinger,
  classifyRightPress,
  fitView,
  interpolateZ,
  nearestOnLine,
  newHistory,
  panBy,
  pushEdit,
  redo,
  replaceRange,
  screenToSection,
  sectionToScreen,
  slopeAt,
  traceToFunction,
  twoFingerStep,
  undo,
  zoomAt,
  type ProfileLine,
  type ProfilePoint,
  type SectionView,
} from "./section-math";

const view: SectionView = { scale: 4, offsetX: 30, offsetY: 200 };
const p = (s: number, z: number): ProfilePoint => ({ s, z });

describe("view", () => {
  it("round-trips screen and section", () => {
    const sc = sectionToScreen(view, 12.5, 7);
    const back = screenToSection(view, sc.x, sc.y);
    expect(back.s).toBeCloseTo(12.5, 9);
    expect(back.z).toBeCloseTo(7, 9);
  });

  it("puts higher z higher on the screen (smaller y)", () => {
    expect(sectionToScreen(view, 0, 10).y).toBeLessThan(sectionToScreen(view, 0, 0).y);
  });

  it("zoomAt keeps the point under the cursor fixed", () => {
    const cursor = { x: 123, y: 77 };
    const before = screenToSection(view, cursor.x, cursor.y);
    for (const factor of [2, 0.25, 1.1]) {
      const zoomed = zoomAt(view, cursor, factor);
      const after = screenToSection(zoomed, cursor.x, cursor.y);
      expect(after.s).toBeCloseTo(before.s, 9);
      expect(after.z).toBeCloseTo(before.z, 9);
      expect(zoomed.scale).toBeCloseTo(view.scale * factor, 9);
    }
  });

  it("zoomAt clamps the scale and still keeps the point fixed", () => {
    const cursor = { x: 50, y: 60 };
    const before = screenToSection(view, cursor.x, cursor.y);
    const zoomed = zoomAt(view, cursor, 1e12);
    expect(zoomed.scale).toBe(MAX_SCALE);
    const after = screenToSection(zoomed, cursor.x, cursor.y);
    expect(after.s).toBeCloseTo(before.s, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
  });

  it("panBy moves the content by the given pixels", () => {
    const panned = panBy(view, 10, -5);
    const a = sectionToScreen(view, 3, 4);
    const b = sectionToScreen(panned, 3, 4);
    expect(b.x - a.x).toBe(10);
    expect(b.y - a.y).toBe(-5);
    expect(panned.scale).toBe(view.scale);
  });

  it("fitView contains both ranges inside the padding and centres them", () => {
    const panel = { width: 400, height: 200 };
    const v = fitView(panel, { min: 100, max: 300 }, { min: 10, max: 30 }, 20);
    const corners = [sectionToScreen(v, 100, 10), sectionToScreen(v, 300, 30)];
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(c.x).toBeLessThanOrEqual(380 + 1e-9);
      expect(c.y).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(c.y).toBeLessThanOrEqual(180 + 1e-9);
    }
    // s is the long side here: 360 px / 200 units
    expect(v.scale).toBeCloseTo(1.8, 9);
    expect((corners[0].x + corners[1].x) / 2).toBeCloseTo(200, 9);
    expect((corners[0].y + corners[1].y) / 2).toBeCloseTo(100, 9);
  });

  it("fitView limits by height when the section is tall", () => {
    const v = fitView({ width: 400, height: 200 }, { min: 0, max: 10 }, { min: 0, max: 100 }, 0);
    expect(v.scale).toBeCloseTo(2, 9);
  });

  it("fitView stays finite for a flat or single-point range", () => {
    const v = fitView({ width: 400, height: 200 }, { min: 5, max: 5 }, { min: 1, max: 1 }, 10);
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(v.scale).toBeLessThanOrEqual(MAX_SCALE);
  });
});

describe("interpolation and slope", () => {
  const line: ProfileLine = [p(0, 0), p(10, 5), p(20, 5), p(20.001, 15)];

  it("interpolates inside, on vertices, and returns null outside", () => {
    expect(interpolateZ(line, 5)).toBeCloseTo(2.5, 9);
    expect(interpolateZ(line, 10)).toBe(5);
    expect(interpolateZ(line, 15)).toBe(5);
    expect(interpolateZ(line, 0)).toBe(0);
    expect(interpolateZ(line, 20.001)).toBe(15);
    expect(interpolateZ(line, -0.1)).toBeNull();
    expect(interpolateZ(line, 21)).toBeNull();
    expect(interpolateZ([p(1, 1)], 1)).toBeNull();
    expect(interpolateZ([], 0)).toBeNull();
  });

  it("slope of a 45 degree segment is 45 degrees and 100 percent", () => {
    const s = slopeAt([p(0, 0), p(10, 10)], 3);
    expect(s?.degrees).toBeCloseTo(45, 9);
    expect(s?.percent).toBeCloseTo(100, 9);
  });

  it("slope of a falling segment is negative", () => {
    const s = slopeAt([p(0, 10), p(20, 0)], 5);
    expect(s?.percent).toBeCloseTo(-50, 9);
    expect(s?.degrees).toBeCloseTo(-26.565051, 5);
  });

  it("slope of a flat segment is 0", () => {
    const s = slopeAt(line, 15);
    expect(s?.degrees).toBe(0);
    expect(s?.percent).toBe(0);
  });

  it("slope of a near-vertical segment is close to 90 degrees", () => {
    const s = slopeAt(line, 20.0005);
    expect(s?.degrees).toBeGreaterThan(89.9);
    expect(s?.percent).toBeCloseTo(1_000_000, -2); // 10 / 0.001 * 100
  });

  it("on a vertex the slope is the segment to the right; on the last vertex the last segment", () => {
    expect(slopeAt(line, 10)?.percent).toBe(0); // segment 10..20 is flat, the left one rises
    expect(slopeAt(line, 0)?.percent).toBeCloseTo(50, 9);
    expect(slopeAt(line, 20.001)?.degrees).toBeGreaterThan(89.9);
  });

  it("slope is null outside the line or for fewer than 2 points", () => {
    expect(slopeAt(line, -1)).toBeNull();
    expect(slopeAt(line, 100)).toBeNull();
    expect(slopeAt([p(0, 0)], 0)).toBeNull();
  });

  it("nearestOnLine clamps s into the line and returns the height there", () => {
    expect(nearestOnLine(line, 5)).toEqual({ s: 5, z: 2.5 });
    expect(nearestOnLine(line, -50)).toEqual({ s: 0, z: 0 });
    expect(nearestOnLine(line, 99)).toEqual({ s: 20.001, z: 15 });
    expect(nearestOnLine([], 1)).toBeNull();
  });
});

describe("trace editing", () => {
  const line: ProfileLine = [p(0, 0), p(10, 0), p(20, 0), p(30, 0)];

  function isStrictlyIncreasing(l: ProfileLine): boolean {
    return l.every((pt, i) => i === 0 || pt.s > l[i - 1].s);
  }

  it("a forward trace replaces the covered points, ends included", () => {
    const out = replaceRange(line, [p(8, 1), p(10, 2), p(18, 3), p(20, 4)]);
    expect(out).toEqual([p(0, 0), p(8, 1), p(10, 2), p(18, 3), p(20, 4), p(30, 0)]);
    expect(isStrictlyIncreasing(out)).toBe(true);
  });

  it("a backward trace gives the same result as the forward one", () => {
    const forward = replaceRange(line, [p(8, 1), p(10, 2), p(18, 3), p(20, 4)]);
    const backward = replaceRange(line, [p(20, 4), p(18, 3), p(10, 2), p(8, 1)]);
    expect(backward).toEqual(forward);
  });

  it("removes line points strictly inside the range", () => {
    const out = replaceRange(line, [p(5, 9), p(25, 9)]);
    expect(out).toEqual([p(0, 0), p(5, 9), p(25, 9), p(30, 0)]);
  });

  it("back-and-forth: same s keeps the last drawn value, the rest are sorted", () => {
    const trace = [p(10, 1), p(14, 2), p(12, 3), p(14, 5), p(11, 4)];
    expect(traceToFunction(trace)).toEqual([p(10, 1), p(11, 4), p(12, 3), p(14, 5)]);
    const out = replaceRange(line, trace);
    expect(out).toEqual([p(0, 0), p(10, 1), p(11, 4), p(12, 3), p(14, 5), p(20, 0), p(30, 0)]);
    expect(isStrictlyIncreasing(out)).toBe(true);
  });

  it("a trace beyond the line ends extends the line", () => {
    expect(replaceRange(line, [p(-5, 1), p(35, 2)])).toEqual([p(-5, 1), p(35, 2)]);
    expect(replaceRange(line, [p(25, 7), p(40, 8)])).toEqual([p(0, 0), p(10, 0), p(20, 0), p(25, 7), p(40, 8)]);
  });

  it("a trace inside one segment only adds points", () => {
    const out = replaceRange(line, [p(12, 1), p(15, 2), p(17, 1)]);
    expect(out).toEqual([p(0, 0), p(10, 0), p(12, 1), p(15, 2), p(17, 1), p(20, 0), p(30, 0)]);
  });

  it("a single-point trace replaces a vertex at the same s", () => {
    expect(replaceRange(line, [p(10, 5)])).toEqual([p(0, 0), p(10, 5), p(20, 0), p(30, 0)]);
  });

  it("an empty trace or non-finite points change nothing", () => {
    expect(replaceRange(line, [])).toBe(line);
    expect(replaceRange(line, [p(NaN, 1), p(3, Infinity)])).toBe(line);
  });

  it("does not modify its arguments", () => {
    const trace = [p(15, 1), p(12, 2)];
    const copyLine = [...line];
    const copyTrace = [...trace];
    replaceRange(line, trace);
    expect(line).toEqual(copyLine);
    expect(trace).toEqual(copyTrace);
  });

  it("works on an empty line", () => {
    expect(replaceRange([], [p(2, 1), p(1, 1)])).toEqual([p(1, 1), p(2, 1)]);
  });
});

describe("history", () => {
  it("starts with nothing to undo or redo", () => {
    const h = newHistory("a");
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("undo and redo walk through the edits", () => {
    let h = newHistory("a");
    h = pushEdit(h, "b");
    h = pushEdit(h, "c");
    expect(h.present).toBe("c");
    h = undo(h);
    expect(h.present).toBe("b");
    expect(canRedo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe("a");
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe("c");
    expect(canRedo(h)).toBe(false);
    expect(h.past).toEqual(["a", "b"]);
  });

  it("a new edit clears redo", () => {
    let h = pushEdit(pushEdit(newHistory("a"), "b"), "c");
    h = undo(h);
    h = pushEdit(h, "d");
    expect(h.present).toBe("d");
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe("b");
  });

  it("does not modify the old history object", () => {
    const h = pushEdit(newHistory("a"), "b");
    undo(h);
    expect(h).toEqual({ past: ["a"], present: "b", future: [] });
  });
});

describe("gestures", () => {
  it("right button: short and still is a click", () => {
    expect(classifyRightPress({ durationMs: 100, movedPx: 0 })).toBe("click");
    expect(classifyRightPress({ durationMs: LONG_PRESS_MS - 1, movedPx: DRAG_THRESHOLD_PX })).toBe("click");
  });

  it("right button: moving is a pan at once", () => {
    expect(classifyRightPress({ durationMs: 20, movedPx: DRAG_THRESHOLD_PX + 0.1 })).toBe("pan");
  });

  it("right button: a long press is a pan", () => {
    expect(classifyRightPress({ durationMs: LONG_PRESS_MS, movedPx: 0 })).toBe("pan");
  });

  it("one finger: pending, then long press if still, trace if moved", () => {
    expect(classifyOneFinger({ durationMs: 100, movedPx: 1 })).toBe("pending");
    expect(classifyOneFinger({ durationMs: TOUCH_LONG_PRESS_MS, movedPx: 1 })).toBe("longpress");
    expect(classifyOneFinger({ durationMs: 50, movedPx: DRAG_THRESHOLD_PX + 1 })).toBe("trace");
    expect(classifyOneFinger({ durationMs: 2000, movedPx: DRAG_THRESHOLD_PX + 1 })).toBe("trace");
  });

  it("two fingers: midpoint movement and distance ratio", () => {
    const step = twoFingerStep(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [{ x: 10, y: 20 }, { x: 210, y: 20 }],
    );
    expect(step.zoomFactor).toBeCloseTo(2, 9);
    expect(step.center).toEqual({ x: 110, y: 20 });
    expect(step.dx).toBe(60);
    expect(step.dy).toBe(20);
  });

  it("two fingers: zero previous distance gives factor 1", () => {
    const step = twoFingerStep(
      [{ x: 5, y: 5 }, { x: 5, y: 5 }],
      [{ x: 5, y: 5 }, { x: 9, y: 5 }],
    );
    expect(step.zoomFactor).toBe(1);
  });
});
