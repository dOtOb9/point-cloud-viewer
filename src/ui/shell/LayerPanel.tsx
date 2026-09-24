import { useState } from "react";
import type { BackgroundMode, ColorMode, CopcViewerState } from "../../state/useCopcViewer";
// 規約2: `@tauri-apps/plugin-dialog`を直接importしない。DataSource側の関数
// (`pickLocalFile`)越しに呼ぶ(`src/datasource/tauri.ts`参照)。
import { pickLocalFile } from "../../datasource/tauri";
import { glassSurfaceClass } from "./glass";

const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  "solid-dark": "単色(暗)",
  "solid-light": "単色(明)",
  sky: "空",
};

/** M2-2: 着色モードの並び・ラベル。表示順はUIとして自然な優先順位
 *  (RGB→標高→強度→分類)にしてあり、`colormap.ts`の`COLOR_MODES`の並びと合わせてある。 */
const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  rgb: "RGB",
  elevation: "標高",
  intensity: "強度",
  classification: "分類",
};

// CORSとHTTP Rangeに対応した公開COPCのサンプル(TaskSheets/TEST-DATA.mdのautzen)。
// `curl -sI -H "Origin: https://example.com" -H "Range: bytes=0-1" <URL>`で
// `Access-Control-Allow-Origin: *`と`Accept-Ranges: bytes`を実際に確認した
// (2026-09-23)。ワンクリックでWeb版の動作を試せるようにするためのボタン用。
const SAMPLE_COPC_URL = "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";

interface Props {
  viewer: CopcViewerState;
  open: boolean;
  onToggleOpen: () => void;
  /** M3-8: ガラス表現(backdrop-blur)のオン/オフ。既定はモバイル判定に従う
   *  (`AppShell.tsx`参照)。切り替え自体は設定画面(SettingsModal)から行う。 */
  glassEnabled: boolean;
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
export function LayerPanel({ viewer, open, onToggleOpen, glassEnabled }: Props) {
  const [urlInput, setUrlInput] = useState("");

  return (
    <div className="pointer-events-none absolute inset-y-3 left-3 z-10 flex items-start gap-2">
      {open && (
        <section
          className={`pointer-events-auto flex w-72 max-w-[38vw] flex-col gap-4 overflow-y-auto rounded-2xl p-4 text-sm shadow-lg ${glassSurfaceClass(glassEnabled)}`}
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">レイヤー</h2>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">COPCファイル</label>
            {viewer.isBrowser ? (
              // Web版: ファイルパスという概念が無いので、ローカルファイル選択と
              // URL入力に置き換える(TaskSheets/ADR-0012-web-worker-sync-io.md参照)。
              <>
                <input
                  type="file"
                  accept=".laz,.copc.laz"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void viewer.openFile(file);
                    e.target.value = "";
                  }}
                  disabled={viewer.status === "opening"}
                  className="rounded border border-black/10 bg-white/60 px-2 py-1 text-xs text-inherit file:mr-2 file:rounded file:border-0 file:bg-slate-900/90 file:px-2 file:py-1 file:text-white dark:border-white/10 dark:bg-black/30"
                />
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="COPCのURL (CORS+Rangeが必要)"
                  className="rounded border border-black/10 bg-white/60 px-2 py-1 font-mono text-xs text-inherit dark:border-white/10 dark:bg-black/30"
                />
                <button
                  type="button"
                  onClick={() => void viewer.openFile(urlInput)}
                  disabled={viewer.status === "opening" || urlInput.trim() === ""}
                  className="rounded bg-slate-900/90 px-2 py-1 text-xs text-white hover:bg-slate-900 disabled:opacity-50 dark:bg-white/90 dark:text-slate-900"
                >
                  {viewer.status === "opening" ? "開いています…" : "URLを開く"}
                </button>
                <button
                  type="button"
                  onClick={() => void viewer.openFile(SAMPLE_COPC_URL)}
                  disabled={viewer.status === "opening"}
                  className="rounded border border-black/10 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
                >
                  サンプル(autzen)を開く
                </button>
              </>
            ) : (
              // デスクトップ・Android共通: OSのファイル選択ダイアログを出す
              // (`tauri-plugin-dialog`)。Androidはパスを手入力できないため、
              // これが唯一の開き方になる(TaskSheets/M3-release-and-update.md参照)。
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const picked = await pickLocalFile();
                    if (picked) void viewer.openFile(picked);
                  })();
                }}
                disabled={viewer.status === "opening"}
                className="rounded bg-slate-900/90 px-2 py-1 text-xs text-white hover:bg-slate-900 disabled:opacity-50 dark:bg-white/90 dark:text-slate-900"
              >
                {viewer.status === "opening" ? "開いています…" : "ファイルを選ぶ…"}
              </button>
            )}
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

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">着色</label>
            <select
              value={viewer.colorMode}
              onChange={(e) => viewer.setColorMode(e.target.value as ColorMode)}
              className="rounded border border-black/10 bg-white/60 px-2 py-1 text-xs text-inherit dark:border-white/10 dark:bg-black/30"
            >
              {(Object.keys(COLOR_MODE_LABELS) as ColorMode[]).map((mode) => {
                // RGBを持たないファイルではRGBを選べないようにする(受け入れ条件)。
                // hasColorが分からない(まだファイルを開いていない)間はグレーアウトしない
                // (falseと決めつけず、選べる状態にしておく)。
                const disabled = mode === "rgb" && viewer.cloudInfo !== null && !viewer.cloudInfo.hasColor;
                return (
                  <option
                    key={mode}
                    value={mode}
                    disabled={disabled}
                    title={disabled ? "このファイルはRGBを持たない" : undefined}
                  >
                    {COLOR_MODE_LABELS[mode]}
                    {disabled ? "（RGB無し）" : ""}
                  </option>
                );
              })}
            </select>
            {viewer.cloudInfo !== null && !viewer.cloudInfo.hasColor && viewer.colorMode === "elevation" && (
              <p className="text-xs opacity-60">このファイルはRGBを持たないため、標高で着色しています</p>
            )}
          </div>

          {/* M3-8: EDLの切り替えは、レンダースケール・点の形・ガラス・点予算上限と
              並べて設定画面(SettingsModal)の「モバイル最適化」節に移した。
              5つの手段を1箇所にまとめ、モバイル判定の結果と一緒に表示するため
              (タスクシートの要求)。 */}
        </section>
      )}

      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        title={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        className={`pointer-events-auto rounded-full px-2 py-2 text-xs shadow-lg ${glassSurfaceClass(glassEnabled)}`}
      >
        {open ? "◀" : "▶"}
      </button>
    </div>
  );
}
