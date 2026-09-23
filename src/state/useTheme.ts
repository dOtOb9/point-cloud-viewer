import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "pcv-theme-preference";

/**
 * M2-3 (ADR-0005): 「OS設定に追従」する既定と、設定画面からの手動固定を
 * 1つの式にまとめた純関数。DOM/localStorageを触らないのでvitestで直接検証できる
 * (他のロジック層(mat4/up-axis等)と同じ方針。useTheme.test.ts参照)。
 */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

function readStoredPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    // localStorageが使えない環境ではsystem(既定)にフォールバックする。
  }
  return "system";
}

export interface ThemeState {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

/**
 * M2-3 (ADR-0005): ダーク/ライトの解決と適用。
 *
 * ADRの決定は「OS設定に追従」で、既定(preference="system")はそれをそのまま守る。
 * それに加えて、所有者が実機で両テーマを見比べられるよう、設定画面から
 * ダーク/ライトを手動固定できるようにした(GUIを目視できないエージェント側では
 * OSのモードを切り替えて確認する手段が無いため、手動固定が唯一の確認手段になる)。
 * 手動固定はADRの決定を覆すものではなく、既定値は変えていない。
 *
 * 適用先は<html>の`data-theme`属性(index.cssの`@custom-variant dark`が読む)。
 */
export function useTheme(): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => {
    if (typeof matchMedia === "undefined") return true;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setPrefersDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const theme = resolveTheme(preference, prefersDark);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // 保存できなくても動作に支障はない(次回起動時にsystemへ戻るだけ)。
    }
  }, []);

  return { preference, theme, setPreference };
}
