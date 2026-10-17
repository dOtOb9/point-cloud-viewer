import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CopcViewerState } from "./useCopcViewer";
import { isMeasureLayer } from "./layers";
import { pixelToNdc, sectionBox, type Vec3 } from "./tool-math";

// L2-F: operation of the two tools that draw on the 3D view: "点の選択" (polygon on the screen) and
// "断面" (a line between two picked 3D points). The result is made by `viewer.extractFromLayer`
// (a new layer; the source layer is never changed, ADR-0018).
//
// Click handling is the same as useMeasureTool.ts (L2-D): a click counts only if the pointer moved
// 5 px or less since pointerdown, so dragging still moves the camera, and the second click of a
// double click is ignored. It is written again here instead of shared so that the finished
// measurement tool is not touched; the two could be merged later.
//
// Polygon and camera: the polygon is stored in screen pixels, and it is sent to Rust together with the
// viewProj of the moment it was started. If the camera moves while it is being drawn, the vertices no
// longer sit on the same points of the cloud, so the polygon is thrown away ("視点を動かしたので描き直し").
// The owner can still rotate the camera between tools; only an unfinished polygon is lost.

const CLICK_MOVE_TOLERANCE_PX = 5;
const NOTICE_MS = 3000;
/** A polygon needs at least this many vertices. */
export const MIN_POLYGON_VERTICES = 3;

export type LayerToolMode = "select" | "section";

export interface PixelPoint {
  x: number;
  y: number;
}

export interface LayerToolState {
  mode: LayerToolMode | null;
  /** "select": vertices entered so far (canvas CSS pixels). */
  polygon: readonly PixelPoint[];
  /** "section": the 3D points picked so far (0 to 2). */
  sectionPoints: readonly Vec3[];
  /** "section": both points are picked and the dialog for thickness and height range should be shown. */
  sectionReady: boolean;
  notice: string | null;
  stop: () => void;
  toggle: (mode: LayerToolMode) => void;
  /** "select": close the polygon and extract (same as Enter or double click). */
  finishPolygon: () => void;
  /** "section": run the extraction with the values from the dialog (thickness and height range in file units). */
  confirmSection: (thickness: number, heightMin: number, heightMax: number) => void;
  /** "section": close the dialog and forget the two points (the tool stays on). */
  cancelSection: () => void;
}

