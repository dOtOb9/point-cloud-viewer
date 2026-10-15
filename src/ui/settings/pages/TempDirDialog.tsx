import type { CopcViewerState } from "../../../state/useCopcViewer";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

/** 一時ファイルの置き場所(デスクトップだけ。出す条件は settings-nav.ts の visibleSettingsPages)。 */
export function TempDirDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="変換の一時ファイル">
      <p className="text-xs opacity-60">
        変換中に使う一時フォルダ（入力サイズの約11倍の空きが要る）。足りないときは空きのある場所を選ぶ。
      </p>
      <div className="flex items-center gap-2">
        {/* 選んだフォルダの表示だけ(入力欄ではない。変更は「選ぶ…」のOSダイアログから。ADR-0017) */}
        <p className="min-w-0 flex-1 break-all rounded border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">
          {viewer.tempDir ?? "(既定のまま)"}
        </p>
        <button type="button" onClick={() => void viewer.pickAndSetTempDir()} className="rounded bg-primary px-2 py-1 text-xs text-on-primary">
          選ぶ…
        </button>
        {viewer.tempDir !== null && (
          <button
            type="button"
            onClick={viewer.clearTempDir}
            className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
          >
            既定に戻す
          </button>
        )}
      </div>
    </SettingsPageDialog>
  );
}
