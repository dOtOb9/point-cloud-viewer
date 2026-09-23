import type { ThemePreference, ThemeState } from "../../state/useTheme";
import { IpcBenchPanel } from "../IpcBenchPanel";
import { NodeConcurrencyBenchPanel } from "../NodeConcurrencyBenchPanel";
import { WebGpuProbePanel } from "../WebGpuProbePanel";

interface Props {
  open: boolean;
  onClose: () => void;
  theme: ThemeState;
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
export function SettingsModal({ open, onClose, theme }: Props) {
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

        <details className="flex flex-col gap-3">
          <summary className="cursor-pointer text-sm font-semibold opacity-70">
            診断パネル (M0: WebGPU probe / IPC bench)
          </summary>
          <div className="mt-3 flex flex-col items-center gap-4">
            <WebGpuProbePanel />
            <IpcBenchPanel />
            <NodeConcurrencyBenchPanel />
          </div>
        </details>
      </div>
    </div>
  );
}
