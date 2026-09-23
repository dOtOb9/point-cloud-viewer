import { useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
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
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "OSに合わせる",
  dark: "ダーク",
  light: "ライト",
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
export function SettingsModal({ open, onClose, theme, update, viewer }: Props) {
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
