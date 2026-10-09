import { useState } from "react";
import type { GpuErrorEntry } from "../../state/useCopcViewer";
import { Dialog } from "./Dialog";
import { DIALOG_BUTTON_CLASS, DIALOG_PRIMARY_BUTTON_CLASS } from "./dialog-styles";

const SOURCE_LABEL: Record<GpuErrorEntry["source"], string> = {
  gpu: "WebGPU エラー",
  "node-read": "ノード読み出しエラー",
  conversion: "変換エラー",
};

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** ダイアログに並べる1件分。`GpuErrorEntry`か、`viewer.error`(文字列だけ)の2種類を同じ形にする。 */
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
  /** "current": いま出ているエラー(閉じるとそれらを消す)。"history": このセッションの全履歴。 */
  mode: "current" | "history";
  onClose: () => void;
  /** 「履歴を見る」(currentモードの本文から履歴表示へ切り替える)。 */
  onShowHistory: () => void;
  current: GpuErrorEntry[];
  history: GpuErrorEntry[];
  /** `viewer.error`(画面内に出ている短いエラー文)。gpuのエントリに既に含まれていれば出さない。 */
  viewerError: string | null;
}

/**
 * ADR-0017: エラーを出す中央ダイアログ(タイトル「エラー」、フッター: コピー・閉じる)。
 *
 * ADR-0011の「画面最前面の不透明なバナー」を置き換えた(所有者の要望で、
 * 設定・変換と同じ中央ダイアログに揃えた)。ADR-0011が守った要件は引き継ぐ:
 * 本文は要約せずそのまま・複数あっても最初のエラーを隠さず縦に並べる・
 * 不透明(`Dialog`自体が不透明)・最前面(`layer="top"`)・テーマに依らず警告色の
 * タイトルバー。バナーは廃止し、代わりにステータスバーの「ログ」ボタンが
 * 履歴モードで同じダイアログを開く。
 *
 * 「閉じる」(✕・Esc含む)はcurrentモードでは現在のエラーを消す
 * (`viewer.dismissGpuError`)。履歴(`viewer.errorHistory`)は消えないので、
 * 閉じたあとでもログから読み返せる。
 */
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
            className={`${DIALOG_BUTTON_CLASS} disabled:opacity-40`}
          >
            {copied ? "コピーしました" : "コピー"}
          </button>
          <button type="button" onClick={onClose} className={DIALOG_PRIMARY_BUTTON_CLASS}>
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
              {/* 本文は要約せずそのまま表示する(ADR-0011)。選択してコピーもできる。 */}
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
