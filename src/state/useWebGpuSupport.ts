import { useEffect, useState } from "react";
import { probeWebGpu, type WebGpuProbeResult } from "../renderer/webgpu-probe";

export type WebGpuSupportState =
  | { status: "checking" }
  | { status: "done"; result: WebGpuProbeResult };

/**
 * M3-5: checks only whether WebGPU is usable.
 *
 * AppShell uses it as a gate: "may the app itself be shown at all". It draws nothing; it only checks
 * navigator.gpu and requestAdapter().
 */
export function useWebGpuSupport(): WebGpuSupportState {
  const [state, setState] = useState<WebGpuSupportState>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    probeWebGpu().then((result) => {
      if (!cancelled) setState({ status: "done", result });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
