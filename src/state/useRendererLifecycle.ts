import { useEffect, type RefObject } from "react";
import { TauriSource, reportToBackendConsole } from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import { isTauriEnvironment } from "../datasource/environment";
import type { DataSource } from "../datasource/DataSource";
import { PointCloudRenderer, type RenderStats } from "../renderer/point-cloud-renderer";
import { attachViewRenderer, detachViewRenderer, type ViewContext } from "../app/view";
import { readStoredAnimationEnabled } from "./motion-setting";
import { getLocalStorage } from "./useDisplaySettings";
import { formatStatsSummary } from "./stats-summary";
import type { GpuErrorSource } from "../renderer/gpu-error-log";

export interface RendererLifecycleCallbacks {
  onStats: (stats: RenderStats) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  setError: (message: string) => void;
}

export interface RendererLifecycleRefs {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  viewContext: ViewContext;
}

export function useRendererLifecycle(
  { canvasRef, rendererRef, sourceRef, viewContext }: RendererLifecycleRefs,
  { onStats, reportError, setError }: RendererLifecycleCallbacks,
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new PointCloudRenderer(canvas);
    const source: DataSource = isTauriEnvironment() ? new TauriSource() : new WebSource();
    rendererRef.current = renderer;
    sourceRef.current = source;
    renderer.setAnimationEnabled(readStoredAnimationEnabled(getLocalStorage()));
    attachViewRenderer(viewContext, renderer);
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has("pcvDebug")) {
      (window as unknown as { __pcvRenderer?: unknown }).__pcvRenderer = renderer;
    }

    renderer.onStatsUpdate((s) => {
      onStats(s);
      reportToBackendConsole(formatStatsSummary(s)).catch((e) => console.error("reportToBackendConsole failed", e));
    });

    renderer.onGpuErrorReported((message) => {
      reportError(message);
      reportToBackendConsole(`[gpu-error] ${message}`).catch((e) => console.error("reportToBackendConsole failed", e));
    });

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
      detachViewRenderer(viewContext);
      renderer.dispose();
    };
  }, [canvasRef, rendererRef, sourceRef, viewContext, onStats, reportError, setError]);
}
