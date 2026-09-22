import { useRef } from "react";
import { useWebGpuProbe } from "../state/useWebGpuProbe";

/** M0-2: WebGPU 可否プローブの結果と描画テスト結果を表示するパネル。 */
export function WebGpuProbePanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const probe = useWebGpuProbe(canvasRef);

  return (
    <section className="flex flex-col items-center gap-3">
      <canvas
        ref={canvasRef}
        id="viewport"
        className="rounded border border-slate-700 bg-black"
        width={640}
        height={360}
      />
      <div className="w-[640px] rounded border border-slate-700 bg-slate-800 p-3 font-mono text-xs">
        {probe.status === "probing" && <p>WebGPU を確認中…</p>}
        {probe.status === "done" && probe.result?.supported && (
          <div className="text-emerald-400">
            <p>WebGPU: 対応</p>
            <p>vendor: {probe.result.vendor}</p>
            <p>architecture: {probe.result.architecture}</p>
            <p>device: {probe.result.device}</p>
            <p>description: {probe.result.description}</p>
            <p>drawnWith: {probe.drawnWith}</p>
          </div>
        )}
        {probe.status === "done" && probe.result && !probe.result.supported && (
          <div className="text-amber-400">
            <p>WebGPU: 非対応</p>
            <p>reason: {probe.result.reason}</p>
            <p>drawnWith: {probe.drawnWith}</p>
          </div>
        )}
      </div>
    </section>
  );
}
