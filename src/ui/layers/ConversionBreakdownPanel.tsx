import { useState } from "react";


/**
 * M4-12(`TaskSheets/M4-import-and-conversion.md`): 変換完了後、段階ごとの
 * 所要時間を所有者がそのまま報告できるようにする内訳パネル(以前
 * `LayerPanel.tsx`にあったもの。ADR-0017でこちらへ移動。コピー機能含めて
 * そのまま)。
 */
export function ConversionBreakdownPanel({ text, onCopy }: { text: string; onCopy: () => Promise<boolean> }) {
  const [copied, setCopied] = useState(false);

  return (
    // E2E(`e2e/web-conversion.spec.ts`)がこのdata-testidで「変換の内訳」の
    // 表示を待つ。削除・リネームするときはそちらも直すこと(`CLAUDE.md`参照)。
    <div data-testid="conversion-breakdown" className="flex flex-col gap-1 rounded border border-black/10 p-2 text-xs dark:border-white/10">
      <div className="flex items-center justify-between">
        <span className="opacity-70">変換の内訳</span>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const ok = await onCopy();
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })();
          }}
          className="rounded bg-tertiary px-2 py-1 text-xs text-on-tertiary hover:opacity-90"
        >
          {copied ? "コピーしました" : "内訳をコピー"}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] opacity-80">{text}</pre>
    </div>
  );
}
