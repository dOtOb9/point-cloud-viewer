import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CopcViewerState } from "./useCopcViewer";
import { autoFinishCount, MIN_POINTS, type MeasureKind, type Vec3 } from "./measure";

// L2-D: operation of the measurement tool. Holds "what is being measured (kind)" and the
// points entered so far, adds a point on each click in the 3D view (canvas), and when
// enough points exist turns them into a new measurement layer via `viewer.addMeasurement`.
//
// How clicks are told apart from camera drags:
//  - Remember the canvas pointerdown position; only treat it as a click when the movement
//    until `click` is small. Drags (rotate, pan) are still handled by orbit-camera.ts.
//  - Canvas events are not stopped (we listen alongside orbit-camera.ts). The only event
//    stopped is `dblclick`: the double click that closes an area must not also trigger the
//    camera fly-to (stopped in the capture phase).
//  - A double click delivers two clicks. The second one (detail >= 2) is ignored and the
//    area is closed by dblclick.
//
// Picking a point is asynchronous (read back from the GPU). Work is chained on a single
// Promise so quick successive clicks are processed in order.

/** Moving more than this (CSS px) means a drag, not a click. */
const CLICK_MOVE_TOLERANCE_PX = 5;
/** How long a short notice such as "no point here" stays visible (ms). */
const NOTICE_MS = 2500;

export interface MeasureToolState {
  /** Kind being measured. null means not measuring (normal camera operation only). */
  mode: MeasureKind | null;
  /** Points entered so far (world coordinates). */
  points: readonly Vec3[];
  /** Short notice to show on screen (e.g. "点がありません"), or null. */
  notice: string | null;
  /** Start measuring. If another kind is active, its points are discarded and it switches. */
  start: (kind: MeasureKind) => void;
  /** Stop (also discards points entered so far). */
  stop: () => void;
  /** Stop if it is the same kind, otherwise start (for the toolbar buttons). */
  toggle: (kind: MeasureKind) => void;
  /** Close and finish an area (same as Enter or double click). */
  finish: () => void;
}

export function useMeasureTool(
  viewer: CopcViewerState,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): MeasureToolState {
  const [mode, setMode] = useState<MeasureKind | null>(null);
  const [points, setPoints] = useState<readonly Vec3[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Refs so event handlers (which stay attached to the canvas) read the latest values.
  const modeRef = useRef<MeasureKind | null>(null);
  const pointsRef = useRef<readonly Vec3[]>([]);
  const viewerRef = useRef(viewer);
  const noticeTimerRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  // Incremented when measuring stops or switches. Discards results of picks started before that.
  const generationRef = useRef(0);

  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  const showNotice = useCallback((text: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const setPointsBoth = useCallback((next: readonly Vec3[]) => {
    pointsRef.current = next;
    setPoints(next);
  }, []);

  const reset = useCallback(
    (nextMode: MeasureKind | null) => {
      generationRef.current += 1;
      modeRef.current = nextMode;
      setMode(nextMode);
      setPointsBoth([]);
    },
    [setPointsBoth],
  );

  const start = useCallback((kind: MeasureKind) => reset(kind), [reset]);
  const stop = useCallback(() => reset(null), [reset]);
  const toggle = useCallback((kind: MeasureKind) => reset(modeRef.current === kind ? null : kind), [reset]);

  /** Finish the measurement with the current points and make a new layer. */
  const commit = useCallback(
    (kind: MeasureKind, pts: readonly Vec3[]) => {
      const up = viewerRef.current.getViewSnapshot()?.up ?? [0, 0, 1];
      const len = Math.hypot(up[0], up[1], up[2]) || 1;
      viewerRef.current.addMeasurement({
        kind,
        points: pts.map((p) => [p[0], p[1], p[2]] as const),
        up: [up[0] / len, up[1] / len, up[2] / len],
      });
      setPointsBoth([]);
    },
    [setPointsBoth],
  );

  const finish = useCallback(() => {
    // Wait for queued picks (the preceding click) to finish before closing.
    const generation = generationRef.current;
    queueRef.current = queueRef.current.then(() => {
      const kind = modeRef.current;
      if (kind !== "area" || generation !== generationRef.current) return;
      if (pointsRef.current.length < MIN_POINTS.area) {
        showNotice("面積は3点以上クリックしてから閉じてください");
        return;
      }
      commit(kind, pointsRef.current);
    });
  }, [commit, showNotice]);

  /** Pick the point at the click position and add it to the points entered so far. */
  const addPointAt = useCallback(
    (cssX: number, cssY: number) => {
      const generation = generationRef.current;
      queueRef.current = queueRef.current.then(async () => {
        if (generation !== generationRef.current || modeRef.current === null) return;
        const picked = await viewerRef.current.pickPoint(cssX, cssY);
        // Discard if measuring was stopped or switched during the pick.
        if (generation !== generationRef.current || modeRef.current === null) return;
        if (!picked) {
          showNotice("点がありません");
          return;
        }
        const kind = modeRef.current;
        const next = [...pointsRef.current, picked.point as Vec3];
        if (next.length === autoFinishCount(kind)) {
          commit(kind, next);
        } else {
          setPointsBoth(next);
        }
      });
    },
    [commit, setPointsBoth, showNotice],
  );

  // Only while measuring, listen to canvas click / double click and the keyboard (Esc, Enter).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode === null || !canvas) return;

    let down: { x: number; y: number; id: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      // Left button only (including touch/pen contact). Ignore a second finger (pinch).
      if (e.button !== 0 || !e.isPrimary) {
        down = null;
        return;
      }
      down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    };
    const onClick = (e: MouseEvent) => {
      const start = down;
      down = null;
      if (!start) return;
      // Released after moving = a drag. Leave it to the camera.
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_MOVE_TOLERANCE_PX) return;
      // Ignore the second click of a double click (closing is done by dblclick).
      if (e.detail >= 2) return;
      const rect = canvas.getBoundingClientRect();
      addPointAt(e.clientX - rect.left, e.clientY - rect.top);
    };
    const onDoubleClick = (e: MouseEvent) => {
      // Do not trigger the camera fly-to (double click to approach).
      e.stopImmediatePropagation();
      finish();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "Escape") {
        reset(null);
      } else if (e.key === "Enter") {
        finish();
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("click", onClick);
    // capture: receive it before the dblclick of orbit-camera.ts and stop it.
    canvas.addEventListener("dblclick", onDoubleClick, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDoubleClick, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mode, canvasRef, addPointAt, finish, reset]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  return { mode, points, notice, start, stop, toggle, finish };
}
