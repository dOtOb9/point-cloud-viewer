import { useCallback, useEffect, useState } from "react";
import { fetchLatestRelease, type LatestRelease } from "../datasource/update-check";
import { isNewerVersion } from "../datasource/version-compare";
import { getAppVersion, openReleasePage } from "../datasource/tauri";
import { saveSettingIfStorageAllows } from "./setting-storage";

const STORAGE_KEY = "pcv-update-check-enabled";

function readStoredEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export type UpdateStatus = "disabled" | "checking" | "none" | "available" | "dismissed";

export interface UpdateCheckState {
  status: UpdateStatus;
  latest: LatestRelease | null;
  currentVersion: string | null;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  dismiss: () => void;
  openRelease: () => Promise<void>;
}

export function useUpdateCheck(): UpdateCheckState {
  const [enabled, setEnabledState] = useState(() => readStoredEnabled());
  const [phase, setPhase] = useState<"checking" | "done">("checking");
  const [dismissed, setDismissed] = useState(false);
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  const checkingEnabled = !import.meta.env.DEV && enabled;

  useEffect(() => {
    if (!checkingEnabled) return;

    let cancelled = false;

    (async () => {
      setPhase("checking");
      setDismissed(false);

      const [version, release] = await Promise.all([getAppVersion(), fetchLatestRelease()]);
      if (cancelled) return;

      setCurrentVersion(version);
      setLatest(release && isNewerVersion(version, release.tagName) ? release : null);
      setPhase("done");
    })().catch(() => {
      if (!cancelled) setPhase("done");
    });

    return () => {
      cancelled = true;
    };
  }, [checkingEnabled]);

  const status: UpdateStatus = !checkingEnabled
    ? "disabled"
    : phase === "checking"
      ? "checking"
      : dismissed
        ? "dismissed"
        : latest
          ? "available"
          : "none";

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    saveSettingIfStorageAllows(() => localStorage.setItem(STORAGE_KEY, String(v)));
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  const openRelease = useCallback(async () => {
    if (latest) await openReleasePage(latest.htmlUrl);
  }, [latest]);

  return { status, latest, currentVersion, enabled, setEnabled, dismiss, openRelease };
}
