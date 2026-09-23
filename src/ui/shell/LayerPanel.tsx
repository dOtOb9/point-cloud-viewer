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
            <label className="text-xs opacity-70">点予算</label>
            <input
              type="number"
              min={1000}
              step={100_000}
              value={viewer.pointBudget}
              onChange={(e) => viewer.setPointBudget(Number(e.target.value) || 0)}
              className="rounded border border-black/10 bg-white/60 px-2 py-1 font-mono text-xs text-inherit dark:border-white/10 dark:bg-black/30"
            />
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
