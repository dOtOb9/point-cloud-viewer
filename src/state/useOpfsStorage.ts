// Browser storage (OPFS) usage for the Web build: quota, usage, persistence, and the cache / scratch
// entries that the settings page ("ブラウザの保存領域") lets the user delete (M4-6).
// Every delete refreshes `opfsStorageInfo` afterwards. On desktop (Tauri) all of it is a no-op.
// Used by: useCopcViewer.ts; FileOpener calls `refreshOpfsStorageInfo` when the quota is too small.
// Entry: `useOpfsStorage()`.
import { useCallback, useState } from "react";
import {
  cleanupStaleScratchDirs,
  clearAllCachedConversions,
  ensurePersistentStorage,
  estimateQuota,
  getOpfsUsageBreakdown,
  isPersisted,
  removeCachedConversionEntry,
  removeScratchDirByName,
  type CachedConversionEntry,
} from "../datasource/opfs";
import { isTauriEnvironment } from "../datasource/environment";
import type { OpfsStorageInfo } from "./viewer-types";

export interface OpfsStorage {
  /** Web OPFS usage (cache and scratch breakdown) and persistence state. null before it is fetched and on desktop (check `isBrowser` first; see `SettingsModal`). */
  opfsStorageInfo: OpfsStorageInfo | null;
  /** Fetch / recompute `opfsStorageInfo` (when the settings open, after a delete). */
  refreshOpfsStorageInfo: () => Promise<void>;
  /** Ask for `persist()` if not yet persisted, then refresh `opfsStorageInfo` whatever the answer was. */
  requestOpfsPersistentStorage: () => Promise<void>;
  /** Delete one converted cache entry, then refresh `opfsStorageInfo`. */
  removeOpfsCachedConversion: (entry: CachedConversionEntry) => Promise<void>;
  /** Delete all converted caches, then refresh `opfsStorageInfo`. */
  clearOpfsCachedConversions: () => Promise<void>;
  /** Delete one leftover scratch directory, then refresh `opfsStorageInfo`. */
  removeOpfsScratchDir: (name: string) => Promise<void>;
  /** Delete all leftover scratch directories, then refresh `opfsStorageInfo`. */
  clearOpfsScratchDirs: () => Promise<void>;
}

export function useOpfsStorage(): OpfsStorage {
  const [opfsStorageInfo, setOpfsStorageInfo] = useState<OpfsStorageInfo | null>(null);

  const refreshOpfsStorageInfo = useCallback(async () => {
    if (isTauriEnvironment()) return;
    try {
      const [estimate, breakdown, persisted] = await Promise.all([
        estimateQuota(),
        getOpfsUsageBreakdown(),
        isPersisted(),
      ]);
      setOpfsStorageInfo({ quotaBytes: estimate.quota, usageBytes: estimate.usage, persisted, breakdown });
    } catch (e: unknown) {
      // The screen must not break when this fails: log it only. The settings page then stays on "loading".
      console.error("refreshOpfsStorageInfo failed", e);
    }
  }, []);

  // Ask for persist() if not yet persisted, then refresh whatever the answer was.
  const requestOpfsPersistentStorage = useCallback(async () => {
    if (!isTauriEnvironment()) {
      try {
        await ensurePersistentStorage(navigator.storage);
      } catch (e: unknown) {
        console.error("ensurePersistentStorage failed", e);
      }
    }
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);

  const removeOpfsCachedConversion = useCallback(
    async (entry: CachedConversionEntry) => {
      await removeCachedConversionEntry(entry);
      await refreshOpfsStorageInfo();
    },
    [refreshOpfsStorageInfo],
  );

  const clearOpfsCachedConversions = useCallback(async () => {
    await clearAllCachedConversions();
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);

  const removeOpfsScratchDir = useCallback(
    async (name: string) => {
      await removeScratchDirByName(name);
      await refreshOpfsStorageInfo();
    },
    [refreshOpfsStorageInfo],
  );

  const clearOpfsScratchDirs = useCallback(async () => {
    await cleanupStaleScratchDirs();
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);

  return {
    opfsStorageInfo,
    refreshOpfsStorageInfo,
    requestOpfsPersistentStorage,
    removeOpfsCachedConversion,
    clearOpfsCachedConversions,
    removeOpfsScratchDir,
    clearOpfsScratchDirs,
  };
}
