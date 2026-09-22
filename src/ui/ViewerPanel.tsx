import { useState } from "react";
import { useCopcViewer, type BackgroundMode } from "../state/useCopcViewer";

const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  "solid-dark": "単色(暗)",
  "solid-light": "単色(明)",
  sky: "空",
};

/**
 * M1: COPCビューア本体。canvasはrenderer(PointCloudRenderer)がWebGPUで直接描画する
 * （Reactは再レンダリングしない）。UIはuseCopcViewer経由でしかrendererに触らない
 * （規約3）。
 */
export function ViewerPanel() {
  const [canvasRef, viewer] = useCopcViewer();
  const [pathInput, setPathInput] = useState("");

  return (
    <section className="relative h-[70vh] w-full overflow-hidden rounded border border-slate-700 bg-black">
      <canvas ref={canvasRef} className="h-full w-full" />

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded bg-slate-900/80 p-2 text-xs">
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="開くCOPCファイルの絶対パス (.laz)"
            className="w-96 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-slate-100"
          />
          <button
            type="button"
            onClick={() => void viewer.openFile(pathInput)}
            disabled={viewer.status === "opening" || pathInput.trim() === ""}
            className="rounded bg-slate-700 px-3 py-1 hover:bg-slate-600 disabled:opacity-50"
          >
            {viewer.status === "opening" ? "開いています…" : "開く"}
          </button>
          <label className="ml-4 flex items-center gap-2 text-slate-300">
            点予算
            <input
              type="number"
              min={1000}
              step={100_000}
              value={viewer.pointBudget}
              onChange={(e) => viewer.setPointBudget(Number(e.target.value) || 0)}
              className="w-28 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-slate-100"
            />
          </label>
          <label className="ml-4 flex items-center gap-2 text-slate-300">
            背景
            <select
              value={viewer.backgroundMode}
              onChange={(e) => viewer.setBackgroundMode(e.target.value as BackgroundMode)}
              className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-slate-100"
            >
              {(Object.keys(BACKGROUND_MODE_LABELS) as BackgroundMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {BACKGROUND_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="ml-4 flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={viewer.gridEnabled}
              onChange={(e) => viewer.setGridEnabled(e.target.checked)}
            />
            グリッド
          </label>
        </div>

        {viewer.error && (
          <div className="pointer-events-auto rounded bg-red-900/80 p-2 text-xs text-red-200">
            {viewer.error}
          </div>
        )}

        <div className="pointer-events-auto self-start rounded bg-slate-900/80 p-2 font-mono text-xs text-slate-200">
          {viewer.cloudInfo ? (
            <>
              <p>
                points: {viewer.cloudInfo.pointCount.toLocaleString()} / nodes: {viewer.nodeCount}
              </p>
              <p>hasColor: {String(viewer.cloudInfo.hasColor)}</p>
            </>
          ) : (
            <p>まだファイルを開いていません</p>
          )}
          {viewer.stats && (
            <>
              <p>
                drawn: {viewer.stats.drawnPoints.toLocaleString()} pts / {viewer.stats.drawnNodes} nodes
              </p>
              <p>
                loading: {viewer.stats.loadingNodes} / queued: {viewer.stats.queuedNodes} / cached:{" "}
                {viewer.stats.cachedNodes}
              </p>
              <p>fps: {viewer.stats.fps.toFixed(1)}</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
