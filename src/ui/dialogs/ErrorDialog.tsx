import { useState } from "react";
import type { GpuErrorEntry } from "../../renderer/gpu-error-log";
import { Dialog } from "./Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

const SOURCE_LABEL: Record<GpuErrorEntry["source"], string> = {
  gpu: "WebGPU エラー",
  "node-read": "ノード読み出しエラー",
  conversion: "変換エラー",
  crs: "座標系の読み取りエラー",
  tool: "点群ツール",
  "file-dialog": "ファイル選択ダイアログのエラー",
};

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

interface Item {
  key: string;
  heading: string;
  message: string;
  detail?: string;
}

function itemsFrom(entries: GpuErrorEntry[], withTime: boolean): Item[] {
  return entries.map((e) => ({
    key: String(e.id),
    heading: `${SOURCE_LABEL[e.source]}${e.count > 1 ? `（同じエラーが${e.count}回発生）` : ""}`,
    message: e.message,
    detail: withTime ? `最初: ${formatTimestamp(e.firstAt)} / 最後: ${formatTimestamp(e.lastAt)}` : undefined,
  }));
}

interface Props {
  open: boolean;
  mode: "current" | "history";
  onClose: () => void;
  onShowHistory: () => void;
  current: GpuErrorEntry[];
  history: GpuErrorEntry[];
  viewerError: string | null;
}

export function ErrorDialog({ open, mode, onClose, onShowHistory, current, history, viewerError }: Props) {
  const [copied, setCopied] = useState(false);

  const showHistory = mode === "history";
  const items: Item[] = showHistory ? itemsFrom(history, true) : itemsFrom(current, false);
  if (!showHistory && viewerError !== null && !current.some((e) => e.message.includes(viewerError))) {
    items.push({ key: "viewer-error", heading: "エラー", message: viewerError });
  }

  const fullText = items.map((i) => `${i.heading}\n${i.message}`).join("\n\n");

  return (
    <Dialog
      open={open}
      title={showHistory ? "エラーログ（このセッション）" : "エラー"}
      onClose={onClose}
      layer="top"
      tone="error"
      accent="error"
      widthClass="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(fullText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch (e: unknown) {
                  console.error("copy error text failed", e);
                }
              })();
            }}
            disabled={items.length === 0}
            className={`${DIALOG_TERTIARY_BUTTON_CLASS} disabled:opacity-40`}
          >
            {copied ? "コピーしました" : "コピー"}
          </button>
          <button type="button" onClick={onClose} className={DIALOG_TERTIARY_BUTTON_CLASS}>
            閉じる
          </button>
        </>
      }
    >
      {items.length === 0 ? (
        <p className="text-sm opacity-70">{showHistory ? "このセッションではまだエラーが起きていません。" : "現在のエラーはありません。"}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.key} className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
              <p className="font-semibold">{item.heading}</p>
              {item.detail && <p className="opacity-60">{item.detail}</p>}
              <pre className="mt-1 select-text whitespace-pre-wrap break-words font-mono">{item.message}</pre>
            </li>
          ))}
        </ul>
      )}
      {!showHistory && (
        <button type="button" onClick={onShowHistory} className="self-start text-xs underline opacity-70">
          このセッションのエラー履歴を見る
        </button>
      )}
    </Dialog>
  );
}
