// Where conversion writes its temporary files (desktop only; the Web build converts inside OPFS).
// `tempDir` is saved in localStorage; null means the platform default.
// Also asks the Rust side once at startup whether choosing the folder makes sense (Android does not).
// Used by: useCopcViewer.ts (settings page); useFileOpen.ts and usePointCloudTools.ts pass `tempDir` to Rust.
// Entry: `useTempDir()`.
import { useCallback, useEffect, useState } from "react";
import { pickTempDirectory, supportsCustomTempDir as fetchSupportsCustomTempDir } from "../datasource/tauri";
import { isTauriEnvironment } from "../datasource/environment";

const TEMP_DIR_STORAGE_KEY = "pcv-conversion-temp-dir";

function readStoredTempDir(): string | null {
  try {
    return localStorage.getItem(TEMP_DIR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface TempDirSetting {
  /** Setting of the scratch file location; null means the platform default. Only meaningful on desktop (the Web build does not convert). */
  tempDir: string | null;
  /** True on desktop only (Android is led to the app cache automatically, so no manual picker is shown; see `supports_custom_temp_dir` in `src-tauri/src/conversion.rs`). The Web build always shows false. */
  supportsCustomTempDir: boolean;
  /** Open the OS folder dialog and set the chosen folder. */
  pickAndSetTempDir: () => Promise<void>;
  /** Back to the default. */
  clearTempDir: () => void;
}

export function useTempDir(): TempDirSetting {
  const [tempDir, setTempDirState] = useState<string | null>(() => readStoredTempDir());
  // The frontend cannot tell Android directly, so ask Rust once at startup. Default true = desktop-like.
  const [supportsCustomTempDir, setSupportsCustomTempDir] = useState(true);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    fetchSupportsCustomTempDir()
      .then(setSupportsCustomTempDir)
      .catch((e: unknown) => console.error("supportsCustomTempDir failed", e));
  }, []);

  const setTempDir = useCallback((dir: string | null) => {
    setTempDirState(dir);
    try {
      if (dir === null) {
        localStorage.removeItem(TEMP_DIR_STORAGE_KEY);
      } else {
        localStorage.setItem(TEMP_DIR_STORAGE_KEY, dir);
      }
    } catch {
      // Failing to save is harmless: the default comes back on the next start.
    }
  }, []);

  const pickAndSetTempDir = useCallback(async () => {
    const picked = await pickTempDirectory();
    if (picked) setTempDir(picked);
  }, [setTempDir]);

  const clearTempDir = useCallback(() => setTempDir(null), [setTempDir]);

  return { tempDir, supportsCustomTempDir, pickAndSetTempDir, clearTempDir };
}
