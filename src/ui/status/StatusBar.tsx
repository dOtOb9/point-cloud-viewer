import type { CopcViewerState } from "../../state/useCopcViewer";
import { formatCrsShort } from "../common/crs-format";
import { glassSurfaceClass } from "../common/glass";
import type { PluginHostCore } from "../../core/plugin-host";
import { PluginStatusItems } from "../plugins/PluginStatusItems";

export function StatusBar({
  viewer,
  glassEnabled,
  onOpenErrorLog,
  onOpenConversion,
  toolDialogCollapsed,
  onOpenToolProgress,
  pluginHost,
}: {
  viewer: CopcViewerState;
  glassEnabled: boolean;
  onOpenErrorLog: () => void;
  onOpenConversion: () => void;
  toolDialogCollapsed: boolean;
  onOpenToolProgress: () => void;
  pluginHost: PluginHostCore;
}) {
  const stats = viewer.stats;

  let loadProgressLabel: string;
  if (viewer.status.kind === "converting" && viewer.conversionProgress?.phase === "reading") {
    const pct = (viewer.conversionProgress.pointsRead / Math.max(1, viewer.conversionProgress.totalPoints)) * 100;
    loadProgressLabel = `変換中 ${pct.toFixed(0)}%`;
  } else if (viewer.status.kind === "converting") {
    loadProgressLabel = "変換中…";
  } else if (stats && (stats.loadingNodes > 0 || stats.queuedNodes > 0)) {
    loadProgressLabel = `読込中 ${stats.loadingNodes} / 待機 ${stats.queuedNodes}`;
  } else {
    loadProgressLabel = "待機なし";
  }

  const tool = viewer.toolProgress;
  const toolLabel =
    tool && tool.totalPoints > 0 ? `ツール実行中 ${Math.min(100, (tool.pointsRead / tool.totalPoints) * 100).toFixed(0)}%` : "ツール実行中…";

  return (
    <div
      className={`pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex min-h-11 items-center gap-3 overflow-hidden px-3 py-1.5 text-xs shadow-lg md:gap-4 ${glassSurfaceClass(glassEnabled)}`}
    >
      <span className="whitespace-nowrap">
        <span className="hidden md:inline">表示点数: </span>
        <span className="md:hidden">点 </span>
        {stats ? stats.drawnPoints.toLocaleString() : "―"} / <span className="hidden md:inline">予算: </span>
        {viewer.pointBudget.toLocaleString()}
      </span>
      {stats?.idleBoosting ? (
        <span className="whitespace-nowrap" data-testid="idle-boost">
          最大まで読み込み中
        </span>
      ) : null}
      <span className="whitespace-nowrap">fps:{stats ? stats.fps.toFixed(0) : "―"}</span>
      <PluginStatusItems host={pluginHost} />
      <span className="hidden whitespace-nowrap md:inline">CRS: {viewer.selectedLayer ? formatCrsShort(viewer.selectedLayer.info.crs) : "―"}</span>
      {viewer.status.kind === "converting" ? (
        <button type="button" onClick={onOpenConversion} className="min-h-8 min-w-0 truncate rounded bg-secondary px-2 text-on-secondary">
          {loadProgressLabel}
        </button>
      ) : (
        <span className="min-w-0 truncate">{loadProgressLabel}</span>
      )}
      {tool && toolDialogCollapsed ? (
        <button type="button" onClick={onOpenToolProgress} className="min-h-8 min-w-0 truncate rounded bg-secondary px-2 text-on-secondary" data-testid="tool-progress-chip">
          {toolLabel}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onOpenErrorLog}
        key={viewer.errorHistory.length}
        className={`ml-auto min-h-11 min-w-11 shrink-0 whitespace-nowrap rounded px-2 py-0.5 ${viewer.errorHistory.length > 0 ? "pcv-pulse-once bg-error text-on-error" : "hover:bg-black/5 dark:hover:bg-white/10"}`}
      >
        ログ{viewer.errorHistory.length > 0 ? `（${viewer.errorHistory.length}）` : ""}
      </button>
    </div>
  );
}
