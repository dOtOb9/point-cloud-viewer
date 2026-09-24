import { useState } from "react";
import type { CopcViewerState, PointShape } from "../../state/useCopcViewer";
import type { ThemePreference, ThemeState } from "../../state/useTheme";
import type { UpdateCheckState } from "../../state/useUpdateCheck";
import { IpcBenchPanel } from "../IpcBenchPanel";
import { NodeConcurrencyBenchPanel } from "../NodeConcurrencyBenchPanel";
import { WebGpuProbePanel } from "../WebGpuProbePanel";

interface Props {
  open: boolean;
  onClose: () => void;
  theme: ThemeState;
  update: UpdateCheckState;
  viewer: CopcViewerState;
  /** M3-8: ガラス表現(backdrop-blur)のオン/オフ。CopcViewerStateではなく
   *  AppShellが直接持つ値なので、他のtheme/update/viewerと同じ形で
   *  別途受け取る(AppShell.tsxのglassEnabled stateのコメント参照)。 */
  glassEnabled: boolean;
  onGlassEnabledChange: (enabled: boolean) => void;
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "OSに合わせる",
  dark: "ダーク",
  light: "ライト",
};

/** M3-8: レンダースケールの選択肢。0.5(モバイル既定)〜1.0(デスクトップ既定)の
 *  間で所有者が実機で試しやすいよう、いくつかの値をボタンで選べるようにする
 *  (自由入力にしないのは、極端な値(0や負数)を誤って入れて画面が壊れる
 *  ことを避けるため)。 */
const RENDER_SCALE_OPTIONS = [0.25, 0.5, 0.75, 1.0] as const;

const POINT_SHAPE_LABELS: Record<PointShape, string> = {
  round: "丸",
  square: "四角",
};

/**
 * M2-3 (ADR-0005): 設定モーダル。ADRの決定通り、他のパネルと違い
 * backdrop-blur/tintを使わず単色で完全に不透明にする(密なフォームは
 * 安定したコントラストが要るため。ADR-0005「却下した案: 設定画面もガラス」参照)。
 *
 * M0の診断パネル(WebGPU probe / IPC bench / node concurrency bench)は
 * 以前App.tsx直下の<details>にあったが、UIシェル導入でここへ移した
 * (機能は削っていない。折りたたみ式(<details>)なのは変わらず)。
 */
