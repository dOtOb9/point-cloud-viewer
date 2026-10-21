// Point-cloud tools (L2-F), as plain functions (no class, no React): `extractFromLayer` (cut / cross section),
// `mergeSelectedLayers` and `cancelTool`. ADR-0018: each tool reads the chosen layers' files and writes a NEW COPC,
// which is opened as a new layer. The source layers are never changed.
// Rust does the work (desktop: Tauri command, Web: Worker + OPFS). `runTool` runs one tool at a time, shows its
// progress, and sends warnings and failures to the error log.
// Everything the functions read or change comes in through `PointCloudToolsContext`, built by src/state/usePointCloudTools.ts.
// Called by: the toolbar buttons, the tool dialogs and src/state/useLayerTool.ts directly (F12 lands here).
// Rule: nothing in src/app/ imports React or a `use*` hook (TaskSheets/ADR-0021-thin-react.md, R13).
import {
  extractToCopc as tauriExtractToCopc,
  mergeCopcs as tauriMergeCopcs,
  computeSectionLine as tauriComputeSectionLine, // G2
  cancelLasConversion,
  thinCopc as tauriThinCopc, // G3
  filterCopc as tauriFilterCopc, // G3
} from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import type { DataSource } from "../datasource/DataSource";
import type { ExtractFilter, ToolOptions, ToolResult } from "../datasource/tools";
import type { FilterRequest, ThinRequest } from "../datasource/thin-filter"; // G3
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { horizontalBasis } from "../renderer/up-axis";
import type { SectionGroundLine } from "../datasource/section-line";
import { findLayer, isMeasureLayer, type LayersState, type SectionInfo } from "../state/layers";
import { effectiveSelectedIds, toolSourceLayers } from "../state/layer-selection";
import { sectionYaw } from "../state/tool-math";
import { lengthUnitsFor } from "../state/units";
import { sectionLineRequestFor } from "./csf-params";
import type { ToolProgressState } from "../state/viewer-types";
import type { ViewerStatus } from "../state/viewer-status";

/**
 * Everything the tools read or change. Built by the bridge hook (src/state/usePointCloudTools.ts) on each render.
 * Plain values (`tempDir`, `isMobile`, `extraSelectedIds`) are those of the moment the context was built; the
 * getters read refs that are filled after the first render, so they are called when needed.
 */
export interface PointCloudToolsContext {
  getSource: () => DataSource | null;
  getLayersState: () => LayersState;
  /** Direction of "up" in the current view, for looking at a cross section. */
  getViewUp: () => readonly [number, number, number];
  /** Ids selected with Ctrl/Shift click besides the primary (for "merge"). */
  extraSelectedIds: string[];
  tempDir: string | null;
  isMobile: boolean;
  /** Open `path` as a new layer called `name`; returns its id (this is `addOpenedLayer` of src/app/open-files.ts). */
  addOpenedLayer: (path: string, name: string, section?: SectionInfo) => Promise<{ layerId: string }>;
  /** Store the computed ground line on the cross-section layer (what `setLayerSectionLineInList` of src/state/layers.ts does). */
  setSectionLine: (layerId: string, line: SectionGroundLine) => void;
  focusLayer: (id: string, orientation?: { yaw: number; pitch: number }) => void;
  /** Show or hide a layer, the same function the layer list's checkbox calls (React state and renderer). */
  setLayerVisible: (id: string, visible: boolean) => void;
  setStatus: (status: ViewerStatus) => void;
  setToolProgress: (progress: ToolProgressState | null) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  /**
   * Shared "a tool is running" flag: one object for the app's lifetime (the same idea as `openLock` in open-files.ts).
   * `runTool` sets `running` and refuses to start while it is set. It is also read by the file-open context
   * (`isToolRunning`), because the desktop tools reuse the `conversion-progress` event and the conversion listener
   * must ignore it. A plain object, not React state, because two clicks can arrive before React re-renders.
   */
  toolLock: { running: boolean };
}

/** Show a tool failure or warning in the existing error display (ADR-0011), with the text as it is. */
function reportToolMessage(ctx: PointCloudToolsContext, message: string): void {
  ctx.reportError(message, "tool");
}

/**
 * Turn off the visibility of the layers a tool read from, once the tool has made its new layer (G0-2). It does what
 * unticking the checkbox in the layer list does; the source layers are neither deleted nor changed. Every tool that
 * makes a layer from other layers (cut, cross section, merge, and later thinning, filters, DTM) goes through this.
 */
