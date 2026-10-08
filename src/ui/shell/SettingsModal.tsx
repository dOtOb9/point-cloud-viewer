import { useEffect, useState } from "react";
import type { CopcViewerState, PointShape } from "../../state/useCopcViewer";
import type { ThemePreference, ThemeState } from "../../state/useTheme";
import type { UpdateCheckState } from "../../state/useUpdateCheck";
import { IpcBenchPanel } from "../IpcBenchPanel";
import { NodeConcurrencyBenchPanel } from "../NodeConcurrencyBenchPanel";
import { WebGpuProbePanel } from "../WebGpuProbePanel";

interface Props {
  open: boolean;
  onClose: () => void;
  theme: ThemeState;
  update: UpdateCheckState;
  viewer: CopcViewerState;
  /** M3-8: ガラス表現(backdrop-blur)のオン/オフ。CopcViewerStateではなく
   *  AppShellが直接持つ値なので、他のtheme/update/viewerと同じ形で
   *  別途受け取る(AppShell.tsxのglassEnabled stateのコメント参照)。 */
  glassEnabled: boolean;
  onGlassEnabledChange: (enabled: boolean) => void;
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

/**
 * 2026-10-08追記: 中央優先度の強さ・下限はスライダーに変更した。
 *
 * 以前は選択肢ボタン(0, 1, 2, 4)だったが、所有者が実機で4(選択肢の最大)を
 * 試した結果「これ以上だといいのかも」という感触だったため、4より上も
 * 自由に試せるようにスライダーにした(RENDER_SCALE_OPTIONSのような
 * 「極端な値を避ける」ボタン方式ではなく、範囲をスライダーのmin/maxで
 * 区切ることで誤操作を防ぐ)。詳細はTaskSheets/ADR-0010-lod-priority-and-point-budget.md
 * 追記4参照。
 *
 * - 強さ: 0〜16。4が所有者の実測済みの既定値。16は「4より上も試せる」
 *   ための余裕で、根拠のある上限ではない(未検証)。
 * - 下限: 0〜0.5。既定の0.2は変えていない。0.5より上にすると中央優先の
 *   効果自体が薄くなりすぎる(下限が1に近いほどgaussianの影響が消える)ため、
 *   そこで区切った。
 */
const CENTER_PRIORITY_STRENGTH_MIN = 0;
const CENTER_PRIORITY_STRENGTH_MAX = 16;
const CENTER_PRIORITY_STRENGTH_STEP = 0.5;
const MIN_CENTER_PRIORITY_WEIGHT_MIN = 0;
const MIN_CENTER_PRIORITY_WEIGHT_MAX = 0.5;
const MIN_CENTER_PRIORITY_WEIGHT_STEP = 0.01;

const POINT_SHAPE_LABELS: Record<PointShape, string> = {
  round: "丸",
  square: "四角",
};

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
export function SettingsModal({ open, onClose, theme, update, viewer, glassEnabled, onGlassEnabledChange }: Props) {
  const [devPathInput, setDevPathInput] = useState("");

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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">設定</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="設定を閉じる"
            className="rounded px-2 py-1 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          >
            閉じる
          </button>
        </div>

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
                    ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                    : "border border-slate-300 dark:border-slate-600"
                }`}
              >
                {THEME_LABELS[p]}
              </button>
            ))}
          </div>
          <p className="text-xs opacity-60">
            既定は「OSに合わせる」(ADR-0005の決定通り)。実機ではOSの明暗を切り替えずに
            両テーマを確認できるよう、ここから手動固定もできる。
          </p>
          <p className="text-xs opacity-60">現在の表示: {theme.theme === "dark" ? "ダーク" : "ライト"}</p>
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
            確認するだけで、ダウンロードとインストールは常に利用者の手作業
            （GitHub Releasesの最新版と比較し、リリースページを開くところまで）。
            開発中(`tauri dev`)はこの設定に関わらず確認しない。
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
            <h3 className="text-sm font-semibold opacity-70">変換の一時ファイル (M4-3)</h3>
            <p className="text-xs opacity-60">
              生のLAS/LAZをCOPCに変換する際、入力サイズの約11倍の一時ディスク容量を使う
              （ADR-0006の実測）。既定はOSの一時ディレクトリ。空き容量が足りない場合は、
              空きのあるドライブ・フォルダを指定する。
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={viewer.tempDir ?? "(既定のまま)"}
                className="flex-1 rounded border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-800"
              />
              <button
                type="button"
                onClick={() => void viewer.pickAndSetTempDir()}
                className="rounded bg-slate-900 px-2 py-1 text-xs text-white dark:bg-white dark:text-slate-900"
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

        <section className="flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
          <h3 className="text-sm font-semibold opacity-70">モバイル最適化 (M3-8)</h3>
          <p className="text-xs opacity-60">
            所有者の実機(OPPO Pad Air)で点予算を大きく下げないと落ちる問題を受け、GPU負荷を下げる手段を
            個別に切り替えられるようにしたもの。実機で1つずつ切り替えて、落ちずに扱える点数が変わるかを
            確かめる目的も兼ねる（詳細はTaskSheets/M3-release-and-update.md M3-8参照）。
          </p>

          <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
            <p className="font-semibold opacity-70">端末プロファイル判定</p>
            <p>
              判定結果: <span className="font-mono">{viewer.isMobile ? "モバイル" : "デスクトップ"}</span>
            </p>
            <p>
              deviceMemory:{" "}
              <span className="font-mono">
                {viewer.deviceMemoryGiB !== undefined ? `${viewer.deviceMemoryGiB} GiB` : "取得不可"}
              </span>{" "}
              / pointer:coarse: <span className="font-mono">{String(viewer.pointerCoarse)}</span>
            </p>
            <p className="mt-1 opacity-60">
              以下5つの既定値は、この判定が「モバイル」なら軽い側、「デスクトップ」なら変更前と同じ値になる。
              モバイル側の具体的な数値は未検証の初期値(TaskSheets/M3-release-and-update.md M3-8参照)。
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">
              レンダースケール（内部解像度 = 表示サイズ(CSS px)×この値。devicePixelRatioは含まない。
              既定: モバイル0.5 / デスクトップ1.0）
            </label>
            <div className="flex gap-2">
              {RENDER_SCALE_OPTIONS.map((scale) => (
                <button
                  key={scale}
                  type="button"
                  onClick={() => viewer.setRenderScale(scale)}
                  className={`rounded px-3 py-1.5 text-sm ${
                    viewer.renderScale === scale
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "border border-slate-300 dark:border-slate-600"
                  }`}
                >
                  {scale}
                </button>
              ))}
            </div>
            <p className="text-xs opacity-60">現在値: {viewer.renderScale}（再起動なしで反映される）</p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70">点の形（既定: モバイル四角 / デスクトップ丸）</label>
            <div className="flex gap-2">
              {(Object.keys(POINT_SHAPE_LABELS) as PointShape[]).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  onClick={() => viewer.setPointShape(shape)}
                  className={`rounded px-3 py-1.5 text-sm ${
                    viewer.pointShape === shape
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "border border-slate-300 dark:border-slate-600"
                  }`}
                >
                  {POINT_SHAPE_LABELS[shape]}
                </button>
              ))}
            </div>
            <p className="text-xs opacity-60">
              丸は円形マスクに`discard`を使う。四角は`discard`が無いパイプラインを使うため、
              タイル方式のGPUで早期に打ち切りやすい（判断の理由はTaskSheets/M3-release-and-update.md M3-8参照）。
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={viewer.edlEnabled} onChange={(e) => viewer.setEdlEnabled(e.target.checked)} />
            EDL（陰影で凹凸を強調。既定: モバイルオフ / デスクトップオン）
          </label>
          <p className="text-xs opacity-60">
            オフのとき、点群をオフスクリーンを経由せずスワップチェーンへ直接描く1パス描画になる
            （メモリ帯域の往復を1回減らす）。
          </p>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={glassEnabled} onChange={(e) => onGlassEnabledChange(e.target.checked)} />
            UIのガラス表現（ぼかし。既定: モバイルオフ / デスクトップオン）
          </label>
          <p className="text-xs opacity-60">
            オフにすると、パネルの背景が`backdrop-filter`によるぼかしではなく不透明な単色(tint)になる。
          </p>

          <div className="rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
            <p className="font-semibold opacity-70">点予算の上限（端末のメモリから算出。既定: デスクトップ1GiB固定）</p>
            <p>
              現在の上限: <span className="font-mono">{viewer.pointBudgetMax.toLocaleString()}</span> 点
            </p>
            <p className="mt-1 opacity-60">
              モバイルではnavigator.deviceMemoryから逆算する（未検証の初期値）。この上限自体を
              手動で切り替える手段は設けていない。点予算そのものはレイヤーパネルから手動変更・自動調整の
              on/offができる。
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
          <h3 className="text-sm font-semibold opacity-70">LODの中央優先度 (ADR-0010追記)</h3>
          <p className="text-xs opacity-60">
            所有者の要望「画面中央のチャンクを優先して細かく表示しないと使いにくい」への対応。画面空間誤差
            （点の間隔が画面上で何ピクセルに見えるか）だけで優先度を決めると、画面の端にある近いノードと
            中央のノードが同じ扱いになることがあった。ここの強さを上げると、画面中央に近いノードほど
            優先度が上乗せされる（式・下限で端のノードが飢餓しないようにしている理由は
            TaskSheets/ADR-0010-lod-priority-and-point-budget.md参照）。
          </p>
          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70" htmlFor="center-priority-strength">
              中央優先の強さ（0 = 今までどおり画面空間誤差のみ）
            </label>
            <input
              id="center-priority-strength"
              type="range"
              min={CENTER_PRIORITY_STRENGTH_MIN}
              max={CENTER_PRIORITY_STRENGTH_MAX}
              step={CENTER_PRIORITY_STRENGTH_STEP}
              value={viewer.centerPriorityStrength}
              onChange={(e) => viewer.setCenterPriorityStrength(Number(e.target.value))}
            />
            <p className="text-xs opacity-60">
              現在値: {viewer.centerPriorityStrength}（再起動なしで反映される）。
              これが変えるのは「中央として優先される範囲の狭さ」:
              大きくするほど、画面中央のごく近くだけが優先され、少し離れただけで
              優先度が急に下がる。
              <strong>所有者が実機で0/1/2/4を試した結果、4(今の既定値)が一番良かった
              （「これ以上だといいのかも」とのこと）。</strong>
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70" htmlFor="min-center-priority-weight">
              中央優先の重みの下限（端のノードをどれだけ後回しにしてよいか）
            </label>
            <input
              id="min-center-priority-weight"
              type="range"
              min={MIN_CENTER_PRIORITY_WEIGHT_MIN}
              max={MIN_CENTER_PRIORITY_WEIGHT_MAX}
              step={MIN_CENTER_PRIORITY_WEIGHT_STEP}
              value={viewer.minCenterPriorityWeight}
              onChange={(e) => viewer.setMinCenterPriorityWeight(Number(e.target.value))}
            />
            <p className="text-xs opacity-60">
              現在値: {viewer.minCenterPriorityWeight.toFixed(2)}（既定0.2、再起動なしで反映される）。
              これが変えるのは「端をどれだけ後回しにしてよいか」:
              下げるほど、画面中央のノードが画面端のノードより優先されやすくなるが、
              下げ過ぎると画面端のノードが点予算の厳しい間ずっと読み込まれない
              （飢餓）おそれが大きくなる。
              <strong>
                {viewer.minCenterPriorityWeight === 0
                  ? " 今は0: 下限が無いのと同じで、強さを上げた状態で点予算が厳しいと、画面端のノードが実質ずっと選ばれなくなることがある。"
                  : ""}
              </strong>
            </p>
          </div>
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
            <h3 className="text-sm font-semibold opacity-70">ブラウザの保存領域 (OPFS, M4-6)</h3>
            <p className="text-xs opacity-60">
              Web版の変換はブラウザのOPFS(オリジン専用ファイルシステム)に変換済みキャッシュと一時ファイルを置く。
              上限(quota)はブラウザとディスクの空き容量で決まり、変換前に自動で変わることがある。
              「空き容量が足りません」が出たときは、ここでキャッシュ・一時ファイルを消すか、
              永続的な保存を許可すると空く場合がある。
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

          {/* M3: 主要UI(LayerPanel)はOSのファイル選択ダイアログに絞ったため
              (Androidではパスを手入力できない。TaskSheets/M3-release-and-update.md参照)、
              開発中に同じファイルを繰り返し開きたいときのための、パス直指定の
              抜け道をここに残す。Web版には意味が無いので出さない。 */}
          {!viewer.isBrowser && (
            <div className="mt-3 flex flex-col gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
              <h4 className="text-xs font-semibold opacity-70">開発用: パス指定で開く</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={devPathInput}
                  onChange={(e) => setDevPathInput(e.target.value)}
                  placeholder="絶対パス (.laz)"
                  className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-800"
                />
                <button
                  type="button"
                  onClick={() => void viewer.openFile(devPathInput)}
                  disabled={viewer.status === "opening" || devPathInput.trim() === ""}
                  className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
                >
                  開く
                </button>
              </div>
              <p className="text-xs opacity-60">
                OSのファイル選択ダイアログを毎回出したくない開発時用。通常の利用では
                左のレイヤーパネルの「ファイルを選ぶ…」を使う。
              </p>
            </div>
          )}
        </details>
      </div>
    </div>
  );
}
