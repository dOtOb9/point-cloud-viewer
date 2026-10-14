// L1-E (ADR-0017 追記2): 設定の「一覧」と「専用ダイアログ」の切り替えを決める小さな純粋関数。
// React に依存しないので Vitest だけで確かめられる(settings-nav.test.ts)。

export type SettingsPageId =
  | "theme"
  | "animation"
  | "update"
  | "tempDir"
  | "renderScale"
  | "storage"
  | "background"
  | "pointBudget"
  | "loadPriority"
  | "edl";

/** "list" は設定の一覧(ボタンの集合)。それ以外は専用ダイアログ。 */
export type SettingsPage = "list" | SettingsPageId;

export type SettingsNavAction = { type: "open"; page: SettingsPageId } | { type: "back" } | { type: "reset" };

/** 一覧と専用ダイアログは同時に開かない。「戻る」と「最初から」は一覧に戻す。 */
export function settingsNavReducer(_state: SettingsPage, action: SettingsNavAction): SettingsPage {
  switch (action.type) {
    case "open":
      return action.page;
    case "back":
    case "reset":
      return "list";
  }
}

export interface SettingsAvailability {
  isBrowser: boolean;
  supportsCustomTempDir: boolean;
}

/** 一覧に出す項目(出す順)。条件を満たさない項目は含めない(ボタンを出さない)。 */
export function visibleSettingsPages(a: SettingsAvailability): SettingsPageId[] {
  const pages: SettingsPageId[] = ["theme", "animation", "background", "pointBudget", "loadPriority", "edl", "renderScale", "update"];
  // 一時フォルダはデスクトップだけ(Android・Webでは選べない。従来と同じ条件)。
  if (!a.isBrowser && a.supportsCustomTempDir) pages.push("tempDir");
  // ブラウザの保存領域(OPFS)はWebだけ。
  if (a.isBrowser) pages.push("storage");
  return pages;
}
