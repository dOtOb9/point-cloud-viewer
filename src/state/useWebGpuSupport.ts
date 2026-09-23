import { useEffect, useState } from "react";
import { probeWebGpu, type WebGpuProbeResult } from "../renderer/webgpu-probe";

export type WebGpuSupportState =
  | { status: "checking" }
  | { status: "done"; result: WebGpuProbeResult };

/**
 * M3-5: WebGPUが使えるかどうかだけを確認する軽量版。
 *
 * `useWebGpuProbe`(M0、設定画面の診断パネル用)は三角形の描画テストまで行うが、
 * こちらはAppShellが「そもそもアプリ本体を出してよいか」を判断するためのゲートとして
 * 使うだけなので、描画は行わずnavigator.gpu / requestAdapter()の確認だけを行う。
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
