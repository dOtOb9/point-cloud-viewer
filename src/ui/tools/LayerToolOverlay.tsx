import { useEffect, useState, type RefObject } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { MIN_POLYGON_VERTICES, type LayerToolState } from "../../state/useLayerTool";
import { projectPoint } from "../../renderer/screen-project";
import { glassSurfaceClass } from "../common/glass";

// L2-F: what is drawn over the 3D view while "カット" or "断面" is on, plus the guide at the bottom.
//  - Polygon: the vertices are stored in canvas pixels, so they are drawn as they are (the polygon is
//    thrown away when the camera moves, see useLayerTool.ts).
//  - Section: the two picked points are 3D, so they are projected again every frame with the renderer's
//    latest viewProj (same approach as MeasureOverlay.tsx). Frames are polled only while a point exists.

const STROKE = "#38bdf8";

interface Frame {
  viewProj: number[];
  width: number;
  height: number;
}

export function LayerToolOverlay({
  viewer,
  tool,
  canvasRef,
  glassEnabled,
}: {
  viewer: CopcViewerState;
  tool: LayerToolState;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Same device-profile flag as the toolbar: false falls back to an opaque tint. */
  glassEnabled: boolean;
}) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const getViewSnapshot = viewer.getViewSnapshot;
  const needsFrame = tool.mode === "section" && tool.sectionPoints.length > 0;

  useEffect(() => {
    if (!needsFrame) return;
    let raf = 0;
    const tick = () => {
      const snapshot = getViewSnapshot();
      const el = canvasRef.current;
      if (snapshot && el) {
        setFrame((prev) => {
          const same = prev && prev.width === el.clientWidth && prev.height === el.clientHeight && prev.viewProj.every((v, i) => v === snapshot.viewProj[i]);
          return same ? prev : { viewProj: snapshot.viewProj, width: el.clientWidth, height: el.clientHeight };
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [needsFrame, getViewSnapshot, canvasRef]);

  if (tool.mode === null) return null;

  const polygonPoints = tool.polygon.map((p) => `${p.x},${p.y}`).join(" ");
  const sectionScreen =
    tool.mode === "section" && frame ? tool.sectionPoints.map((p) => projectPoint(frame.viewProj, p, frame.width, frame.height)) : [];

  return (
    <>
      <svg data-testid="layer-tool-overlay" className="pointer-events-none absolute inset-0 z-10 h-full w-full">
        {tool.mode === "select" && tool.polygon.length > 0 && (
          <g>
            <polygon points={polygonPoints} fill={STROKE} fillOpacity={0.15} stroke={STROKE} strokeWidth={2} strokeLinejoin="round" />
            {tool.polygon.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={4} fill={STROKE} stroke="#000" strokeWidth={1.5} />
            ))}
          </g>
        )}
        {tool.mode === "section" && (
          <g>
            {sectionScreen[0] && sectionScreen[1] && (
              <line x1={sectionScreen[0].x} y1={sectionScreen[0].y} x2={sectionScreen[1].x} y2={sectionScreen[1].y} stroke={STROKE} strokeWidth={3} strokeLinecap="round" />
            )}
            {sectionScreen.map((s, i) => (s ? <circle key={i} cx={s.x} cy={s.y} r={5} fill={STROKE} stroke="#000" strokeWidth={1.5} /> : null))}
          </g>
        )}
      </svg>
      <LayerToolHud tool={tool} glassEnabled={glassEnabled} />
    </>
  );
}

function LayerToolHud({ tool, glassEnabled }: { tool: LayerToolState; glassEnabled: boolean }) {
  const name = tool.mode === "select" ? "カット" : "断面";
  let guide: string;
  if (tool.mode === "select") {
    const n = tool.polygon.length;
    guide =
      n < MIN_POLYGON_VERTICES
        ? `頂点をクリック（${n}点。ドラッグでカメラを動かすと描き直し）`
        : `頂点をクリック（${n}点）。ダブルクリックか Enter で閉じる`;
  } else {
    guide = tool.sectionPoints.length === 0 ? "線の1点目をクリック" : "線の2点目をクリック";
  }
  return (
    <div
      data-testid="layer-tool-hud"
      className={`pointer-events-auto absolute bottom-14 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl ${glassSurfaceClass(glassEnabled)} px-3 py-2 text-sm shadow-xl`}
    >
      <span className="font-semibold">{name}</span>
      <span>{tool.notice ?? guide}</span>
      {tool.mode === "select" && (
        <button
          type="button"
          onClick={tool.finishPolygon}
          disabled={tool.polygon.length < MIN_POLYGON_VERTICES}
          className="min-h-9 rounded-md bg-primary px-3 text-on-primary disabled:opacity-40"
        >
          閉じる
        </button>
      )}
      <button
        type="button"
        onClick={tool.stop}
        title="Esc でもやめられます"
        className="min-h-9 rounded-md border border-current/30 px-3 hover:bg-black/5 dark:hover:bg-white/10"
      >
        やめる
      </button>
    </div>
  );
}
