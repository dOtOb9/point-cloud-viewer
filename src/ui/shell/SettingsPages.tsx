import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import type { BackgroundMode, CopcViewerState } from "../../state/useCopcViewer";
import type { ThemePreference, ThemeState } from "../../state/useTheme";
import type { UpdateCheckState } from "../../state/useUpdateCheck";
import { IpcBenchPanel } from "../IpcBenchPanel";
import { NodeConcurrencyBenchPanel } from "../NodeConcurrencyBenchPanel";
import { WebGpuProbePanel } from "../WebGpuProbePanel";
import { Dialog } from "./Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

// L1-E (ADR-0017 追記2): 設定の項目ごとの専用ダイアログ。
// フッターは「戻る」(設定の一覧へ)と「閉じる」。どちらも灰色(tertiary)。
// 値はその場で viewer などの setter に流す(適用ボタンは無い)。ここには状態を持たない。

interface PageProps {
  open: boolean;
  /** 設定の一覧へ戻る。 */
  onBack: () => void;
  /** 設定を閉じる。 */
  onClose: () => void;
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "OSに合わせる",
  dark: "ダーク",
  light: "ライト",
};

const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  "solid-dark": "単色(暗)",
  "solid-light": "単色(明)",
  sky: "空",
};

/** M3-8: レンダースケールの選択肢。自由入力にしないのは、極端な値(0や負数)で画面が壊れるのを避けるため。 */
const RENDER_SCALE_OPTIONS = [0.25, 0.5, 0.75, 1.0] as const;