function sameMatrix(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function useLayerTool(viewer: CopcViewerState, canvasRef: RefObject<HTMLCanvasElement | null>): LayerToolState {
  const [mode, setMode] = useState<LayerToolMode | null>(null);
  const [polygon, setPolygon] = useState<readonly PixelPoint[]>([]);
  const [sectionPoints, setSectionPoints] = useState<readonly Vec3[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const modeRef = useRef<LayerToolMode | null>(null);
  const polygonRef = useRef<readonly PixelPoint[]>([]);
  const sectionRef = useRef<readonly Vec3[]>([]);
  /** viewProj when the first polygon vertex was entered. */
  const anchorRef = useRef<number[] | null>(null);
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

  const setPolygonBoth = useCallback((next: readonly PixelPoint[]) => {
    polygonRef.current = next;
    if (next.length === 0) anchorRef.current = null;
    setPolygon(next);
  }, []);
  const setSectionBoth = useCallback((next: readonly Vec3[]) => {
    sectionRef.current = next;
    setSectionPoints(next);
  }, []);

  const reset = useCallback(
    (next: LayerToolMode | null) => {
      generationRef.current += 1;
      modeRef.current = next;
      setMode(next);
      setPolygonBoth([]);
      setSectionBoth([]);
    },
    [setPolygonBoth, setSectionBoth],
  );
  const stop = useCallback(() => reset(null), [reset]);
  const toggle = useCallback((m: LayerToolMode) => reset(modeRef.current === m ? null : m), [reset]);

  /** The point-cloud layer the tool acts on: the selected one, which must be a point cloud with a path. */
  const targetLayer = useCallback(() => {
    const layer = viewerRef.current.selectedLayer;
    if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
      showNotice("点群のレイヤーを選んでから操作してください");
      return null;
    }
    return layer;
  }, [showNotice]);

  const finishPolygon = useCallback(() => {
    if (modeRef.current !== "select") return;
    const points = polygonRef.current;
    if (points.length < MIN_POLYGON_VERTICES) {
      showNotice(`多角形は${MIN_POLYGON_VERTICES}点以上クリックしてから閉じてください`);
      return;
    }
    const canvas = canvasRef.current;
    const anchor = anchorRef.current;
    if (!canvas || !anchor) return;
    const snapshot = viewerRef.current.getViewSnapshot();
    if (!snapshot || !sameMatrix(snapshot.viewProj, anchor)) {
      setPolygonBoth([]);
      showNotice("視点が動いたので、多角形を描き直してください");
      return;
    }
    const layer = targetLayer();
    if (!layer) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const polygonNdc = points.map((p) => pixelToNdc(p.x, p.y, width, height));
    // Done drawing: leave the tool first (the extraction can take a long time), then start it.
    reset(null);
    void viewerRef.current.extractFromLayer(layer.id, { kind: "screenPolygon", viewProj: [...anchor], polygonNdc }, "選択");
  }, [canvasRef, reset, setPolygonBoth, showNotice, targetLayer]);

  const addPolygonVertex = useCallback(
    (x: number, y: number) => {
      const snapshot = viewerRef.current.getViewSnapshot();
      if (!snapshot) return;
      if (anchorRef.current !== null && !sameMatrix(snapshot.viewProj, anchorRef.current)) {
        // The camera moved since the first vertex: start again from this click.
        setPolygonBoth([]);
        showNotice("視点を動かしたので、多角形を描き直します");
      }
      if (polygonRef.current.length === 0) anchorRef.current = [...snapshot.viewProj];
      setPolygonBoth([...polygonRef.current, { x, y }]);
    },
    [setPolygonBoth, showNotice],
  );

  const addSectionPoint = useCallback(
    (cssX: number, cssY: number) => {
      const generation = generationRef.current;
      queueRef.current = queueRef.current.then(async () => {
        if (generation !== generationRef.current || modeRef.current !== "section") return;
        if (sectionRef.current.length >= 2) return;
        const picked = await viewerRef.current.pickPoint(cssX, cssY);
        if (generation !== generationRef.current || modeRef.current !== "section") return;
        if (!picked) {
          showNotice("点がありません");
          return;
        }
        setSectionBoth([...sectionRef.current, picked.point as Vec3]);
      });
    },
    [setSectionBoth, showNotice],
  );

  const confirmSection = useCallback(
    (thickness: number, heightMin: number, heightMax: number) => {
      const points = sectionRef.current;
      if (modeRef.current !== "section" || points.length < 2) return;
      const layer = targetLayer();
      if (!layer) return;
      const up = viewerRef.current.getViewSnapshot()?.up ?? [0, 0, 1];
      const box = sectionBox(points[0], points[1], up, thickness, heightMin, heightMax);
      if (!box) {
        showNotice("2点が同じ鉛直線上にあるので、断面の向きを決められません");
        setSectionBoth([]);
        return;
      }
      reset(null);
      void viewerRef.current.extractFromLayer(layer.id, box.filter, "断面", box.normal);
    },
    [reset, setSectionBoth, showNotice, targetLayer],
  );
  const cancelSection = useCallback(() => setSectionBoth([]), [setSectionBoth]);

  // Listen to the canvas and the keyboard only while a tool is on.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode === null || !canvas) return;

    let down: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      down = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
    };
    const onClick = (e: MouseEvent) => {
      const start = down;
      down = null;
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_MOVE_TOLERANCE_PX) return; // a drag: the camera
      if (e.detail >= 2) return; // the second click of a double click
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (modeRef.current === "select") addPolygonVertex(x, y);
      else addSectionPoint(x, y);
    };
    const onDoubleClick = (e: MouseEvent) => {
      // Do not also fly the camera to the clicked point.
      e.stopImmediatePropagation();
      if (modeRef.current === "select") finishPolygon();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "Escape") reset(null);
      else if (e.key === "Enter") finishPolygon();
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
  }, [mode, canvasRef, addPolygonVertex, addSectionPoint, finishPolygon, reset]);

  // While a polygon is being drawn, throw it away as soon as the camera moves.
  const drawing = mode === "select" && polygon.length > 0;
  useEffect(() => {
    if (!drawing) return;
    let raf = 0;
    const tick = () => {
      const snapshot = viewerRef.current.getViewSnapshot();
      const anchor = anchorRef.current;
      if (snapshot && anchor && !sameMatrix(snapshot.viewProj, anchor)) {
        setPolygonBoth([]);
        showNotice("視点を動かしたので、多角形を描き直してください");
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drawing, setPolygonBoth, showNotice]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  return {
    mode,
    polygon,
    sectionPoints,
    sectionReady: mode === "section" && sectionPoints.length >= 2,
    notice,
    stop,
    toggle,
    finishPolygon,
    confirmSection,
    cancelSection,
  };
}
