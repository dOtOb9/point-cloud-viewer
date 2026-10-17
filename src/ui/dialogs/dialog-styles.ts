// ADR-0017: ダイアログのフッターで使うボタンの共通クラス(`toolbar-styles.ts`と同じ考え方)。
// min-h-11 = 44px(タッチ操作の最小サイズ)。色は役割トークン(index.cssのprimary/tertiaryなど)。
// tertiary=灰(閉じる・キャンセル・コピー)、primary=緑(開く・開始など主操作)。

/** tertiary(灰)ボタン。「閉じる」だけのボタンはこれを使う(L1-A)。 */
export const DIALOG_TERTIARY_BUTTON_CLASS =
  "min-h-11 rounded bg-tertiary px-4 py-2 text-sm text-on-tertiary hover:opacity-90 disabled:opacity-40";

/** 通常ボタン(コピー・キャンセルなど)。見た目はtertiaryと同じ。 */
export const DIALOG_BUTTON_CLASS =
  "min-h-11 rounded bg-tertiary px-4 py-2 text-sm text-on-tertiary hover:opacity-90 disabled:opacity-40";

/** 主ボタン(開く・開始など。「閉じる」には使わない)。 */
export const DIALOG_PRIMARY_BUTTON_CLASS =
  "min-h-11 rounded bg-primary px-4 py-2 text-sm text-on-primary hover:opacity-90 disabled:opacity-40";
