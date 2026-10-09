import { useState } from "react";
import { Dialog } from "./Dialog";
import { DIALOG_BUTTON_CLASS, DIALOG_PRIMARY_BUTTON_CLASS } from "./dialog-styles";

/**
 * ADR-0017: 「URLから開く」ダイアログ(リモートのCOPCを開く。Web版のみ)。
 * 入力欄はURL1つだけで、パネルに常設しない(所有者の要件)。ローカルのファイルパスを
 * 打たせる欄はアプリのどこにも無い(ファイルはOSのダイアログかドラッグ&ドロップ)。
 * フッター: キャンセル・開く。EnterでもOK。
 */
export function UrlDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const trimmed = url.trim();

  const submit = () => {
    if (trimmed === "") return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Dialog
      open={open}
      title="URLから開く"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={DIALOG_BUTTON_CLASS}>
            キャンセル
          </button>
          <button type="button" onClick={submit} disabled={trimmed === ""} className={`${DIALOG_PRIMARY_BUTTON_CLASS} disabled:opacity-40`}>
            開く
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-sm">
        COPCのURL
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="https://example.com/data.copc.laz"
          className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm dark:border-slate-600 dark:bg-slate-800"
        />
      </label>
      <p className="text-xs opacity-60">サーバーがCORSとHTTP Rangeに対応している必要があります。</p>
    </Dialog>
  );
}