export function hideSourceLayers(ctx: PointCloudToolsContext, sourceLayerIds: readonly string[]): void {
  for (const id of sourceLayerIds) ctx.setLayerVisible(id, false);
}

/**
 * Run one tool: show progress, open the result as a new layer, send warnings and failures to the error log.
 * `viewNormal` (cross section only): after opening, look at the result from that horizontal direction.
 */
async function runTool(
  ctx: PointCloudToolsContext,
  title: string,
  resultName: string,
  sourceLayerIds: readonly string[],
  run: (source: DataSource, options: ToolOptions) => Promise<ToolResult>,
  viewNormal?: readonly [number, number, number],
  // --- G2: cross-section view ---
  section?: SectionInfo,
): Promise<string | null> {
  const source = ctx.getSource();
  if (!source) return null;
  if (ctx.toolLock.running) {
    reportToolMessage(ctx, "別の点群ツールを実行中です。終わってからやり直してください");
    return null;
  }
  ctx.toolLock.running = true;
  ctx.setToolProgress({ title, pointsRead: 0, totalPoints: 0 });
  try {
    const result = await run(source, {
      tempDir: ctx.tempDir,
      onProgress: (p) => ctx.setToolProgress({ title, pointsRead: p.pointsRead, totalPoints: p.totalPoints }),
    });
    for (const warning of result.warnings) reportToolMessage(ctx, warning);
    const { layerId } = await ctx.addOpenedLayer(result.outputPath, resultName, section);
    // A tool that worked means the viewer is fine now, so the panel's old open error goes away.
    // Nothing is lost: an open failure is also in the error log / banner history (`failOpen` in src/app/open-files.ts).
    ctx.setStatus({ kind: "ready" });
    // Only a tool that worked hides its sources; on failure or cancel they stay visible (the throw skips this).
    hideSourceLayers(ctx, sourceLayerIds);
    if (viewNormal) {
      const { right, forward } = horizontalBasis(ctx.getViewUp());
      ctx.focusLayer(layerId, { yaw: sectionYaw(viewNormal, right, forward), pitch: 0 });
    }
    return layerId;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportToolMessage(ctx, message.includes("キャンセル") ? `${title}をキャンセルしました` : message);
    return null;
  } finally {
    ctx.toolLock.running = false;
    ctx.setToolProgress(null);
  }
}

/** Make a new layer from the points of `layerId` that match `filter` (ADR-0018). Failures go to the error log. */
export async function extractFromLayer(
  ctx: PointCloudToolsContext,
  layerId: string,
  filter: ExtractFilter,
  label: "カット" | "断面",
  viewNormal?: readonly [number, number, number],
  // --- G2: cross-section view ---
  section?: SectionInfo,
): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
    reportToolMessage(ctx, "点群のレイヤーを選んでください");
    return;
  }
  const path = layer.sourcePath;
  const newLayerId = await runTool(
    ctx,
    `${label}（${layer.name}）`,
    `${label} - ${layer.name}`,
    [layer.id],
    (source, options) =>
      source instanceof WebSource ? source.extractToCopc(path, filter, options) : tauriExtractToCopc(path, filter, options),
    viewNormal,
    section,
  );
  // --- G2: section line ---
  // Once the section layer is open (with its panel), make the ground line in the background.
  if (section && newLayerId !== null) await computeSectionLine(ctx, newLayerId, section);
}

// --- G2: section line ---

/**
 * Compute the ground line of the cross-section layer `sectionLayerId` and store it on the layer (G2-4). It is read
 * from the SOURCE layer (`section.sourceLayerId`), not from the thin slab, because the cloth needs the points around
 * the line. It shows progress in the tool progress dialog and can be cancelled like any tool. A failure or a
 * cancel goes to the error log and the panel keeps showing the points only.
 */