/** バイトを「約X.XGiB」の形にする(小数1桁)。UI は datasource を直接触らない規約のため、表示専用の整形はここに閉じる。 */
function toGiBLabel(bytes: number): string {
  return `約${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

/** 専用ダイアログの枠。フッターの「戻る」「閉じる」を共通にする。 */
function SettingsPageDialog({ open, onBack, onClose, title, widthClass, children }: PageProps & { title: string; widthClass?: string; children: ReactNode }) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      accent="primary"
      widthClass={widthClass}
      footer={
        <>
          <button type="button" onClick={onBack} className={`${DIALOG_TERTIARY_BUTTON_CLASS} flex items-center gap-1`}>
            <ArrowLeft size={16} aria-hidden="true" />
            戻る
          </button>
          <button type="button" onClick={onClose} className={`${DIALOG_TERTIARY_BUTTON_CLASS} flex items-center gap-1`}>
            <X size={16} aria-hidden="true" />
            閉じる
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">{children}</div>
    </Dialog>
  );
}

/** 選択肢1つ分の行(ViewDialogs の OptionRow と同じ見た目)。 */
function OptionRow({ children }: { children: ReactNode }) {
  return (
    <label className="flex min-h-11 items-center gap-3 rounded px-2 text-sm hover:bg-black/5 dark:hover:bg-white/10">{children}</label>
  );
}

export function ThemeDialog({ theme, ...page }: PageProps & { theme: ThemeState }) {
  return (
    <SettingsPageDialog {...page} title="テーマ">
      <div className="flex gap-2">
        {(Object.keys(THEME_LABELS) as ThemePreference[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => theme.setPreference(p)}
            className={`rounded px-3 py-1.5 text-sm ${
              theme.preference === p ? "bg-primary text-on-primary" : "border border-slate-300 dark:border-slate-600"
            }`}
          >
            {THEME_LABELS[p]}
          </button>
        ))}
      </div>
      <p className="text-xs opacity-60">
        画面の明るさ。「OSに合わせる」はOSの設定に従う。現在の表示: {theme.theme === "dark" ? "ダーク" : "ライト"}。
      </p>
    </SettingsPageDialog>
  );
}

export function AnimationDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="アニメーション">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="animation-toggle"
          checked={viewer.animationEnabled}
          onChange={(e) => viewer.setAnimationEnabled(e.target.checked)}
        />
        アニメーションを使う
      </label>
      <p className="text-xs opacity-60">画面の動きをまとめて切り替える。OSで「動きを減らす」が有効なときは常に止まる。</p>
    </SettingsPageDialog>
  );
}

export function UpdateDialog({ update, ...page }: PageProps & { update: UpdateCheckState }) {
  return (
    <SettingsPageDialog {...page} title="更新の確認">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={update.enabled} onChange={(e) => update.setEnabled(e.target.checked)} />
        起動時に新しいバージョンを確認する
      </label>
      <p className="text-xs opacity-60">新しい版があるか確認するだけで、ダウンロードとインストールは自分で行う。</p>
      {update.currentVersion && <p className="text-xs opacity-60">現在のバージョン: {update.currentVersion}</p>}
    </SettingsPageDialog>
  );
}

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

export function RenderScaleDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="描画の解像度">
      <div className="flex gap-2">
        {RENDER_SCALE_OPTIONS.map((scale) => (
          <button
            key={scale}
            type="button"
            onClick={() => viewer.setRenderScale(scale)}
            className={`rounded px-3 py-1.5 text-sm ${
              viewer.renderScale === scale ? "bg-primary text-on-primary" : "border border-slate-300 dark:border-slate-600"
            }`}
          >
            {scale}
          </button>
        ))}
      </div>
      <p className="text-xs opacity-60">画面サイズに対する描画の細かさ。小さいほど軽く、大きいほど鮮明。</p>
    </SettingsPageDialog>
  );
}

/** 背景(ラジオボタン)とグリッドのオン/オフ。 */
export function BackgroundDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="背景とグリッド">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">背景</legend>
        {(Object.keys(BACKGROUND_MODE_LABELS) as BackgroundMode[]).map((mode) => (
          <OptionRow key={mode}>
            <input
              type="radio"
              name="background-mode"
              value={mode}
              checked={viewer.backgroundMode === mode}
              onChange={() => viewer.setBackgroundMode(mode)}
              className="h-5 w-5 accent-primary"
            />
            {BACKGROUND_MODE_LABELS[mode]}
          </OptionRow>
        ))}
      </fieldset>
      <OptionRow>
        <input
          type="checkbox"
          name="grid-enabled"
          checked={viewer.gridEnabled}
          onChange={(e) => viewer.setGridEnabled(e.target.checked)}
          className="h-5 w-5 accent-primary"
        />
        グリッドを表示する
      </OptionRow>
    </SettingsPageDialog>
  );
}

/** 点予算: 手動の値と「自動調整する」。 */
export function PointBudgetDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="点予算">
      <p className="text-xs opacity-60">一度に描く点の数の上限。小さいほど軽く、大きいほど細かく見える。</p>
      <label className="flex flex-col gap-1 text-sm">
        点数{viewer.autoPointBudgetEnabled ? "（自動調整中）" : ""}
        <input
          type="number"
          name="point-budget"
          min={1000}
          step={100_000}
          value={viewer.pointBudget}
          onChange={(e) => viewer.setPointBudget(Number(e.target.value) || 0)}
          disabled={viewer.autoPointBudgetEnabled}
          title={viewer.autoPointBudgetEnabled ? "自動調整中のため読み取り専用。下のチェックを外すと手動で変更できる" : undefined}
          className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm text-inherit disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800"
        />
      </label>
      <OptionRow>
        <input
          type="checkbox"
          name="auto-point-budget"
          checked={viewer.autoPointBudgetEnabled}
          onChange={(e) => viewer.setAutoPointBudgetEnabled(e.target.checked)}
          className="h-5 w-5 accent-primary"
        />
        点予算を自動調整する
      </OptionRow>
    </SettingsPageDialog>
  );
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

/** M0 の診断パネル(WebGPU probe / IPC bench / node concurrency bench)。機能は削っていない。 */
export function DiagnosticsDialog(page: PageProps) {
  return (
    <SettingsPageDialog {...page} title="診断" widthClass="max-w-3xl">
      <div className="flex flex-col items-center gap-4">
        <WebGpuProbePanel />
        <IpcBenchPanel />
        <NodeConcurrencyBenchPanel />
      </div>
    </SettingsPageDialog>
  );
}
