import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isFormControl } from "../app/typing-target";
import type { CopcViewerState } from "./useCopcViewer";
import { autoFinishCount, MIN_POINTS, type MeasureKind, type Vec3 } from "./measure";

const CLICK_MOVE_TOLERANCE_PX = 5;
const NOTICE_MS = 2500;

export interface MeasureToolState {
  mode: MeasureKind | null;
  points: readonly Vec3[];
  notice: string | null;
  stop: () => void;
  toggle: (kind: MeasureKind) => void;
  finish: () => void;
}

export function useMeasureTool(
  viewer: CopcViewerState,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): MeasureToolState {
  const [mode, setMode] = useState<MeasureKind | null>(null);
  const [points, setPoints] = useState<readonly Vec3[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const modeRef = useRef<MeasureKind | null>(null);
  const pointsRef = useRef<readonly Vec3[]>([]);
  const viewerRef = useRef(viewer);
  const noticeTimerRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
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

  const stop = useCallback(() => reset(null), [reset]);
  const toggle = useCallback((kind: MeasureKind) => reset(modeRef.current === kind ? null : kind), [reset]);

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

  const addPointAt = useCallback(
    (cssX: number, cssY: number) => {
      const generation = generationRef.current;
      queueRef.current = queueRef.current.then(async () => {
        if (generation !== generationRef.current || modeRef.current === null) return;
        const picked = await viewerRef.current.pickPoint(cssX, cssY);
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode === null || !canvas) return;

    let down: { x: number; y: number; id: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
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
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_MOVE_TOLERANCE_PX) return;
      if (e.detail >= 2) return;
      const rect = canvas.getBoundingClientRect();
      addPointAt(e.clientX - rect.left, e.clientY - rect.top);
    };
    const onDoubleClick = (e: MouseEvent) => {
      e.stopImmediatePropagation();
      finish();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFormControl(e.target)) return;
      if (e.key === "Escape") {
        reset(null);
      } else if (e.key === "Enter") {
        finish();
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("click", onClick);
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

  return { mode, points, notice, stop, toggle, finish };
}
