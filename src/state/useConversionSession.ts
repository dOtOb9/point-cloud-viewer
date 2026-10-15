// The running conversion (LAS/LAZ/PCD -> COPC): its progress, the source file name, and the events that
// say it finished or failed. It also holds the "pending result" between "conversion done" and "the result is
// opened as a layer", and the clipboard copy of the breakdown text.
// How it connects: useFileOpen.ts starts a conversion and calls `rememberConvertingSource`. When the backend
// reports "done" (Tauri event, or WebSource listener), the effect here stores the pending result and calls
// `openFileRef.current(path, true)`; useFileOpen.ts keeps `openFileRef` pointing at its latest `openFile`
// and takes the pending result with `takePendingConversion` when the layer is added.
// Used by: useFileOpen.ts (everything it returns), usePointCloudTools.ts (shares `toolRunningRef`, see below).
// Entry: `useConversionSession(deps)`. Its effect needs `sourceRef.current`, so call it after useRendererLifecycle.
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  cancelLasConversion,
  onConversionDone,
  onConversionFailed,
  onConversionProgress,
} from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import { getConvertedFile } from "../datasource/opfs";
import type { DataSource } from "../datasource/DataSource";
import type { ConversionProgress } from "../datasource/conversion-dto";
import { formatConversionBreakdown, type ConversionBreakdownMeta } from "../datasource/conversion-breakdown";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import type { LayerDownload } from "./layers";
import { basenameOfPath, extensionOfFileName } from "./open-file-text";
import type { ViewerStatus } from "./viewer-types";

/**
 * The result of a finished conversion, kept only until it is opened as a layer.
 *
 * Bug fixed 2026-10-08 ("the breakdown does not appear"): the done handler set the breakdown and then called
 * `openFile`, which cleared it first. Since L1-D the breakdown and the download belong to the layer that was
 * made, so the handler keeps them here and `openFile(..., true)` (continuing from a conversion) moves them to
 * the layer. When the user opens another file by hand (second argument false) nothing is moved, so no other
 * layer gets the breakdown.
 */
export interface PendingConversionResult {
  /** Name shown in the layer list (the converted `.copc.laz`). */
  name: string;
  breakdownText: string;
  download: LayerDownload | null;
}

/** M4-12: device info for the breakdown text. `navigator.deviceMemory` is Chrome-only; left undefined when missing. */
function currentDeviceMeta(): Pick<ConversionBreakdownMeta, "browser" | "hardwareConcurrency" | "deviceMemoryGiB"> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    browser: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGiB: nav.deviceMemory,
  };
}

export interface ConversionSessionDeps {
  sourceRef: RefObject<DataSource | null>;
  /**
   * True while a point-cloud tool runs (usePointCloudTools.ts sets it). The desktop tools reuse the
   * `conversion-progress` event, and the listener here must not treat that as a conversion.
   */
  toolRunningRef: RefObject<boolean>;
  setStatus: Dispatch<SetStateAction<ViewerStatus>>;
  setError: Dispatch<SetStateAction<string | null>>;
  reportError: (message: string, source?: GpuErrorSource) => void;
  /** Breakdown text of the selected layer (null if it has none), for the copy button. */
  selectedBreakdownText: string | null;
}

export interface ConversionSession {
  conversionProgress: ConversionProgress | null;
  /** Clear the progress (done when starting to open something). */
  clearConversionProgress: () => void;
  convertingFileName: string | null;
  /** Remember the name of the file being converted, for the dialog and the breakdown text ("file" row). */
  rememberConvertingSource: (name: string) => void;
  /** Latest `openFile`; the done handler calls it. useFileOpen.ts assigns it. */
  openFileRef: RefObject<(pathOrFile: string | File, isConversionContinuation?: boolean) => Promise<void>>;
  /** Take (and clear) the pending conversion result. Called when a layer is added as the continuation of a conversion. */
  takePendingConversion: () => PendingConversionResult | null;
  cancelConversion: () => void;
  copyConversionBreakdownText: () => Promise<boolean>;
}

