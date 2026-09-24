import type { UpdateCheckState } from "../../state/useUpdateCheck";
import { glassSurfaceClass } from "./glass";

/**
 * M3-2 / M3-4: 新しいバージョンがあるときだけ出す通知。デスクトップ・Android共通
 * (適用手段の違いは`useUpdateCheck`の`openRelease`内に閉じている。このコンポーネント
 * はプラットフォームを意識しない)。
 *
 * インストールが利用者の手作業であることを明記する(ADR-0004: 自動では適用しない)。
 */
export function UpdateNotice({ update, glassEnabled }: { update: UpdateCheckState; glassEnabled: boolean }) {
  if (update.status !== "available" || !update.latest) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        className={`pointer-events-auto flex w-full max-w-md flex-col gap-2 rounded-xl p-4 shadow-xl ${glassSurfaceClass(glassEnabled)}`}
      >
        <p className="text-sm font-semibold">新しいバージョンがあります: {update.latest.tagName}</p>
        {update.latest.body && (
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs opacity-80">
            {update.latest.body}
          </p>
        )}
        <p className="text-xs opacity-70">
          ダウンロードとインストールは手作業です（自動では適用されません）。「リリースページを開く」から
          Windowsはインストーラ、Androidの場合はAPKを取得してください（サイドロード）。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={update.dismiss}
            className="rounded px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          >
            後で
          </button>
          <button
            type="button"
            onClick={() => {
              update.openRelease().catch((e: unknown) => console.error("openRelease failed", e));
            }}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-slate-900"
          >
            リリースページを開く
          </button>
        </div>
      </div>
    </div>
  );
}
