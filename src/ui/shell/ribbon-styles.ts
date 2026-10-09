// ADR-0017 (UIシェル再構築): リボンの各グループ・ボタンで共通して使うクラス文字列。
//
// `glass.ts`と同じ考え方で、見た目の値を1箇所にまとめて複数ファイルから使う
// (リボンは「ファイル/表示/ツール/設定」の4グループに分かれており、
// ボタンやラベルの見た目をファイルごとに書き直すと少しのズレが蓄積するため)。

/** グループの見出し（「ファイル」「表示」など）。小さく控えめに。 */
export const RIBBON_GROUP_LABEL_CLASS = "text-[10px] font-semibold uppercase tracking-wide opacity-50";

/** リボン内の通常ボタン。無効化時は見た目でも明確にクリックできないと分かるようにする
 *  (受け入れ条件: 未実装ツールが「クリックできそうに見えない」こと)。 */
export const RIBBON_BUTTON_CLASS =
  "min-h-11 rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap " +
  "hover:bg-black/5 dark:hover:bg-white/10 " +
  "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:pointer-events-none";

/** 選択中(アクティブ)のボタン(Dock.tsxのACTIVE_CLASSと同じ値)。 */
export const RIBBON_BUTTON_ACTIVE_CLASS = "min-h-11 rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap bg-slate-900 text-white dark:bg-white dark:text-slate-900";

/** グループ1つの外枠。縦に見出し+横並びの操作、を並べる。 */
export const RIBBON_GROUP_CLASS = "flex flex-col gap-1 border-r border-black/10 pr-3 last:border-r-0 dark:border-white/10";

/** 入力欄(select/number/text)の共通見た目。LayerPanel/SettingsModalの既存の値と揃える。 */
export const RIBBON_INPUT_CLASS =
  "min-h-11 rounded border border-black/10 bg-white/60 px-2 py-1 text-xs text-inherit dark:border-white/10 dark:bg-black/30";