export async function computeSectionLine(ctx: PointCloudToolsContext, sectionLayerId: string, section: SectionInfo): Promise<void> {
  const source = ctx.getSource();
  if (!source) return;
  const sourceLayer = findLayer(ctx.getLayersState().layers, section.sourceLayerId);
  if (!sourceLayer || isMeasureLayer(sourceLayer)) {
    reportToolMessage(ctx, "断面線の元になるレイヤーが見つからないため、断面線は作れませんでした");
    return;
  }
  if (ctx.toolLock.running) {
    reportToolMessage(ctx, "別の点群ツールを実行中です。終わってからやり直してください");
    return;
  }
  const title = `断面線の計算（${sourceLayer.name}）`;
  ctx.toolLock.running = true;
  ctx.setToolProgress({ title, pointsRead: 0, totalPoints: 0, showAsPercent: true });
  try {
    const line = { a: section.a, b: section.b, up: section.up };
    // The owner's CSF values are in metres; Rust takes the file's unit (src/app/csf-params.ts).
    const { request, warning } = sectionLineRequestFor(section.linePreset, lengthUnitsFor(sourceLayer.info.crs, "meter"));
    if (warning) reportToolMessage(ctx, warning);
    const options: ToolOptions = {
      tempDir: ctx.tempDir,
      onProgress: (p) => ctx.setToolProgress({ title, pointsRead: p.pointsRead, totalPoints: p.totalPoints, showAsPercent: true }),
    };
    const result =
      source instanceof WebSource
        ? await source.computeSectionLine(sourceLayer.cloudId, line, request, options)
        : await tauriComputeSectionLine(sourceLayer.cloudId, line, request, options);
    ctx.setSectionLine(sectionLayerId, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportToolMessage(ctx, message.includes("キャンセル") ? `${title}をキャンセルしました` : message);
  } finally {
    ctx.toolLock.running = false;
    ctx.setToolProgress(null);
  }
}

/** Merge the selected point-cloud layers into one new layer. */
export async function mergeSelectedLayers(ctx: PointCloudToolsContext): Promise<void> {
  const current = ctx.getLayersState();
  const sources = toolSourceLayers(
    current.layers,
    effectiveSelectedIds(current.layers, current.selectedLayerId, ctx.extraSelectedIds),
  );
  if (sources.length < 2) {
    reportToolMessage(ctx, "合成するには点群のレイヤーを2つ以上選んでください（Ctrl か Shift を押しながらクリック）");
    return;
  }
  const paths = sources.map((l) => l.sourcePath as string);
  await runTool(
    ctx,
    `合成（${sources.length}レイヤー）`,
    `合成 (${sources.length})`,
    sources.map((l) => l.id),
    (source, options) =>
      source instanceof WebSource ? source.mergeCopcs(paths, { ...options, isMobile: ctx.isMobile }) : tauriMergeCopcs(paths, options),
  );
}

/** The desktop tools share the cancel command with conversion (the Web build cancels the Worker job). */
export function cancelTool(ctx: PointCloudToolsContext): void {
  const source = ctx.getSource();
  if (source instanceof WebSource) {
    source.cancelConversion();
    return;
  }
  cancelLasConversion().catch((e: unknown) => console.error("cancelLasConversion failed", e));
}

// --- G3: thinning and outlier filters ---

/**
 * Make a new layer from `layerId` by thinning it (G3-5, ADR-0018). `request` lengths are already in the file's unit
 * (`thinRequestFor` in src/app/thin-filter.ts). The source layer is hidden only when the tool worked. Zero kept points,
 * a failure and a cancel go to the error log and leave the source visible.
 */
export async function thinLayer(ctx: PointCloudToolsContext, layerId: string, request: ThinRequest): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
    reportToolMessage(ctx, "点群のレイヤーを選んでください");
    return;
  }
  const path = layer.sourcePath;
  await runTool(
    ctx,
    `間引き（${layer.name}）`,
    `間引き - ${layer.name}`,
    [layer.id],
    (source, options) =>
      source instanceof WebSource ? source.thinCopc(path, request, options) : tauriThinCopc(path, request, options),
  );
}

/** Make a new layer from `layerId` by removing outliers (ROR or SOR). Same rules as `thinLayer`; SOR reads the file twice. */
export async function filterLayer(ctx: PointCloudToolsContext, layerId: string, request: FilterRequest): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
    reportToolMessage(ctx, "点群のレイヤーを選んでください");
    return;
  }
  const path = layer.sourcePath;
  await runTool(
    ctx,
    `フィルタ（${layer.name}）`,
    `フィルタ - ${layer.name}`,
    [layer.id],
    (source, options) =>
      source instanceof WebSource ? source.filterCopc(path, request, options) : tauriFilterCopc(path, request, options),
  );
}
