import { useState } from "react";
import type { BackgroundMode, CopcViewerState } from "../../state/useCopcViewer";
import { GLASS_SURFACE } from "./glass";

const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  "solid-dark": "単色(暗)",
  "solid-light": "単色(明)",
  sky: "空",
};

interface Props {
  viewer: CopcViewerState;
  open: boolean;
  onToggleOpen: () => void;
}

/**
 * M2-3 (ADR-0005): 画面左の「レイヤーパネル」。読み込みと表示設定をまとめる場所。
 * 以前ViewerPanelのHUDに直書きしていた、ファイルパス入力・点予算・背景モード・
 * グリッドのon/offをそのままここへ移した(機能は減らしていない)。
 *
 * 点予算は並行して入ったタスクB(ADR-0009)の自動調整と組み合わさっている。
 * 自動調整中は入力を読み取り専用にして現在値だけを表示し(値は
 * `viewer.pointBudget`経由でstatsからほぼリアルタイムに追従する)、
 * チェックボックスで自動調整のon/offを切り替える。チェックを外して手動で
 * 数値を変えると`setPointBudget()`が呼ばれ、それ自体が自動調整を止める
 * (renderer側の既定動作)。このチェックボックスは`viewer.autoPointBudgetEnabled`
 * にすぐ追従するので、「手動設定すると自動調整が黙って止まる」という挙動が
 * 画面上でも同時に見える。
 *
 * 折りたたみ可能: `open=false`のときはパネル本体を消し、開閉ボタンだけを残す。
 * ボタンは常に画面内に残るので、畳んだ状態からでも必ず開き直せる。
 */
export function LayerPanel({ viewer, open, onToggleOpen }: Props) {
  const [pathInput, setPathInput] = useState("");

  return (
    <div className="pointer-events-none absolute inset-y-3 left-3 z-10 flex items-start gap-2">
      {open && (
        <section
          className={`pointer-events-auto flex w-72 max-w-[38vw] flex-col gap-4 overflow-y-auto rounded-2xl p-4 text-sm shadow-lg ${GLASS_SURFACE}`}
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">レイヤー</h2>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">COPCファイル</label>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="絶対パス (.laz)"
              className="rounded border border-black/10 bg-white/60 px-2 py-1 font-mono text-xs text-inherit dark:border-white/10 dark:bg-black/30"
            />
            <button
              type="button"
              onClick={() => void viewer.openFile(pathInput)}
              disabled={viewer.status === "opening" || pathInput.trim() === ""}
              className="rounded bg-slate-900/90 px-2 py-1 text-xs text-white hover:bg-slate-900 disabled:opacity-50 dark:bg-white/90 dark:text-slate-900"
            >
              {viewer.status === "opening" ? "開いています…" : "開く"}
            </button>
            {viewer.error && <p className="text-xs text-red-600 dark:text-red-400">{viewer.error}</p>}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-xs opacity-70">
                点予算{viewer.autoPointBudgetEnabled ? "（自動調整中）" : ""}
              </label>
            </div>
            <input
              type="number"
              min={1000}
              step={100_000}
              value={viewer.pointBudget}
              onChange={(e) => viewer.setPointBudget(Number(e.target.value) || 0)}
              disabled={viewer.autoPointBudgetEnabled}
              title={
                viewer.autoPointBudgetEnabled
                  ? "自動調整中のため読み取り専用。下のチェックを外すと手動で変更できる"
                  : undefined
              }
              className="rounded border border-black/10 bg-white/60 px-2 py-1 font-mono text-xs text-inherit disabled:opacity-60 dark:border-white/10 dark:bg-black/30"
            />
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={viewer.autoPointBudgetEnabled}
                onChange={(e) => viewer.setAutoPointBudgetEnabled(e.target.checked)}
              />
              点予算を自動調整する
            </label>
            {!viewer.autoPointBudgetEnabled && (
              <p className="text-xs opacity-60">
                手動設定中（自動調整は停止中）。チェックを入れると自動調整を再開する
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">背景</label>
            <select
              value={viewer.backgroundMode}
              onChange={(e) => viewer.setBackgroundMode(e.target.value as BackgroundMode)}
              className="rounded border border-black/10 bg-white/60 px-2 py-1 text-xs text-inherit dark:border-white/10 dark:bg-black/30"
            >
              {(Object.keys(BACKGROUND_MODE_LABELS) as BackgroundMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {BACKGROUND_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={viewer.gridEnabled}
              onChange={(e) => viewer.setGridEnabled(e.target.checked)}
            />
            グリッド
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={viewer.edlEnabled}
              onChange={(e) => viewer.setEdlEnabled(e.target.checked)}
            />
            EDL（陰影で凹凸を強調）
          </label>
        </section>
      )}

      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        title={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        className={`pointer-events-auto rounded-full px-2 py-2 text-xs shadow-lg ${GLASS_SURFACE}`}
      >
        {open ? "◀" : "▶"}
      </button>
    </div>
  );
}
