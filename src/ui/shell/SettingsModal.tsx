import { useEffect } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import type { ThemePreference, ThemeState } from "../../state/useTheme";
import type { UpdateCheckState } from "../../state/useUpdateCheck";
import { IpcBenchPanel } from "../IpcBenchPanel";
import { NodeConcurrencyBenchPanel } from "../NodeConcurrencyBenchPanel";
import { WebGpuProbePanel } from "../WebGpuProbePanel";
import { Dialog } from "./Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

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

/** M3-8: レンダースケールの選択肢。0.5(モバイル既定)〜1.0(デスクトップ既定)の
 *  間で所有者が実機で試しやすいよう、いくつかの値をボタンで選べるようにする
 *  (自由入力にしないのは、極端な値(0や負数)を誤って入れて画面が壊れる
 *  ことを避けるため)。 */
const RENDER_SCALE_OPTIONS = [0.25, 0.5, 0.75, 1.0] as const;

/** バイトを「約X.XGiB」の形にする(小数1桁)。`opfs.ts`の`describeInsufficientSpaceWeb`
 *  内部にも同じ式があるが、UI(src/ui)はdatasourceを直接触らずstate経由にする
 *  規約(`useCopcViewer.ts`冒頭のコメント群と同じ方針)のため、表示専用の
 *  この小さな整形はここに閉じる(`LayerPanel.tsx`の`formatElapsed`と同じ扱い)。 */