export function useConversionSession({
  sourceRef,
  toolRunningRef,
  setStatus,
  setError,
  reportError,
  selectedBreakdownText,
}: ConversionSessionDeps): ConversionSession {
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  const [convertingFileName, setConvertingFileName] = useState<string | null>(null);
  // Read by the done handlers, which are registered once and do not see this render's values.
  const convertingSourceNameRef = useRef<string | null>(null);
  const pendingConversionRef = useRef<PendingConversionResult | null>(null);
  // `openFile` is recreated when `tempDir` etc. change, but the event subscription below is made once.
  // So the handlers call it through this ref (the usual "effect once, content latest" pattern).
  const openFileRef = useRef<(pathOrFile: string | File, isConversionContinuation?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );

  const setPendingConversion = useCallback((next: PendingConversionResult | null) => {
    // Let go of the previous download URL if it was never opened.
    const previous = pendingConversionRef.current;
    if (previous?.download) URL.revokeObjectURL(previous.download.url);
    pendingConversionRef.current = next;
  }, []);

  const takePendingConversion = useCallback(() => {
    const pending = pendingConversionRef.current;
    pendingConversionRef.current = null;
    return pending;
  }, []);

  const rememberConvertingSource = useCallback((name: string) => {
    convertingSourceNameRef.current = name;
    setConvertingFileName(name);
  }, []);

  const clearConversionProgress = useCallback(() => setConversionProgress(null), []);

  // M4-3/M4-6b: subscribe to progress / done / failed. Desktop: Tauri events from the Rust backend.
  // Web: listeners on `WebSource` (it relays postMessage from the Worker). The two routes differ completely,
  // so this branches (the Web build has no Tauri event delivery).
  useEffect(() => {
    const source = sourceRef.current;
    if (!source) return;

    let unlistenProgress = () => {};
    let unlistenDone = () => {};
    let unlistenFailed = () => {};

    const reportConversionFailure = (message: string, cancelled: boolean) => {
      setConversionProgress(null);
      setStatus(cancelled ? "idle" : "error");
      setError(cancelled ? null : message);
      // Failures and cancels are shown in the error banner (ADR-0011/0013). Cancel too: without the
      // banner the progress just disappears and it looks as if nothing happened.
      reportError(cancelled ? "変換をキャンセルしました" : `変換に失敗しました: ${message}`, "conversion");
    };

    if (source instanceof WebSource) {
      unlistenProgress = source.onConvertProgress((progress) => setConversionProgress(progress));
      unlistenDone = source.onConvertDone((outputName, suggestedFileName, _pointCount, stageTimings) => {
        setConversionProgress(null);
        // M4-12: build the breakdown text. The source name is the one `openFile` remembered before starting
        // (`suggestedFileName` already has the ".copc.laz" extension, so the original format is lost).
        const sourceName = convertingSourceNameRef.current ?? suggestedFileName;
        const breakdownText = formatConversionBreakdown(stageTimings, {
          platform: "web",
          // M4-14: for several files the display name has no extension ("<name> ほかNファイル"),
          // so use the same wording as the desktop build.
          format: stageTimings.inputFileCount > 1 ? "las/laz(複数ファイル)" : extensionOfFileName(sourceName),
          fileName: sourceName,
          ...currentDeviceMeta(),
        });
        void (async () => {
          // Read the OPFS output back as a `File` and open it through the same route as a local file
          // (`registerFile` -> `open`). The download URL is made here too (OPFS content cannot be
          // fetched from outside the app).
          const file = await getConvertedFile(outputName);
          if (!file) {
            setStatus("error");
            setError("変換結果をOPFSから読み出せませんでした");
            return;
          }
          // L1-D: keep the breakdown and the download pending; the layer opened next receives them.
          setPendingConversion({
            name: suggestedFileName,
            breakdownText,
            download: { url: URL.createObjectURL(file), fileName: suggestedFileName },
          });
          const key = source.registerFile(file);
          // The second argument `true` means "continuing from a conversion" (move the pending result to the layer).
          void openFileRef.current(key, true);
        })();
      });
      unlistenFailed = source.onConvertFailed(reportConversionFailure);
    } else {
      void onConversionProgress((progress) => {
        // A point-cloud tool also emits this event (L2-C). Its progress goes to the tool dialog, not the conversion UI.
        if (!toolRunningRef.current) setConversionProgress(progress);
      }).then((fn) => {
        unlistenProgress = fn;
      });
      void onConversionDone((outputPath, sourceFormat, stageTimings) => {
        // Open the output (already COPC) again. It goes through start_las_conversion once more, but
        // that is judged "already COPC" and opens at once (the cost is one header read).
        setConversionProgress(null);
        setPendingConversion({
          name: basenameOfPath(outputPath),
          breakdownText: formatConversionBreakdown(stageTimings, {
            platform: "desktop",
            format: sourceFormat,
            fileName: convertingSourceNameRef.current ?? basenameOfPath(outputPath),
            ...currentDeviceMeta(),
          }),
          download: null,
        });
        // Second argument true, for the same reason as the Web branch above.
        void openFileRef.current(outputPath, true);
      }).then((fn) => {
        unlistenDone = fn;
      });
      void onConversionFailed(reportConversionFailure).then((fn) => {
        unlistenFailed = fn;
      });
    }

    return () => {
      unlistenProgress();
      unlistenDone();
      unlistenFailed();
    };
  }, [sourceRef, toolRunningRef, setStatus, setError, reportError, setPendingConversion]);

  const cancelConversion = useCallback(() => {
    const source = sourceRef.current;
    if (source instanceof WebSource) {
      // M4-6b: a fire-and-forget message. It takes effect between read batches (it cannot interrupt the
      // post-processing stage; see crates/pcv-wasm/src/convert.rs).
      source.cancelConversion();
      return;
    }
    cancelLasConversion().catch((e: unknown) => {
      // The conversion may have finished already; cancel was only too late. A log line is enough.
      console.error("cancelLasConversion failed", e);
    });
  }, [sourceRef]);

  // M4-12: copy the breakdown text of the selected layer. Where `navigator.clipboard` is missing
  // (non-HTTPS etc.) the screen must not break, so a failure is only logged.
  const copyConversionBreakdownText = useCallback(async (): Promise<boolean> => {
    if (selectedBreakdownText === null) return false;
    try {
      await navigator.clipboard.writeText(selectedBreakdownText);
      return true;
    } catch (e: unknown) {
      console.error("copyConversionBreakdownText failed", e);
      return false;
    }
  }, [selectedBreakdownText]);

  return {
    conversionProgress,
    clearConversionProgress,
    convertingFileName,
    rememberConvertingSource,
    openFileRef,
    takePendingConversion,
    cancelConversion,
    copyConversionBreakdownText,
  };
}
