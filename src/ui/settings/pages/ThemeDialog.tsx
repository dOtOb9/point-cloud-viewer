import type { ThemePreference, ThemeState } from "../../../state/useTheme";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "OSに合わせる",
  dark: "ダーク",
  light: "ライト",
};

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
