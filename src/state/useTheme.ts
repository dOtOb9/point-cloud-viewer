import { useCallback, useEffect, useState } from "react";
import { saveSettingIfStorageAllows } from "./setting-storage";

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "pcv-theme-preference";

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

function readStoredPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    return "system";
  }
  return "system";
}

export interface ThemeState {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

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
    saveSettingIfStorageAllows(() => localStorage.setItem(STORAGE_KEY, p));
  }, []);

  return { preference, theme, setPreference };
}
