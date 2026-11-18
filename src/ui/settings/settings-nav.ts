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
  | "edl"
  | "unit"
  | "dtmOutput";

export type SettingsPage = "list" | SettingsPageId;

export type SettingsNavAction = { type: "open"; page: SettingsPageId } | { type: "back" } | { type: "reset" };

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

export function visibleSettingsPages(a: SettingsAvailability): SettingsPageId[] {
  const pages: SettingsPageId[] = ["theme", "animation", "background", "pointBudget", "loadPriority", "edl", "unit", "dtmOutput", "renderScale", "update"];
  if (!a.isBrowser && a.supportsCustomTempDir) pages.push("tempDir");
  if (a.isBrowser) pages.push("storage");
  return pages;
}
