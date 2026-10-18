// Opening files, as a plain class (no React): `openFiles` (one or several files; several LAS/LAZ are merged into
// one COPC) and `addOpenedLayer` (open a COPC with the DataSource and add it to the renderer and the layer list).
// Flow: `openFiles` awaits `source.prepareToOpen` once. The DataSource decides: a COPC is ready at once; a raw
// LAS/LAZ/PCD/PLY/E57 is converted inside the call and the promise resolves when the conversion is done (or has
// failed or been cancelled). Progress comes back through a callback and is kept here for the UI (`getSnapshot`).
// Used by: src/state/useFileOpen.ts (the one hook that creates it and hands the UI its snapshot);
// usePointCloudTools.ts calls `addOpenedLayer` for tool results.
// Rule: nothing in src/app/ imports React or a `use*` hook (TaskSheets/R12-file-opener-outside-react.md).
// Values that change while the app runs (renderer, source, temp dir) are read through the getters in
// `FileOpenerDeps` at the moment they are needed, so this class never holds a stale copy.
// Errors are put in `setStatus({ kind: "error", message })` and the error log (`reportError`).
import { reportToBackendConsole } from "../datasource/tauri";
import { multiDisplayNameFor } from "../datasource/opfs";
import { basenameOfPath } from "../datasource/file-name";
import { formatConversionBreakdown } from "../datasource/conversion-breakdown";
import { detectSourceFormatByName } from "../datasource/source-format";
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import type { PointShape } from "../renderer/device-profile";
import { DEFAULT_POINT_SIZE_PX } from "../renderer/layer-focus";
import { initialColorModeFor, type LayerDownload, type ViewerLayer } from "../state/layers";
import { currentDeviceMeta } from "../state/device-meta";
import type { ViewerStatus } from "../state/viewer-status";

/** What a finished conversion leaves on the layer it made (the breakdown text and the Web download link). */
export interface ConversionAttachment {
  breakdownText: string;
  download: LayerDownload | null;
}

export interface FileOpenerDeps {
  getSource: () => DataSource | null;
  getRenderer: () => PointCloudRenderer | null;
  setStatus: (status: ViewerStatus) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  /** Adds the finished layer record to the layer list (React state for now; moves into src/app/ in a later step). */
  addLayerToList: (layer: ViewerLayer) => void;
  nextLayerId: () => string;
  getTempDir: () => string | null;
  isMobile: boolean;
  pointShape: PointShape;
  /** True while a point-cloud tool runs: its desktop progress must not show as conversion progress. */
  isToolRunning: () => boolean;
  refreshOpfsStorageInfo: () => Promise<void>;
}

/**
 * What the UI shows around a conversion. The object is replaced (never mutated) when a value changes.
 * - `conversionProgress`: progress of a running conversion of raw LAS/LAZ, or null. Reading reports
 *   `{phase: "reading", pointsRead, totalPoints, elapsedSecs}` (an exact ratio); after that (octree build,
 *   writing) it switches to `{phase: "postProcessing", elapsedSecs}` (no ratio; see `src-tauri/src/conversion.rs`).
 *   Not part of the `converting` status: Web progress ("preparing") may arrive before the status turns
 *   "converting", and it must not be lost (R5).
 * - `convertingFileName`: name of the file converted last, for the conversion dialog; null before any conversion.
 *   Not in the `converting` status: the dialog still shows it after the conversion finished (status "ready"),
 *   and it is set while the status is still "opening" (R5).
 */
export interface FileOpenerSnapshot {
  conversionProgress: ConversionProgress | null;
  convertingFileName: string | null;
}

