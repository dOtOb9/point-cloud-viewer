import type { CopcViewerState } from "../../../state/useCopcViewer";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

/** バイトを「約X.XGiB」の形にする(小数1桁)。UI は datasource を直接触らない規約のため、表示専用の整形はここに閉じる。 */
function toGiBLabel(bytes: number): string {
  return `約${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

/** ブラウザの保存領域(OPFS。Webだけ)。使用量の内訳と、キャッシュ・一時ファイルの削除。 */
export function StorageDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  const info = viewer.opfsStorageInfo;
  return (
    <SettingsPageDialog {...page} title="ブラウザの保存領域" widthClass="max-w-2xl">
      <p className="text-xs opacity-60">
        変換したデータと一時ファイルをブラウザに保存している。「空き容量が足りません」が出たら、ここで消すと空く。
      </p>

      {info === null ? (
        <p className="text-xs opacity-60">読み込み中…</p>
      ) : (
        <>
          <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
            <p>
              使用中: <span className="font-mono">{toGiBLabel(info.usageBytes)}</span> / 上限:{" "}
              <span className="font-mono">{toGiBLabel(info.quotaBytes)}</span>
            </p>
            <p className="mt-1">
              永続的な保存: <span className="font-mono">{info.persisted ? "許可済み" : "未許可"}</span>
              {!info.persisted && (
                <button
                  type="button"
                  onClick={() => void viewer.requestOpfsPersistentStorage()}
                  className="ml-2 rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-600"
                >
                  許可を求める
                </button>
              )}
            </p>
            <p className="mt-1 opacity-60">
              Chrome/Edge/Safariはサイトの利用状況から自動で判定し、確認は出ない。Firefoxは確認の
              ポップアップが出る(出典: MDN「Storage quotas and eviction criteria」の
              “Does browser-stored data persist?”節。詳細は TaskSheets/M4-import-and-conversion.mdのM4-6追記を参照)。
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
            <div className="flex items-center justify-between">
              <p className="font-semibold opacity-70">
                変換済みキャッシュ({info.breakdown.cachedConversions.length}件、
                {toGiBLabel(info.breakdown.cachedConversionsTotalBytes)})
              </p>
              {info.breakdown.cachedConversions.length > 0 && (
                <button
                  type="button"
                  onClick={() => void viewer.clearOpfsCachedConversions()}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-600"
                >
                  すべて消す
                </button>
              )}
            </div>
            {info.breakdown.cachedConversions.length === 0 ? (
              <p className="mt-1 opacity-60">無し</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {info.breakdown.cachedConversions.map((entry) => (
                  <li key={entry.outputName} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono" title={entry.sourceName}>
                      {entry.sourceName}
                    </span>
                    <span className="shrink-0 whitespace-nowrap opacity-70">{toGiBLabel(entry.sizeBytes)}</span>
                    <button
                      type="button"
                      onClick={() => void viewer.removeOpfsCachedConversion(entry)}
                      className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-600"
                    >
                      消す
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
            <div className="flex items-center justify-between">
              <p className="font-semibold opacity-70">
                残っている一時ファイル({info.breakdown.staleScratchDirs.length}件、
                {toGiBLabel(info.breakdown.staleScratchTotalBytes)})
              </p>
              {info.breakdown.staleScratchDirs.length > 0 && (
                <button
                  type="button"
                  onClick={() => void viewer.clearOpfsScratchDirs()}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-600"
                >
                  すべて消す
                </button>
              )}
            </div>
            <p className="mt-1 opacity-60">
              タブを閉じる・クラッシュする等で後始末できなかった変換の一時ファイル。使用中の変換のものは
              消せない(失敗しても実害は無い)。
            </p>
            {info.breakdown.staleScratchDirs.length === 0 ? (
              <p className="mt-1 opacity-60">無し</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {info.breakdown.staleScratchDirs.map((dir) => (
                  <li key={dir.name} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono" title={dir.name}>
                      {dir.name}
                    </span>
                    <span className="shrink-0 whitespace-nowrap opacity-70">{toGiBLabel(dir.sizeBytes)}</span>
                    <button
                      type="button"
                      onClick={() => void viewer.removeOpfsScratchDir(dir.name)}
                      className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-600"
                    >
                      消す
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="button"
            onClick={() => void viewer.refreshOpfsStorageInfo()}
            className="self-start rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
          >
            更新
          </button>
        </>
      )}
    </SettingsPageDialog>
  );
}
