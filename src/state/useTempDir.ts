import { useCallback, useEffect, useState } from "react";
import { pickTempDirectory, supportsCustomTempDir as fetchSupportsCustomTempDir } from "../datasource/tauri";
import { isTauriEnvironment } from "../datasource/environment";
import { saveSettingIfStorageAllows } from "./setting-storage";

const TEMP_DIR_STORAGE_KEY = "pcv-conversion-temp-dir";

function readStoredTempDir(): string | null {
  try {
    return localStorage.getItem(TEMP_DIR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface TempDirSetting {
  tempDir: string | null;
  supportsCustomTempDir: boolean;
  pickAndSetTempDir: () => Promise<void>;
  clearTempDir: () => void;
}

export function useTempDir(): TempDirSetting {
  const [tempDir, setTempDirState] = useState<string | null>(() => readStoredTempDir());
  const [supportsCustomTempDir, setSupportsCustomTempDir] = useState(true);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    fetchSupportsCustomTempDir()
      .then(setSupportsCustomTempDir)
      .catch((e: unknown) => console.error("supportsCustomTempDir failed", e));
  }, []);

  const setTempDir = useCallback((dir: string | null) => {
    setTempDirState(dir);
    saveSettingIfStorageAllows(() => {
      if (dir === null) {
        localStorage.removeItem(TEMP_DIR_STORAGE_KEY);
      } else {
        localStorage.setItem(TEMP_DIR_STORAGE_KEY, dir);
      }
    });
  }, []);

  const pickAndSetTempDir = useCallback(async () => {
    const picked = await pickTempDirectory();
    if (picked) setTempDir(picked);
  }, [setTempDir]);

  const clearTempDir = useCallback(() => setTempDir(null), [setTempDir]);

  return { tempDir, supportsCustomTempDir, pickAndSetTempDir, clearTempDir };
}