export class FileOpener {
  private snapshot: FileOpenerSnapshot = { conversionProgress: null, convertingFileName: null };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: FileOpenerDeps) {}

  /** For useSyncExternalStore. The same object is returned until something changes. */
  getSnapshot = (): FileOpenerSnapshot => this.snapshot;

  /** For useSyncExternalStore. Returns the function that removes the listener. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Called from the cancel button while converting. */
  cancelConversion(): void {
    this.deps.getSource()?.cancelConversion();
  }

  /**
   * Open the chosen files (desktop: path strings; Web: `File`s from a drop or the file picker):
   * 1. Several items must all be LAS/LAZ (checked here, before anything is converted).
   * 2. `source.prepareToOpen` makes the item(s) ready and returns when that is done: a COPC opens as it is,
   *    anything else is converted first (progress and "converting" come through the callbacks).
   *    What differs between the Web and the desktop build lives in the DataSource, not here.
   * 3. `ready` -> add the layer (with the breakdown and the download if it was converted);
   *    `failed` / `cancelled` -> show the texts.
   */
  async openFiles(items: string[] | File[]): Promise<void> {
    if (items.length === 0) return;
    const { deps } = this;
    const source = deps.getSource();
    if (!deps.getRenderer() || !source) return;

    deps.setStatus({ kind: "opening" });
    this.setProgress(null);

    const names = items.map((item) => (typeof item === "string" ? basenameOfPath(item) : item.name));

    // LAS/LAZ may be mixed; if PLY/PCD/E57 is among several files, say so before converting (naming the files).
    if (items.length > 1) {
      const nonLasNames = names.filter((n) => detectSourceFormatByName(n) !== "lasLaz");
      if (nonLasNames.length > 0) {
        this.failOpen(`複数ファイルの選択はLAS/LAZのみ対応しています。次のファイルは対象外です: ${nonLasNames.join("、")}`);
        return;
      }
    }

    // M4-12: remember the source name for the conversion dialog and the breakdown text ("file" row).
    // Several files: sorted, so the name does not depend on the selection order (e.g. "09LD2626 ほか54ファイル").
    const displayName = items.length > 1 ? multiDisplayNameFor([...names].sort()) : names[0];
    this.setFileName(displayName);

    try {
      const outcome = await source.prepareToOpen(items, {
        tempDir: deps.getTempDir(),
        isMobile: deps.isMobile,
        onConverting: () => deps.setStatus({ kind: "converting" }),
        onProgress: (progress) => {
          // A point-cloud tool also emits the desktop progress event (L2-C). Its progress goes to the tool dialog.
          if (!deps.isToolRunning()) this.setProgress(progress);
        },
      });
      // The conversion (if there was one) is over, whatever the outcome.
      this.setProgress(null);

      if (outcome.kind === "failed") {
        this.failOpen(outcome.summary, outcome.details);
        // Reflect the current usage before the settings page (delete / allow persistence) is shown.
        // (Does nothing on the desktop build: useOpfsStorage.ts.)
        void deps.refreshOpfsStorageInfo();
        return;
      }
      if (outcome.kind === "cancelled") {
        // Shown in the error banner too (ADR-0011/0013): without it the progress just disappears and it
        // looks as if nothing happened.
        deps.setStatus({ kind: "idle" });
        deps.reportError("変換をキャンセルしました", "conversion");
        return;
      }

      // Name in the layer list: the converted file's name for a conversion result, else the chosen file's name.
      const result = outcome.conversion;
      // Backend warnings (e.g. files without a CRS were let through) go to the error log, not away.
      for (const warning of result?.warnings ?? []) deps.reportError(warning, "conversion");
      const attachment: ConversionAttachment | null = result && {
        breakdownText: formatConversionBreakdown(result.stageTimings, {
          platform: result.platform,
          format: result.sourceFormat,
          fileName: displayName,
          ...currentDeviceMeta(),
        }),
        download: result.download,
      };

      let opened;
      try {
        opened = await this.addOpenedLayer(outcome.path, result?.outputName ?? displayName, attachment);
      } catch (e) {
        // The layer was not made, so nothing will ever use the download URL: let it go.
        if (result?.download) URL.revokeObjectURL(result.download.url);
        throw e;
      }
      deps.setStatus({ kind: "ready" });

      const label = typeof items[0] === "string" && items.length === 1 ? items[0] : displayName;
      const summary = `[M1] opened ${label}: points=${opened.pointCount} nodes=${opened.nodeCount}`;
      console.log(summary);
      await reportToBackendConsole(summary);
    } catch (e) {
      this.setProgress(null);
      this.failOpen(String(e));
    }
  }

  /**
   * Open `path` with the DataSource and add it to the renderer and the list as a new layer (the new layer
   * becomes the selection). Shared by `openFiles` and by the tool results (L2-F). Returns the layer id.
   * `attachment`: the breakdown and the download to attach to this layer when it is a conversion result.
   */
  async addOpenedLayer(
    path: string,
    name: string,
    attachment: ConversionAttachment | null,
  ): Promise<{ layerId: string; pointCount: number; nodeCount: number }> {
    const { deps } = this;
    const renderer = deps.getRenderer();
    const source = deps.getSource();
    if (!renderer || !source) throw new Error("ビューアが初期化されていません");
    const opened = await source.open(path);
    // L1-D: what is opened is always added as a new layer (never replaces one).
    // Initial coloring is "rgb" if the file has RGB, otherwise elevation (colormap.ts `resolveColorMode`).
    // The renderer does not know `resolveColorMode`; it uses the value as given.
    // The renderer does not know cloudId: each layer gets a readNode that closes over its own cloudId.
    // The elevation range is CloudInfo.min/max (real data range), not the node bounds (which are cubes).
    const layerId = deps.nextLayerId();
    const colorMode = initialColorModeFor(opened.info);
    renderer.addLayer(layerId, {
      hierarchy: opened.nodes,
      readNode: (key) => source.readNode(opened.cloudId, key),
      boundsMin: opened.info.min,
      boundsMax: opened.info.max,
      colorMode,
      visible: true,
      pointShape: deps.pointShape,
      pointSizePx: DEFAULT_POINT_SIZE_PX,
    });
    deps.addLayerToList({
      id: layerId,
      name,
      info: opened.info,
      nodeCount: opened.nodes.length,
      visible: true,
      colorMode,
      pointShape: deps.pointShape,
      pointSize: DEFAULT_POINT_SIZE_PX,
      cloudId: opened.cloudId,
      sourcePath: path,
      conversionBreakdownText: attachment?.breakdownText ?? null,
      download: attachment?.download ?? null,
    });
    // A CRS read failure does not stop the file from opening (ADR-0015). The text goes to the error log.
    if (opened.info.crs.error) {
      deps.reportError(`座標系(CRS)を読み取れませんでした: ${opened.info.crs.error}`, "crs");
    }
    return { layerId, pointCount: opened.info.pointCount, nodeCount: opened.nodes.length };
  }

  /**
   * An open failed: show `summary` in the panel (status) and keep `details` in the error log, so the text is
   * still in the banner / history after the panel text goes away (the panel is cleared when a later tool succeeds).
   * Most failures have one text for both (`details` defaults to `summary`).
   */
  private failOpen(summary: string, details: string = summary): void {
    this.deps.reportError(details, "conversion");
    this.deps.setStatus({ kind: "error", message: summary });
  }

  private setProgress(progress: ConversionProgress | null): void {
    if (this.snapshot.conversionProgress === progress) return;
    this.update({ ...this.snapshot, conversionProgress: progress });
  }

  private setFileName(name: string): void {
    if (this.snapshot.convertingFileName === name) return;
    this.update({ ...this.snapshot, convertingFileName: name });
  }

  private update(next: FileOpenerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
