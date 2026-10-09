import { useState } from "react";
import type { GpuErrorEntry } from "../../state/useCopcViewer";

const SOURCE_LABEL: Record<GpuErrorEntry["source"], string> = {
  gpu: "WebGPU エラー",
  "node-read": "ノード読み出しエラー",
  conversion: "変換エラー",
};

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * ADR-0017 (UIシェル再構築): このセッション中に起きた全エラーを一覧する
 * ダイアログ。`GpuErrorBanner`(ADR-0011)と`StatusBar`の両方から開ける
 * (タスクシートの指定)。
 *
 * `GpuErrorBanner`が表示するのは「現在出ている(閉じていない)」エラーだけで、
 * 閉じると配列から消える(連投抑制もバナー向けの設計、`gpu-error-log.ts`参照)。
 * このダイアログは`viewer.errorHistory`(閉じても消えない履歴、
 * `useCopcViewer.ts`の`recordErrorHistory`)を見るため、所有者が「さっき
 * 閉じたエラーが何だったか」を後から確認できる。
 *
 * `GpuErrorBanner`と同じ理由(ADR-0011参照: 背景が真っ黒でも点群の上でも
 * 確実に読める必要がある)で、ADR-0005のガラス面は使わず不透明にする
 * (`SettingsModal`と同じ不透明パターン)。
 */
export function ErrorLogDialog({ open, onClose, errors }: { open: boolean; onClose: () => void; errors: GpuErrorEntry[] }) {
  const [copiedAll, setCopiedAll] = useState(false);

  if (!open) return null;

  const fullText = errors
    .map((e) => `[${formatTimestamp(e.firstAt)}] ${SOURCE_LABEL[e.source]}${e.count > 1 ? `（${e.count}回）` : ""}\n${e.message}`)
    .join("\n\n");

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">エラーログ（このセッション）</h2>
          <button type="button" onClick={onClose} aria-label="エラーログを閉じる" className="rounded px-2 py-1 text-sm hover:bg-black/5 dark:hover:bg-white/10">
            閉じる
          </button>
        </div>

        {errors.length === 0 ? (
          <p className="text-sm opacity-70">このセッションではまだエラーが起きていません。</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(fullText);
                    setCopiedAll(true);
                    setTimeout(() => setCopiedAll(false), 2000);
                  } catch (e: unknown) {
                    console.error("copy error log failed", e);
                  }
                })();
              }}
              className="self-start rounded bg-slate-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-slate-900"
            >
              {copiedAll ? "コピーしました" : "全件コピー"}
            </button>
            <ul className="flex flex-col gap-3">
              {errors.map((error) => (
                <li key={error.id} className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
                  <p className="font-semibold opacity-70">
                    {SOURCE_LABEL[error.source]}
                    {error.count > 1 ? `（同じエラーが${error.count}回発生）` : ""}
                  </p>
                  <p className="opacity-60">
                    最初: {formatTimestamp(error.firstAt)} / 最後: {formatTimestamp(error.lastAt)}
                  </p>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{error.message}</pre>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
