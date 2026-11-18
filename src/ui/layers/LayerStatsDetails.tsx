import type { CopcViewerState } from "../../state/useCopcViewer";

function fmt3(v: readonly [number, number, number]): string {
  return `[${v.map((x) => x.toFixed(2)).join(", ")}]`;
}

export function LayerStatsDetails({ viewer }: { viewer: CopcViewerState }) {
  if (!viewer.stats) return null;
  const stats = viewer.stats;

  return (
    <details className="flex flex-col gap-2 border-t border-black/10 pt-2 text-xs font-mono dark:border-white/10">
      <summary className="cursor-pointer border-l-2 border-tertiary pl-2 font-sans text-xs font-semibold uppercase tracking-wide opacity-70">詳細統計</summary>

      <div className="flex flex-col gap-0.5">
        <p>nodes: {viewer.selectedLayer?.nodeCount ?? 0}</p>
        <p>
          drawn: {stats.drawnPoints.toLocaleString()} pts / {stats.drawnNodes} nodes
        </p>
        <p>
          loading: {stats.loadingNodes} / queued: {stats.queuedNodes} / cached: {stats.cachedNodes}
        </p>
        <p>fps: {stats.fps.toFixed(1)}</p>
        <p>pointBudget: {stats.pointBudget.toLocaleString()}</p>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-black/10 pt-2 dark:border-white/10">
        <p className="font-sans opacity-70">モバイル最適化(M3-8)</p>
        <p>isMobile: {String(stats.isMobile)}</p>
        <p>renderScale: {stats.renderScale}</p>
        <p>pointShape: {stats.pointShape}</p>
        <p>pointBudgetMax: {stats.pointBudgetMax.toLocaleString()}</p>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-black/10 pt-2 dark:border-white/10">
        <p className="font-sans opacity-70">カメラ</p>
        <p>
          pitch: {stats.cameraPitch.toFixed(3)} / yaw: {stats.cameraYaw.toFixed(3)}
        </p>
        <p>upAxis: {fmt3(stats.cameraUpAxis)}</p>
        <p>eye: {fmt3(stats.cameraEye)}</p>
      </div>
    </details>
  );
}
