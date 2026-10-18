// Point-cloud tools (L2-F): select by polygon, cross section, merge. ADR-0018: each tool reads the chosen
// layers' files and writes a NEW COPC, which is opened as a new layer. The source layers are never changed.
// Rust does the work (desktop: Tauri command, Web: Worker + OPFS). This file runs one tool at a time, shows
// its progress, and sends warnings and failures to the error log.
// Not to be confused with useLayerTool.ts / useMeasureTool.ts: those handle the mouse input on the 3D view
// and call `extractFromLayer` / `addMeasurement` from here / from useLayers.ts.
// Used by: useCopcViewer.ts. Entry: `usePointCloudTools(deps)`.
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { extractToCopc as tauriExtractToCopc, mergeCopcs as tauriMergeCopcs, cancelLasConversion } from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import type { DataSource } from "../datasource/DataSource";
import type { ExtractFilter, ToolOptions, ToolResult } from "../datasource/tools";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { horizontalBasis } from "../renderer/up-axis";
import { findLayer, isMeasureLayer, type LayersState } from "./layers";
import { effectiveSelectedIds, toolSourceLayers } from "./layer-selection";
import { sectionYaw } from "./tool-math";
import type { ToolProgressState } from "./viewer-types";
import type { ViewerStatus } from "./viewer-status";

export interface PointCloudToolsDeps {
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  /**
   * True while a tool runs. Created in useCopcViewer.ts and shared with FileOpener (src/app/file-opener.ts), because
   * the desktop tools reuse the `conversion-progress` event and the conversion listener must ignore it.
   */
  toolRunningRef: RefObject<boolean>;
  layersStateRef: RefObject<LayersState>;
  extraSelectedIds: string[];
  tempDir: string | null;
  isMobile: boolean;
  addOpenedLayer: (
    path: string,
    name: string,
    conversion: null,
  ) => Promise<{ layerId: string }>;
  focusLayer: (id: string, orientation?: { yaw: number; pitch: number }) => void;
  setStatus: Dispatch<SetStateAction<ViewerStatus>>;
  reportError: (message: string, source?: GpuErrorSource) => void;
}

export interface PointCloudTools {
  /** Progress of the running point-cloud tool, or null. */
  toolProgress: ToolProgressState | null;
  cancelTool: () => void;
  /** Make a new layer from the points of `layerId` that match `filter` (ADR-0018). Failures go to the error log. */
  extractFromLayer: (
    layerId: string,
    filter: ExtractFilter,
    label: "選択" | "断面",
    viewNormal?: readonly [number, number, number],
  ) => Promise<void>;
  /** Merge the selected point-cloud layers into one new layer. */
  mergeSelectedLayers: () => Promise<void>;
}

export function usePointCloudTools({
  rendererRef,
  sourceRef,
  toolRunningRef,
  layersStateRef,
  extraSelectedIds,
  tempDir,
  isMobile,
  addOpenedLayer,
  focusLayer,
  setStatus,
  reportError,
}: PointCloudToolsDeps): PointCloudTools {
  const [toolProgress, setToolProgress] = useState<ToolProgressState | null>(null);

  /** Show a tool failure or warning in the existing error display (ADR-0011), with the text as it is. */
  const reportToolMessage = useCallback((message: string) => reportError(message, "tool"), [reportError]);

  /**
   * Run one tool: show progress, open the result as a new layer, send warnings and failures to the error log.
   * `viewNormal` (cross section only): after opening, look at the result from that horizontal direction.
   */
  const runTool = useCallback(
    async (
      title: string,
      resultName: string,
      run: (source: DataSource, options: ToolOptions) => Promise<ToolResult>,
      viewNormal?: readonly [number, number, number],
    ) => {
      const source = sourceRef.current;
      if (!source) return;
      if (toolRunningRef.current) {
        reportToolMessage("別の点群ツールを実行中です。終わってからやり直してください");
        return;
      }
      toolRunningRef.current = true;
      setToolProgress({ title, pointsRead: 0, totalPoints: 0 });
      try {
        const result = await run(source, {
          tempDir,
          onProgress: (p) => setToolProgress({ title, pointsRead: p.pointsRead, totalPoints: p.totalPoints }),
        });
        for (const warning of result.warnings) reportToolMessage(warning);
        const { layerId } = await addOpenedLayer(result.outputPath, resultName, null);
        // A tool that worked means the viewer is fine now, so the panel's old open error goes away.
        // Nothing is lost: an open failure is also in the error log / banner history (`failOpen` in src/app/file-opener.ts).
        setStatus({ kind: "ready" });
        if (viewNormal) {
          const up = rendererRef.current?.getViewSnapshot()?.up ?? [0, 0, 1];
          const { right, forward } = horizontalBasis(up);
          focusLayer(layerId, { yaw: sectionYaw(viewNormal, right, forward), pitch: 0 });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        reportToolMessage(message.includes("キャンセル") ? `${title}をキャンセルしました` : message);
      } finally {
        toolRunningRef.current = false;
        setToolProgress(null);
      }
    },
    [sourceRef, rendererRef, toolRunningRef, tempDir, addOpenedLayer, focusLayer, setStatus, reportToolMessage],
  );

  const extractFromLayer = useCallback(
    async (
      layerId: string,
      filter: ExtractFilter,
      label: "選択" | "断面",
      viewNormal?: readonly [number, number, number],
    ) => {
      const layer = findLayer(layersStateRef.current.layers, layerId);
      if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
        reportToolMessage("点群のレイヤーを選んでください");
        return;
      }
      const path = layer.sourcePath;
      await runTool(
        `${label}（${layer.name}）`,
        `${label} - ${layer.name}`,
        (source, options) =>
          source instanceof WebSource ? source.extractToCopc(path, filter, options) : tauriExtractToCopc(path, filter, options),
        viewNormal,
      );
    },
    [layersStateRef, runTool, reportToolMessage],
  );

  const mergeSelectedLayers = useCallback(async () => {
    const current = layersStateRef.current;
    const sources = toolSourceLayers(
      current.layers,
      effectiveSelectedIds(current.layers, current.selectedLayerId, extraSelectedIds),
    );
    if (sources.length < 2) {
      reportToolMessage("結合するには点群のレイヤーを2つ以上選んでください（Ctrl か Shift を押しながらクリック）");
      return;
    }
    const paths = sources.map((l) => l.sourcePath as string);
    await runTool(
      `結合（${sources.length}レイヤー）`,
      `結合 (${sources.length})`,
      (source, options) =>
        source instanceof WebSource ? source.mergeCopcs(paths, { ...options, isMobile }) : tauriMergeCopcs(paths, options),
    );
  }, [layersStateRef, runTool, reportToolMessage, extraSelectedIds, isMobile]);

  // The desktop tools share the cancel command with conversion (the Web build cancels the Worker job).
  const cancelTool = useCallback(() => {
    const source = sourceRef.current;
    if (source instanceof WebSource) {
      source.cancelConversion();
      return;
    }
    cancelLasConversion().catch((e: unknown) => console.error("cancelLasConversion failed", e));
  }, [sourceRef]);

  return { toolProgress, cancelTool, extractFromLayer, mergeSelectedLayers };
}
