import type { CopcViewerState } from "../../state/useCopcViewer";

function fmt3(v: readonly [number, number, number]): string {
  return `[${v.map((x) => x.toFixed(2)).join(", ")}]`;
}

/**
 * ADR-0017 (UIシェル再構築): 以前`InfoPanel.tsx`にあった詳細統計
 * (描画点数/ロード状況/fps、モバイル最適化の現在値、カメラ姿勢)を
 * そのまま移した。機能は削っていない。
 *
 * 右パネル(InfoPanel)自体は今回の再構築で廃止した(新しいレイアウトは
 * 「上部リボン+左レイヤーツリー+下部ステータスバー」で、右パネルが無い。
 * タスクシート参照)。fps・描画点数のヘッドライン値はステータスバー
 * (`StatusBar.tsx`)に出すが、ここにある詳細(ロード中/キュー/キャッシュの
 * ノード数、カメラのpitch/yaw/upAxis/eye、モバイル最適化の現在値)は
 * 1行のステータスバーには収まらないため、左パネルの折りたたみ式
 * (`<details>`)として残した(「既存の機能を全て到達可能にする」という
 * タスクシートの要求のため)。既定で閉じておき、普段は目に入らないように
 * している。
 */
export function LayerStatsDetails({ viewer }: { viewer: CopcViewerState }) {
  if (!viewer.stats) return null;
  const stats = viewer.stats;

  return (
    <details className="flex flex-col gap-2 border-t border-black/10 pt-2 text-xs font-mono dark:border-white/10">
      <summary className="cursor-pointer font-sans text-xs font-semibold uppercase tracking-wide opacity-70">詳細統計</summary>

      <div className="flex flex-col gap-0.5">
        <p>nodes: {viewer.nodeCount}</p>
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
