import { useCallback, useMemo, useState } from "react";
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
  type OpfsUsageBreakdown,
} from "../datasource/opfs";
import { isTauriEnvironment } from "../datasource/environment";
import { createBlockedCleanupStore, type ScratchCleanupContext } from "../app/scratch-cleanup";

export interface OpfsStorageInfo {
  quotaBytes: number;
  usageBytes: number;
  persisted: boolean;
  breakdown: OpfsUsageBreakdown;
}

export interface OpfsStorage {
  opfsStorageInfo: OpfsStorageInfo | null;
  refreshOpfsStorageInfo: () => Promise<void>;
  requestOpfsPersistentStorage: () => Promise<void>;
  removeOpfsCachedConversion: (entry: CachedConversionEntry) => Promise<void>;
  clearOpfsCachedConversions: () => Promise<void>;
  scratchCleanupContext: ScratchCleanupContext;
}

export function useOpfsStorage(reportError: ScratchCleanupContext["reportError"]): OpfsStorage {
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
      console.error("refreshOpfsStorageInfo failed", e);
    }
  }, []);

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

  const [blockedByConversion] = useState(createBlockedCleanupStore);
  const scratchCleanupContext = useMemo<ScratchCleanupContext>(
    () => ({
      lockManager: navigator.locks,
      removeAllScratchDirs: cleanupStaleScratchDirs,
      removeScratchDir: removeScratchDirByName,
      refreshStorageInfo: refreshOpfsStorageInfo,
      reportError,
      blockedByConversion,
    }),
    [refreshOpfsStorageInfo, reportError, blockedByConversion],
  );

  return {
    opfsStorageInfo,
    refreshOpfsStorageInfo,
    requestOpfsPersistentStorage,
    removeOpfsCachedConversion,
    clearOpfsCachedConversions,
    scratchCleanupContext,
  };
}
