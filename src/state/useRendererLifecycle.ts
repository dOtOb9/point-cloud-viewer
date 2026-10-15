// Lifecycle of the renderer and the data source: create them when the canvas is mounted, wire the
// renderer's callbacks (stats, GPU errors, node read errors), follow window resize, and dispose on unmount.
// Fills `rendererRef` (PointCloudRenderer) and `sourceRef` (TauriSource on desktop/Android, WebSource in the browser;
// the only place that chooses between them, see ADR-0012). The refs are created by useCopcViewer.ts, because
// useDisplaySettings.ts needs `rendererRef` while this hook needs its `onStats` callback.
// Used by: useCopcViewer.ts. Every other hook only reads the two refs.
// Entry: `useRendererLifecycle(refs, callbacks)`. The effect runs once; its callbacks must be stable.
import { useEffect, type RefObject } from "react";
import { TauriSource, reportToBackendConsole } from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import { isTauriEnvironment } from "../datasource/environment";
import type { DataSource } from "../datasource/DataSource";
import { PointCloudRenderer, type RenderStats } from "../renderer/point-cloud-renderer";
import { readStoredAnimationEnabled } from "./motion-setting";
import { getLocalStorage } from "./useDisplaySettings";
import { formatStatsSummary } from "./stats-summary";
import type { GpuErrorSource } from "../renderer/gpu-error-log";

export interface RendererLifecycleCallbacks {
  onStats: (stats: RenderStats) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  /** Shows `message` as the viewer's error (used when renderer.init() fails). */
  setError: (message: string) => void;
}

export interface RendererLifecycleRefs {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
}

export function useRendererLifecycle(
  { canvasRef, rendererRef, sourceRef }: RendererLifecycleRefs,
  { onStats, reportError, setError }: RendererLifecycleCallbacks,
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new PointCloudRenderer(canvas);
    // Desktop/Android webview or plain browser: this is the single branch that switches the two (ADR-0012).
    const source: DataSource = isTauriEnvironment() ? new TauriSource() : new WebSource();
    rendererRef.current = renderer;
    sourceRef.current = source;
    // Apply the saved animation setting to the renderer (on when nothing is saved).
    renderer.setAnimationEnabled(readStoredAnimationEnabled(getLocalStorage()));
    // For measuring in a real browser (AN-1/AN-2): with ?pcvDebug in the URL, expose the renderer as
    // window.__pcvRenderer. Without it nothing happens.
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has("pcvDebug")) {
      (window as unknown as { __pcvRenderer?: unknown }).__pcvRenderer = renderer;
    }

    renderer.onStatsUpdate((s) => {
      onStats(s);
      // M1-4: also send the numbers to the backend console, so they can be followed without the GUI.
      reportToBackendConsole(formatStatsSummary(s)).catch((e) => console.error("reportToBackendConsole failed", e));
    });

    // ADR-0011: GPU errors go to the banner. Lesson from the EDL accident (tests green, screen black).
    renderer.onGpuErrorReported((message) => {
      reportError(message);
      reportToBackendConsole(`[gpu-error] ${message}`).catch((e) => console.error("reportToBackendConsole failed", e));
    });

    // ADR-0013: failures of reading a node over pcv:// go to the same banner, with source "node-read"
    // (a Rust panic is caught by catch_unwind and returned as HTTP 500 with the message).
    renderer.onNodeLoadErrorReported((message) => {
      reportError(message, "node-read");
      reportToBackendConsole(`[node-load-error] ${message}`).catch((e) =>
        console.error("reportToBackendConsole failed", e),
      );
    });

    let cancelled = false;
    renderer
      .init()
      .then(() => {
        if (cancelled) return;
        renderer.start();
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });

    const onResize = () => {
      renderer.resize(canvas.clientWidth, canvas.clientHeight);
    };
    window.addEventListener("resize", onResize);
    onResize();

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      renderer.dispose();
    };
  }, [canvasRef, rendererRef, sourceRef, onStats, reportError, setError]);
}
