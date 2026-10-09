// ADR-0017 (UIシェル再構築): リボンの各グループ・ボタンで共通して使うクラス文字列。
//
// `glass.ts`と同じ考え方で、見た目の値を1箇所にまとめて複数ファイルから使う
// (リボンは「ファイル/表示/ツール/設定」の4グループに分かれており、
// ボタンやラベルの見た目をファイルごとに書き直すと少しのズレが蓄積するため)。

/** グループの見出し（「ファイル」「表示」など）。小さく控えめに。 */
export const RIBBON_GROUP_LABEL_CLASS = "text-[10px] font-semibold uppercase tracking-wide opacity-50";

/**
 * リボンのボタン。アイコンが上、短い文字ラベルが下の縦並び(所有者の要件)。
 * 無効化時は見た目でも明確にクリックできないと分かるようにする
 * (未実装ツールはアイコンとラベルを残したまま、この無効スタイルにする)。
 * min-h-14(56px)・min-w-14は44px以上のタッチ領域。
 */
export const RIBBON_BUTTON_CLASS =
  "flex min-h-14 min-w-14 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-[11px] leading-tight whitespace-nowrap " +
  "hover:bg-black/5 dark:hover:bg-white/10 " +
  "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:pointer-events-none";

/** 塗りつぶしの強調ボタン(「開く」など主要操作)。 */
export const RIBBON_BUTTON_PRIMARY_CLASS =
  "bg-slate-900/90 text-white hover:!bg-slate-900 dark:bg-white/90 dark:text-slate-900 dark:hover:!bg-white";

/** グループ1つの外枠。縦に見出し+横並びの操作、を並べる。 */
export const RIBBON_GROUP_CLASS = "flex flex-col gap-1 border-r border-black/10 pr-3 last:border-r-0 dark:border-white/10";

/** 入力欄(select)の共通見た目。 */
export const RIBBON_INPUT_CLASS =
  "min-h-9 rounded border border-black/10 bg-white/60 px-2 py-1 text-xs text-inherit dark:border-white/10 dark:bg-black/30";
