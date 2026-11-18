import { useEffect, useState } from "react";
import { probeWebGpu, type WebGpuProbeResult } from "../renderer/webgpu-probe";

export type WebGpuSupportState =
  | { status: "checking" }
  | { status: "done"; result: WebGpuProbeResult };

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
