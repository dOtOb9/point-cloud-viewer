// ADR-0017: ダイアログのフッターで使うボタンの共通クラス(`ribbon-styles.ts`と同じ考え方)。
// min-h-11 = 44px(タッチ操作の最小サイズ)。

/** 通常ボタン(コピー・キャンセルなど)。 */
export const DIALOG_BUTTON_CLASS =
  "min-h-11 rounded border border-slate-300 px-4 py-2 text-sm hover:bg-black/5 dark:border-slate-600 dark:hover:bg-white/10";

/** 主ボタン(閉じる・開くなど)。 */
export const DIALOG_PRIMARY_BUTTON_CLASS =
  "min-h-11 rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200";
