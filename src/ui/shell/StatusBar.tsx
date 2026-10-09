import type { CopcViewerState } from "../../state/useCopcViewer";
import { glassSurfaceClass } from "./glass";

/**
 * ADR-0017 (UIシェル再構築): 画面下部の「ステータスバー」。1行だけ。
 *
 * タスクシートの指定: 表示点数/点予算、fps、CRS、読み込み進捗。
 * デスクトップの点群/GIS系ソフトのステータスバーを参照に、詳細は出さず
 * 見出しの数値だけをここに置く(詳細はLayerStatsDetails.tsxの折りたたみへ)。
 *
 * エラーログを開くボタンもここに置く(タスクシートの指定:
 * 「opened from the banner and from the status bar」)。このセッションで
 * 1件以上エラーが起きていれば件数を出す(0件のときは目立たせない)。
 */
export function StatusBar({
  viewer,
  glassEnabled,
  onOpenErrorLog,
  onOpenConversion,
}: {
  viewer: CopcViewerState;
  glassEnabled: boolean;
  onOpenErrorLog: () => void;
  onOpenConversion: () => void;
}) {
  const stats = viewer.stats;

  // 読み込み進捗: 変換中は変換の割合、それ以外はストリーミング読み込みの
  // ロード中/キュー待ちノード数を出す(「進捗」の意味がこの2つに分かれる
  // ため、状態に応じて出し分ける)。
  let loadProgressLabel: string;
  if (viewer.status === "converting" && viewer.conversionProgress?.phase === "reading") {
    const pct = (viewer.conversionProgress.pointsRead / Math.max(1, viewer.conversionProgress.totalPoints)) * 100;
    loadProgressLabel = `変換中 ${pct.toFixed(0)}%`;
  } else if (viewer.status === "converting") {
    loadProgressLabel = "変換中…";
  } else if (stats && (stats.loadingNodes > 0 || stats.queuedNodes > 0)) {
    loadProgressLabel = `読込中 ${stats.loadingNodes} / 待機 ${stats.queuedNodes}`;
  } else {
    loadProgressLabel = "待機なし";
  }

  return (
    <div
      className={`pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex min-h-11 items-center gap-3 overflow-hidden px-3 py-1.5 text-xs shadow-lg md:gap-4 ${glassSurfaceClass(glassEnabled)}`}
    >
      {/* 狭幅(<768px)では1行に収めるため、見出しを省いて短くする(md以上は従来の文言)。 */}
      <span className="whitespace-nowrap">
        <span className="hidden md:inline">表示点数: </span>
        <span className="md:hidden">点 </span>
        {stats ? stats.drawnPoints.toLocaleString() : "―"} / <span className="hidden md:inline">予算: </span>
        {viewer.pointBudget.toLocaleString()}
      </span>
      <span className="whitespace-nowrap">fps: {stats ? stats.fps.toFixed(0) : "―"}</span>
      {/* CRS: LayerInfoSection.tsxと同じ理由で「不明（未配線）」。
          CloudInfoにCRSが無いため、ここも同じ文言で揃える。狭幅では省く(詳細は左パネルで見られる)。 */}
      <span className="hidden whitespace-nowrap md:inline">CRS: 不明（未配線）</span>
      {viewer.status === "converting" ? (
        // 変換中はクリックで変換ダイアログを開き直せる(✕で閉じても変換は続くため)。
        <button type="button" onClick={onOpenConversion} className="min-h-11 min-w-0 truncate underline">
          {loadProgressLabel}
        </button>
      ) : (
        <span className="min-w-0 truncate">{loadProgressLabel}</span>
      )}
      <button
        type="button"
        onClick={onOpenErrorLog}
        className="ml-auto min-h-11 min-w-11 shrink-0 whitespace-nowrap rounded px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/10"
      >
        ログ{viewer.errorHistory.length > 0 ? `（${viewer.errorHistory.length}）` : ""}
      </button>
    </div>
  );
}
