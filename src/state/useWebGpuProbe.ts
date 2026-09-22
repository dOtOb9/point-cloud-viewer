import { useEffect, useState, type RefObject } from "react";
import {
  probeWebGpu,
  drawWebGpuTriangle,
  drawWebGl2Point,
  type WebGpuProbeResult,
} from "../renderer/webgpu-probe";
import { reportToBackendConsole } from "../datasource/tauri";

export type DrawnWith = "webgpu" | "webgl2" | "none";

export interface ProbeState {
  status: "probing" | "done";
  result?: WebGpuProbeResult;
  drawnWith?: DrawnWith;
}

/**
 * M0-2: WebGPU 可否プローブを実行し、結果に応じて canvas に描画する。
 * 結果は console.log に加えて Rust 側の標準出力にも送る
 * （GUI を目視できない環境でも `npm run tauri dev` の出力から判断できるようにするため）。
 */
export function useWebGpuProbe(canvasRef: RefObject<HTMLCanvasElement | null>): ProbeState {
  const [state, setState] = useState<ProbeState>({ status: "probing" });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const result = await probeWebGpu();
      if (cancelled) return;

      let drawnWith: DrawnWith = "none";
      const canvas = canvasRef.current;
      if (canvas) {
        if (result.supported) {
          drawnWith = (await drawWebGpuTriangle(canvas)) ? "webgpu" : "none";
        }
        if (drawnWith === "none") {
          drawnWith = drawWebGl2Point(canvas) ? "webgl2" : "none";
        }
      }

      const summary = result.supported
        ? `[M0-2] WebGPU supported: vendor="${result.vendor}" architecture="${result.architecture}" device="${result.device}" description="${result.description}" drawnWith=${drawnWith}`
        : `[M0-2] WebGPU NOT supported: reason="${result.reason}" drawnWith=${drawnWith}`;

      console.log(summary);
      reportToBackendConsole(summary).catch((e) =>
        console.error("reportToBackendConsole failed", e),
      );

      if (!cancelled) {
        setState({ status: "done", result, drawnWith });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // canvasRef 自体は再生成されない前提（マウント時に1回だけ実行する）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