function toGiBLabel(bytes: number): string {
  return `約${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

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

  // M4-6追記: 設定画面を開いたときにOPFSの使用量を取り直す(開いている間
  // 消したあとも`refreshOpfsStorageInfo`を呼べば更新されるが、開いた直後の
  // 初回表示はこの効果が担う)。Tauri版は`viewer.isBrowser`がfalseなので呼ばない
  // (`refreshOpfsStorageInfo`自体もTauri版では何もしないが、呼ぶ意味が無いため
  // ここでも弾く)。フック(`useEffect`)は早期returnの前に置く必要があるため、
  // `if (!open) return null;`より先に書く。
  const { refreshOpfsStorageInfo } = viewer;
  useEffect(() => {
    if (open && viewer.isBrowser) void refreshOpfsStorageInfo();
  }, [open, viewer.isBrowser, refreshOpfsStorageInfo]);

  // AN-3: `open`がfalseでもここでは早期returnしない(閉じるアニメーションのため`Dialog`がDOMに残す。
  // `Dialog`が描画しない間は子の診断パネルも作られない)。

  // ADR-0017: 共通の`Dialog`(中央・タイトルバー・フッター)に載せる。不透明なのは
  // ADR-0005どおり(`Dialog`自体が不透明)。フッターは「閉じる」だけ。
  return (
    <Dialog
      open={open}
      title="設定"
      onClose={onClose}
      widthClass="max-w-3xl"
      footer={
        <button type="button" onClick={onClose} aria-label="設定を閉じる" className={DIALOG_TERTIARY_BUTTON_CLASS}>
          閉じる
        </button>
      }
    >
      <div className="flex flex-col gap-4">
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
                    ? "bg-primary text-on-primary"
                    : "border border-slate-300 dark:border-slate-600"
                }`}
              >
                {THEME_LABELS[p]}
              </button>
            ))}
          </div>
          <p className="text-xs opacity-60">
            画面の明るさ。「OSに合わせる」はOSの設定に従う。現在の表示: {theme.theme === "dark" ? "ダーク" : "ライト"}。
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold opacity-70">アニメーション</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="animation-toggle"
              checked={viewer.animationEnabled}
              onChange={(e) => viewer.setAnimationEnabled(e.target.checked)}
            />
            アニメーションを使う
          </label>
          <p className="text-xs opacity-60">
            画面の動きをまとめて切り替える。OSで「動きを減らす」が有効なときは常に止まる。
          </p>
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
            新しい版があるか確認するだけで、ダウンロードとインストールは自分で行う。
          </p>
          {update.currentVersion && (
            <p className="text-xs opacity-60">現在のバージョン: {update.currentVersion}</p>
          )}
        </section>

        {/* M4-3: 一時ファイルの置き場所。デスクトップだけ(Androidは起動時に
            アプリのキャッシュディレクトリへ自動で誘導される。OSのフォルダ選択
            (SAF)が返すcontent:// URIは`tempfile`が要求する実在のパスとして
            使えないため、手動選択のUIはAndroidには出さない。
            `viewer.supportsCustomTempDir`は`src-tauri/src/conversion.rs`の
            `supports_custom_temp_dir`を反映している。Web版はM4-6bでOPFS上の
            変換に対応したが、一時ファイルの置き場所はOPFS固定で選べない
            （ブラウザがユーザーに見せる実ファイルシステムパスではないため、
            この設定行自体が意味を持たない）。`viewer.isBrowser`で先に弾く）。 */}
        {!viewer.isBrowser && viewer.supportsCustomTempDir && (
          <section className="flex flex-col gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
            <h3 className="text-sm font-semibold opacity-70">変換の一時ファイル</h3>
            <p className="text-xs opacity-60">
              変換中に使う一時フォルダ（入力サイズの約11倍の空きが要る）。足りないときは空きのある場所を選ぶ。
            </p>
            <div className="flex items-center gap-2">
              {/* 選んだフォルダの表示だけ(入力欄ではない。変更は「選ぶ…」のOSダイアログから。ADR-0017) */}
              <p className="min-w-0 flex-1 break-all rounded border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">
                {viewer.tempDir ?? "(既定のまま)"}
              </p>
              <button
                type="button"
                onClick={() => void viewer.pickAndSetTempDir()}
                className="rounded bg-primary px-2 py-1 text-xs text-on-primary"
              >
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
          </section>
        )}


        {/* 描画の解像度(M3-8)。端末の判定・点予算の上限の表示は利用者に要らないので出さない(L1-A)。
            点の形・EDLはリボンの「表示」、LODの中央優先度もリボンの「読み込み優先」(ViewDialogs.tsx)にある
            (ADR-0017。式と既定値の根拠はADR-0010)。 */}
        <section className="flex flex-col gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
          <h3 className="text-sm font-semibold opacity-70">描画の解像度</h3>
          <div className="flex gap-2">
            {RENDER_SCALE_OPTIONS.map((scale) => (
              <button
                key={scale}
                type="button"
                onClick={() => viewer.setRenderScale(scale)}
                className={`rounded px-3 py-1.5 text-sm ${
                  viewer.renderScale === scale
                    ? "bg-primary text-on-primary"
                    : "border border-slate-300 dark:border-slate-600"
                }`}
              >
                {scale}
              </button>
            ))}
          </div>
          <p className="text-xs opacity-60">画面サイズに対する描画の細かさ。小さいほど軽く、大きいほど鮮明。</p>
        </section>

        {/* M4-6追記: Web版だけ(OPFSという概念がTauri版には無いため`viewer.isBrowser`
            で弾く)。所有者の実機不具合「空き容量が足りません」の対処として、
            OPFSの使用量の内訳(変換済みキャッシュ・残っている一時ファイル)を見せ、
            個別に・まとめて消せるようにする。密なフォーム(一覧+削除ボタン)なので
            設定画面に置く(ADR-0005: 設定画面はガラスにしない方針と同じ理由。
            容量不足のエラーバナー側は一覧UIを持たない1行のメッセージなので、
            そちらには「ここで消せる」という案内文だけを出す。
            `useCopcViewer.ts`の`describeInsufficientSpaceWeb`参照)。 */}
        {viewer.isBrowser && (
          <section className="flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
            <h3 className="text-sm font-semibold opacity-70">ブラウザの保存領域</h3>
            <p className="text-xs opacity-60">
              変換したデータと一時ファイルをブラウザに保存している。「空き容量が足りません」が出たら、ここで消すと空く。
            </p>

            {viewer.opfsStorageInfo === null ? (
              <p className="text-xs opacity-60">読み込み中…</p>
            ) : (
              <>
                <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
                  <p>
                    使用中: <span className="font-mono">{toGiBLabel(viewer.opfsStorageInfo.usageBytes)}</span>
                    {" "}/ 上限: <span className="font-mono">{toGiBLabel(viewer.opfsStorageInfo.quotaBytes)}</span>
                  </p>
                  <p className="mt-1">
                    永続的な保存:{" "}
                    <span className="font-mono">{viewer.opfsStorageInfo.persisted ? "許可済み" : "未許可"}</span>
                    {!viewer.opfsStorageInfo.persisted && (
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
                    “Does browser-stored data persist?”節。詳細は
                    TaskSheets/M4-import-and-conversion.mdのM4-6追記を参照)。
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold opacity-70">
                      変換済みキャッシュ({viewer.opfsStorageInfo.breakdown.cachedConversions.length}件、
                      {toGiBLabel(viewer.opfsStorageInfo.breakdown.cachedConversionsTotalBytes)})
                    </p>
                    {viewer.opfsStorageInfo.breakdown.cachedConversions.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void viewer.clearOpfsCachedConversions()}
                        className="rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-600"
                      >
                        すべて消す
                      </button>
                    )}
                  </div>
                  {viewer.opfsStorageInfo.breakdown.cachedConversions.length === 0 ? (
                    <p className="mt-1 opacity-60">無し</p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-1">
                      {viewer.opfsStorageInfo.breakdown.cachedConversions.map((entry) => (
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
                      残っている一時ファイル({viewer.opfsStorageInfo.breakdown.staleScratchDirs.length}件、
                      {toGiBLabel(viewer.opfsStorageInfo.breakdown.staleScratchTotalBytes)})
                    </p>
                    {viewer.opfsStorageInfo.breakdown.staleScratchDirs.length > 0 && (
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
                  {viewer.opfsStorageInfo.breakdown.staleScratchDirs.length === 0 ? (
                    <p className="mt-1 opacity-60">無し</p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-1">
                      {viewer.opfsStorageInfo.breakdown.staleScratchDirs.map((dir) => (
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
          </section>
        )}

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
    </Dialog>
  );
}