export function SettingsModal({ open, onClose, theme, update, viewer, glassEnabled, onGlassEnabledChange }: Props) {
  const [devPathInput, setDevPathInput] = useState("");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">設定</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="設定を閉じる"
            className="rounded px-2 py-1 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          >
            閉じる
          </button>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold opacity-70">テーマ</h3>
          <div className="flex gap-2">
            {(Object.keys(THEME_LABELS) as ThemePreference[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => theme.setPreference(p)}
                className={`rounded px-3 py-1.5 text-sm ${
                  theme.preference === p
                    ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                    : "border border-slate-300 dark:border-slate-600"
                }`}
              >
                {THEME_LABELS[p]}
              </button>
            ))}
          </div>
          <p className="text-xs opacity-60">
            既定は「OSに合わせる」(ADR-0005の決定通り)。実機ではOSの明暗を切り替えずに
            両テーマを確認できるよう、ここから手動固定もできる。
          </p>
          <p className="text-xs opacity-60">現在の表示: {theme.theme === "dark" ? "ダーク" : "ライト"}</p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold opacity-70">更新の確認</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={update.enabled}
              onChange={(e) => update.setEnabled(e.target.checked)}
            />
            起動時に新しいバージョンを確認する
          </label>
          <p className="text-xs opacity-60">
            確認するだけで、ダウンロードとインストールは常に利用者の手作業
            （GitHub Releasesの最新版と比較し、リリースページを開くところまで）。
            開発中(`tauri dev`)はこの設定に関わらず確認しない。
          </p>
          {update.currentVersion && (
            <p className="text-xs opacity-60">現在のバージョン: {update.currentVersion}</p>
          )}
        </section>

        <section className="flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
          <h3 className="text-sm font-semibold opacity-70">モバイル最適化 (M3-8)</h3>
          <p className="text-xs opacity-60">
            所有者の実機(OPPO Pad Air)で点予算を大きく下げないと落ちる問題を受け、GPU負荷を下げる手段を
            個別に切り替えられるようにしたもの。実機で1つずつ切り替えて、落ちずに扱える点数が変わるかを
            確かめる目的も兼ねる（詳細はTaskSheets/M3-release-and-update.md M3-8参照）。
          </p>

          <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
            <p className="font-semibold opacity-70">端末プロファイル判定</p>
            <p>
              判定結果: <span className="font-mono">{viewer.isMobile ? "モバイル" : "デスクトップ"}</span>
            </p>
            <p>
              deviceMemory:{" "}
              <span className="font-mono">
                {viewer.deviceMemoryGiB !== undefined ? `${viewer.deviceMemoryGiB} GiB` : "取得不可"}
              </span>{" "}
              / pointer:coarse: <span className="font-mono">{String(viewer.pointerCoarse)}</span>
            </p>
            <p className="mt-1 opacity-60">
              以下5つの既定値は、この判定が「モバイル」なら軽い側、「デスクトップ」なら変更前と同じ値になる。
              モバイル側の具体的な数値は未検証の初期値(TaskSheets/M3-release-and-update.md M3-8参照)。
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">
              レンダースケール（内部解像度 = 表示サイズ×devicePixelRatio×この値。既定: モバイル0.5 / デスクトップ1.0）
            </label>
            <div className="flex gap-2">
              {RENDER_SCALE_OPTIONS.map((scale) => (
                <button
                  key={scale}
                  type="button"
                  onClick={() => viewer.setRenderScale(scale)}
                  className={`rounded px-3 py-1.5 text-sm ${
                    viewer.renderScale === scale
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "border border-slate-300 dark:border-slate-600"
                  }`}
                >
                  {scale}
                </button>
              ))}
            </div>
            <p className="text-xs opacity-60">現在値: {viewer.renderScale}（再起動なしで反映される）</p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">点の形（既定: モバイル四角 / デスクトップ丸）</label>
            <div className="flex gap-2">
              {(Object.keys(POINT_SHAPE_LABELS) as PointShape[]).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  onClick={() => viewer.setPointShape(shape)}
                  className={`rounded px-3 py-1.5 text-sm ${
                    viewer.pointShape === shape
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "border border-slate-300 dark:border-slate-600"
                  }`}
                >
                  {POINT_SHAPE_LABELS[shape]}
                </button>
              ))}
            </div>
            <p className="text-xs opacity-60">
              丸は円形マスクに`discard`を使う。四角は`discard`が無いパイプラインを使うため、
              タイル方式のGPUで早期に打ち切りやすい（判断の理由はTaskSheets/M3-release-and-update.md M3-8参照）。
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={viewer.edlEnabled} onChange={(e) => viewer.setEdlEnabled(e.target.checked)} />
            EDL（陰影で凹凸を強調。既定: モバイルオフ / デスクトップオン）
          </label>
          <p className="text-xs opacity-60">
            オフのとき、点群をオフスクリーンを経由せずスワップチェーンへ直接描く1パス描画になる
            （メモリ帯域の往復を1回減らす）。
          </p>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={glassEnabled} onChange={(e) => onGlassEnabledChange(e.target.checked)} />
            UIのガラス表現（ぼかし。既定: モバイルオフ / デスクトップオン）
          </label>
          <p className="text-xs opacity-60">
            オフにすると、パネルの背景が`backdrop-filter`によるぼかしではなく不透明な単色(tint)になる。
          </p>

          <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
            <p className="font-semibold opacity-70">点予算の上限（端末のメモリから算出。既定: デスクトップ1GiB固定）</p>
            <p>
              現在の上限: <span className="font-mono">{viewer.pointBudgetMax.toLocaleString()}</span> 点
            </p>
            <p className="mt-1 opacity-60">
              モバイルではnavigator.deviceMemoryから逆算する（未検証の初期値）。この上限自体を
              手動で切り替える手段は設けていない。点予算そのものはレイヤーパネルから手動変更・自動調整の
              on/offができる。
            </p>
          </div>
        </section>

        <details className="flex flex-col gap-3">
          <summary className="cursor-pointer text-sm font-semibold opacity-70">
            診断パネル (M0: WebGPU probe / IPC bench)
          </summary>
          <div className="mt-3 flex flex-col items-center gap-4">
            <WebGpuProbePanel />
            <IpcBenchPanel />
            <NodeConcurrencyBenchPanel />
          </div>

          {/* M3: 主要UI(LayerPanel)はOSのファイル選択ダイアログに絞ったため
              (Androidではパスを手入力できない。TaskSheets/M3-release-and-update.md参照)、
              開発中に同じファイルを繰り返し開きたいときのための、パス直指定の
              抜け道をここに残す。Web版には意味が無いので出さない。 */}
          {!viewer.isBrowser && (
            <div className="mt-3 flex flex-col gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
              <h4 className="text-xs font-semibold opacity-70">開発用: パス指定で開く</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={devPathInput}
                  onChange={(e) => setDevPathInput(e.target.value)}
                  placeholder="絶対パス (.laz)"
                  className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-800"
                />
                <button
                  type="button"
                  onClick={() => void viewer.openFile(devPathInput)}
                  disabled={viewer.status === "opening" || devPathInput.trim() === ""}
                  className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
                >
                  開く
                </button>
              </div>
              <p className="text-xs opacity-60">
                OSのファイル選択ダイアログを毎回出したくない開発時用。通常の利用では
                左のレイヤーパネルの「ファイルを選ぶ…」を使う。
              </p>
            </div>
          )}
        </details>
      </div>
    </div>
  );
}
