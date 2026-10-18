// What the UI shows around a conversion (LAS/LAZ/PCD -> COPC): its progress, the name of the source file,
// the cancel button and the clipboard copy of the breakdown text.
// The conversion itself is not here: `useFileOpen.ts` awaits `source.prepareToOpen`, which returns when the
// conversion has finished. It passes the progress it receives to `reportConversionProgress`.
// Used by: useFileOpen.ts (progress and name), useCopcViewer.ts (exposes the cancel and copy functions).
// Entry: `useConversionSession(deps)`.
import { useCallback, useState, type RefObject } from "react";
import type { DataSource } from "../datasource/DataSource";
import type { ConversionProgress } from "../datasource/conversion-dto";

export interface ConversionSessionDeps {
  sourceRef: RefObject<DataSource | null>;
  /**
   * True while a point-cloud tool runs (usePointCloudTools.ts sets it). The desktop tools reuse the
   * `conversion-progress` event, so a progress report that arrives then belongs to the tool, not to a conversion.
   */
  toolRunningRef: RefObject<boolean>;
  /** Breakdown text of the selected layer (null if it has none), for the copy button. */
  selectedBreakdownText: string | null;
}

export interface ConversionSession {
  /**
   * Progress of a running conversion of raw LAS/LAZ, or null. Reading reports `{phase: "reading", pointsRead,
   * totalPoints, elapsedSecs}` (an exact ratio); after that (octree build, writing) it switches to
   * `{phase: "postProcessing", elapsedSecs}` (no ratio; see the doc of `src-tauri/src/conversion.rs`).
   * Not part of the `converting` status: Web progress ("preparing") may arrive before the status turns
   * "converting", and it must not be lost (R5).
   */
  conversionProgress: ConversionProgress | null;
  /** Take a progress report from `prepareToOpen`. Ignored while a point-cloud tool runs (see `toolRunningRef`). */
  reportConversionProgress: (progress: ConversionProgress) => void;
  /** Clear the progress (done when starting to open something, and when the conversion ended). */
  clearConversionProgress: () => void;
  /**
   * Name of the file converted last, for the conversion dialog; null before any conversion.
   * Not in the `converting` status: the dialog still shows it after the conversion finished (status "ready"),
   * and it is set while the status is still "opening" (R5).
   */
  convertingFileName: string | null;
  /** Remember the name of the file being converted, for the dialog. */
  rememberConvertingSource: (name: string) => void;
  /** Called from the cancel button while converting. */
  cancelConversion: () => void;
  /** Copy the breakdown text of the selected layer to the clipboard. True if it succeeded (a failure is only logged). */
  copyConversionBreakdownText: () => Promise<boolean>;
}

export function useConversionSession({
  sourceRef,
  toolRunningRef,
  selectedBreakdownText,
}: ConversionSessionDeps): ConversionSession {
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  const [convertingFileName, setConvertingFileName] = useState<string | null>(null);

  const rememberConvertingSource = useCallback((name: string) => setConvertingFileName(name), []);
  const clearConversionProgress = useCallback(() => setConversionProgress(null), []);

  const reportConversionProgress = useCallback(
    (progress: ConversionProgress) => {
      // A point-cloud tool also emits the desktop progress event (L2-C). Its progress goes to the tool dialog.
      if (!toolRunningRef.current) setConversionProgress(progress);
    },
    [toolRunningRef],
  );

  const cancelConversion = useCallback(() => sourceRef.current?.cancelConversion(), [sourceRef]);

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
    reportConversionProgress,
    clearConversionProgress,
    convertingFileName,
    rememberConvertingSource,
    cancelConversion,
    copyConversionBreakdownText,
  };
}
