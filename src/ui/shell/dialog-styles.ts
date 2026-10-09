// ADR-0017: ダイアログのフッターで使うボタンの共通クラス(`ribbon-styles.ts`と同じ考え方)。
// min-h-11 = 44px(タッチ操作の最小サイズ)。色は役割トークン(index.cssのprimary/tertiaryなど)。
// 通常ボタン=tertiary(灰。閉じる・キャンセル・コピー)、主ボタン=primary(緑。開くなど)。

/** 通常ボタン(コピー・キャンセルなど)。 */
export const DIALOG_BUTTON_CLASS =
  "min-h-11 rounded bg-tertiary px-4 py-2 text-sm text-on-tertiary hover:opacity-90 disabled:opacity-40";

/** 主ボタン(閉じる・開くなど)。 */
export const DIALOG_PRIMARY_BUTTON_CLASS =
  "min-h-11 rounded bg-primary px-4 py-2 text-sm text-on-primary hover:opacity-90 disabled:opacity-40";
