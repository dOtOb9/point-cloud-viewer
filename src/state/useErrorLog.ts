import { useCallback, useRef, useState } from "react";
import { GpuErrorLog, type GpuErrorEntry, type GpuErrorSource } from "../renderer/gpu-error-log";
import { mergeErrorHistory } from "./error-history";

export interface ErrorLog {
  gpuErrors: GpuErrorEntry[];
  errorHistory: GpuErrorEntry[];
  reportError: (message: string, source?: GpuErrorSource) => void;
  dismissGpuError: (id: number) => void;
}

export function useErrorLog(): ErrorLog {
  const logRef = useRef(new GpuErrorLog());
  const [gpuErrors, setGpuErrors] = useState<GpuErrorEntry[]>([]);
  const [errorHistory, setErrorHistory] = useState<GpuErrorEntry[]>([]);

  const reportError = useCallback((message: string, source?: GpuErrorSource) => {
    logRef.current.report(message, undefined, source);
    const current = logRef.current.list();
    setGpuErrors(current);
    setErrorHistory((previous) => mergeErrorHistory(previous, current));
  }, []);

  const dismissGpuError = useCallback((id: number) => {
    logRef.current.dismiss(id);
    setGpuErrors(logRef.current.list());
  }, []);

  return { gpuErrors, errorHistory, reportError, dismissGpuError };
}
