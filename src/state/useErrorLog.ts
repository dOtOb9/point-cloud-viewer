// Error log state: the errors shown in the banner (`gpuErrors`), the session history that survives
// dismissing (`errorHistory`), and one function to report a new error.
// Owns: a GpuErrorLog (renderer/gpu-error-log.ts, the pure class that merges repeated messages) and two React states.
// Used by: useCopcViewer.ts creates it once; every other hook gets `reportError` and calls it.
// Entry: `useErrorLog()`.
import { useCallback, useRef, useState } from "react";
import { GpuErrorLog, type GpuErrorEntry, type GpuErrorSource } from "../renderer/gpu-error-log";
import { mergeErrorHistory } from "./error-history";

export interface ErrorLog {
  /** Errors the banner shows now. A dismissed one leaves this list. */
  gpuErrors: GpuErrorEntry[];
  /** Every error of this session, including dismissed ones (ADR-0017). Only grows. */
  errorHistory: GpuErrorEntry[];
  /** Put a message in the banner and the history (ADR-0011). `source` defaults to "gpu". The text is shown as it is. */
  reportError: (message: string, source?: GpuErrorSource) => void;
  /** Remove one entry from the banner. The history keeps it. */
  dismissGpuError: (id: number) => void;
}

export function useErrorLog(): ErrorLog {
  // GpuErrorLog is not React state. It is kept in a ref, and after each change a snapshot
  // (`list()`) is copied into state so that React re-renders.
  const logRef = useRef(new GpuErrorLog());
  const [gpuErrors, setGpuErrors] = useState<GpuErrorEntry[]>([]);
  const [errorHistory, setErrorHistory] = useState<GpuErrorEntry[]>([]);

  const reportError = useCallback((message: string, source?: GpuErrorSource) => {
    logRef.current.report(message, undefined, source);
    const current = logRef.current.list();
    setGpuErrors(current);
    setErrorHistory((previous) => mergeErrorHistory(previous, current));
  }, []);

  // Dismiss does not touch the history; that is the reason the history exists.
  const dismissGpuError = useCallback((id: number) => {
    logRef.current.dismiss(id);
    setGpuErrors(logRef.current.list());
  }, []);

  return { gpuErrors, errorHistory, reportError, dismissGpuError };
}
