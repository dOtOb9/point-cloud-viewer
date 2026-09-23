import type { CopcViewerState } from "../../state/useCopcViewer";
import { GLASS_SURFACE } from "./glass";

interface Props {
  viewer: CopcViewerState;
  open: boolean;
  onToggleOpen: () => void;
}

function fmt3(v: readonly [number, number, number]): string {
  return `[${v.map((x) => x.toFixed(2)).join(", ")}]`;
}

/**
 * M2-3 (ADR-0005): 画面右の「情報パネル」。以前ViewerPanelのHUDに直書きしていた
 * cloudInfo・RenderStats(描画点数/ロード状況/fps)・カメラ姿勢の表示をそのまま
 * ここへ移した(機能は減らしていない。`npm run tauri dev`のstdoutへの出力は
 * src/state/useCopcViewer.tsに残したまま変えていない)。
 *
 * 折りたたみ可能: LayerPanelと対称の構成(開閉ボタンは常に残す)。
 */
export function InfoPanel({ viewer, open, onToggleOpen }: Props) {
  return (
    <div className="pointer-events-none absolute inset-y-3 right-3 z-10 flex items-start gap-2">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? "情報パネルを畳む" : "情報パネルを開く"}
        title={open ? "情報パネルを畳む" : "情報パネルを開く"}
        className={`pointer-events-auto rounded-full px-2 py-2 text-xs shadow-lg ${GLASS_SURFACE}`}
      >
        {open ? "▶" : "◀"}
      </button>

      {open && (
        <section
          className={`pointer-events-auto flex w-72 max-w-[38vw] flex-col gap-3 overflow-y-auto rounded-2xl p-4 font-mono text-xs shadow-lg ${GLASS_SURFACE}`}
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">情報</h2>

          {viewer.cloudInfo ? (
            <div className="flex flex-col gap-0.5">
              <p>points: {viewer.cloudInfo.pointCount.toLocaleString()}</p>
              <p>nodes: {viewer.nodeCount}</p>
              <p>hasColor: {String(viewer.cloudInfo.hasColor)}</p>
            </div>
          ) : (
            <p className="opacity-70">まだファイルを開いていません</p>
          )}

          {viewer.stats && (
            <div className="flex flex-col gap-0.5 border-t border-black/10 pt-2 dark:border-white/10">
              <p>
                drawn: {viewer.stats.drawnPoints.toLocaleString()} pts / {viewer.stats.drawnNodes} nodes
              </p>
              <p>
                loading: {viewer.stats.loadingNodes} / queued: {viewer.stats.queuedNodes} / cached:{" "}
                {viewer.stats.cachedNodes}
              </p>
              <p>fps: {viewer.stats.fps.toFixed(1)}</p>
              <p>pointBudget: {viewer.stats.pointBudget.toLocaleString()}</p>
            </div>
          )}

          {viewer.stats && (
            <div className="flex flex-col gap-0.5 border-t border-black/10 pt-2 dark:border-white/10">
              <p className="opacity-70">カメラ</p>
              <p>
                pitch: {viewer.stats.cameraPitch.toFixed(3)} / yaw: {viewer.stats.cameraYaw.toFixed(3)}
              </p>
              <p>upAxis: {fmt3(viewer.stats.cameraUpAxis)}</p>
              <p>eye: {fmt3(viewer.stats.cameraEye)}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
