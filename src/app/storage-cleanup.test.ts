import { describe, expect, it, vi } from "vitest";
import { CONVERSION_LOCK_NAME, type LockManagerLike, type OpfsUsageBreakdown } from "../datasource/opfs";
import {
  createBlockedCleanupStore,
  refreshStorageAndForgetBlockedCleanup,
  removeStorageUnlessConverting,
  showsBusyNoticeFor,
  type StorageCleanupContext,
  type StorageCleanupTarget,
} from "./storage-cleanup";

interface FakeLockManager extends LockManagerLike {
  held: boolean;
  requests: { name: string; options: { ifAvailable: boolean } }[];
}

function fakeLockManager(heldByConversion: boolean): FakeLockManager {
  const manager: FakeLockManager = {
    held: heldByConversion,
    requests: [],
    async request(name, options, callback) {
      manager.requests.push({ name, options });
      if (manager.held) return callback(null);
      manager.held = true;
      try {
        return await callback({ name });
      } finally {
        manager.held = false;
      }
    },
  };
  return manager;
}

function fakeContext(lockManager: LockManagerLike): StorageCleanupContext {
  return {
    lockManager,
    removeAllScratchDirs: vi.fn(async () => {}),
    removeScratchDir: vi.fn(async () => {}),
    removeAllCachedConversions: vi.fn(async () => {}),
    removeCachedConversion: vi.fn(async () => {}),
    refreshStorageInfo: vi.fn(async () => {}),
    reportError: vi.fn(),
    blockedByConversion: createBlockedCleanupStore(),
  };
}

const CACHED_A = { metaFileName: "a.meta.json", outputName: "a.copc.laz" };
const CACHED_B = { metaFileName: "b.meta.json", outputName: "b.copc.laz" };

function breakdownWith(scratchNames: string[], cachedOutputs: string[]): OpfsUsageBreakdown {
  return {
    cachedConversions: cachedOutputs.map((outputName) => ({
      outputName,
      metaFileName: `${outputName}.meta.json`,
      sourceName: `${outputName}.las`,
      sizeBytes: 1,
    })),
    cachedConversionsTotalBytes: cachedOutputs.length,
    staleScratchDirs: scratchNames.map((name) => ({ name, sizeBytes: 1 })),
    staleScratchTotalBytes: scratchNames.length,
  };
}

const EVERY_TARGET: StorageCleanupTarget[] = [
  { kind: "all-scratch" },
  { kind: "one-scratch", name: "pcv-scratch-a" },
  { kind: "all-cached" },
  { kind: "one-cached", entry: CACHED_A },
];

describe("removeStorageUnlessConverting", () => {
  it.each(EVERY_TARGET)("asks for the conversion lock by the same name, only if available: $kind", async (target) => {
    const lockManager = fakeLockManager(false);
    await removeStorageUnlessConverting(fakeContext(lockManager), target);
    expect(lockManager.requests).toEqual([{ name: CONVERSION_LOCK_NAME, options: { ifAvailable: true } }]);
  });

  it.each(EVERY_TARGET)("removes nothing and remembers the blocked button when a conversion holds the lock: $kind", async (target) => {
    const ctx = fakeContext(fakeLockManager(true));
    const outcome = await removeStorageUnlessConverting(ctx, target);
    expect(outcome).toBe("busy");
    expect(ctx.removeAllScratchDirs).not.toHaveBeenCalled();
    expect(ctx.removeScratchDir).not.toHaveBeenCalled();
    expect(ctx.removeAllCachedConversions).not.toHaveBeenCalled();
    expect(ctx.removeCachedConversion).not.toHaveBeenCalled();
    expect(ctx.refreshStorageInfo).not.toHaveBeenCalled();
    expect(ctx.blockedByConversion.get()).toEqual(target);
  });

  it("removes all scratch dirs and refreshes when the lock is free", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    const outcome = await removeStorageUnlessConverting(ctx, { kind: "all-scratch" });
    expect(outcome).toBe("removed");
    expect(ctx.removeAllScratchDirs).toHaveBeenCalledTimes(1);
    expect(ctx.removeScratchDir).not.toHaveBeenCalled();
    expect(ctx.removeAllCachedConversions).not.toHaveBeenCalled();
    expect(ctx.refreshStorageInfo).toHaveBeenCalledTimes(1);
    expect(ctx.blockedByConversion.get()).toBeNull();
  });

  it("removes only the named scratch dir when the lock is free", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    const outcome = await removeStorageUnlessConverting(ctx, { kind: "one-scratch", name: "pcv-scratch-a" });
    expect(outcome).toBe("removed");
    expect(ctx.removeScratchDir).toHaveBeenCalledWith("pcv-scratch-a");
    expect(ctx.removeAllScratchDirs).not.toHaveBeenCalled();
  });

  it("removes all cached conversions and refreshes when the lock is free", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    const outcome = await removeStorageUnlessConverting(ctx, { kind: "all-cached" });
    expect(outcome).toBe("removed");
    expect(ctx.removeAllCachedConversions).toHaveBeenCalledTimes(1);
    expect(ctx.removeCachedConversion).not.toHaveBeenCalled();
    expect(ctx.removeAllScratchDirs).not.toHaveBeenCalled();
    expect(ctx.refreshStorageInfo).toHaveBeenCalledTimes(1);
  });

  it("removes only the chosen cached conversion when the lock is free", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    const outcome = await removeStorageUnlessConverting(ctx, { kind: "one-cached", entry: CACHED_A });
    expect(outcome).toBe("removed");
    expect(ctx.removeCachedConversion).toHaveBeenCalledWith(CACHED_A);
    expect(ctx.removeAllCachedConversions).not.toHaveBeenCalled();
  });

  it.each(EVERY_TARGET)("clears the busy notice once a later press removes: $kind", async (target) => {
    const lockManager = fakeLockManager(true);
    const ctx = fakeContext(lockManager);
    await removeStorageUnlessConverting(ctx, target);
    lockManager.held = false;
    const outcome = await removeStorageUnlessConverting(ctx, target);
    expect(outcome).toBe("removed");
    expect(ctx.blockedByConversion.get()).toBeNull();
  });

  it("releases the lock when removing throws, so a later conversion can take it", async () => {
    const lockManager = fakeLockManager(false);
    const ctx = fakeContext(lockManager);
    ctx.removeAllCachedConversions = vi.fn(async () => {
      throw new Error("removeEntry failed");
    });
    const outcome = await removeStorageUnlessConverting(ctx, { kind: "all-cached" });
    expect(outcome).toBe("failed");
    expect(lockManager.held).toBe(false);
    expect(ctx.refreshStorageInfo).not.toHaveBeenCalled();
  });

  it("shows a failure to remove a scratch dir in the error log under the storage heading, not as a conversion error", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    ctx.removeScratchDir = vi.fn(async () => {
      throw new Error("getDirectory failed");
    });
    await removeStorageUnlessConverting(ctx, { kind: "one-scratch", name: "pcv-scratch-a" });
    expect(ctx.reportError).toHaveBeenCalledWith("一時ファイルを消せませんでした: getDirectory failed", "storage");
    expect(ctx.blockedByConversion.get()).toBeNull();
  });

  it("shows a failure to remove a cached conversion in the error log under the storage heading", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    ctx.removeCachedConversion = vi.fn(async () => {
      throw new Error("getDirectory failed");
    });
    await removeStorageUnlessConverting(ctx, { kind: "one-cached", entry: CACHED_A });
    expect(ctx.reportError).toHaveBeenCalledWith("変換済みキャッシュを消せませんでした: getDirectory failed", "storage");
  });

  it("keeps the busy notice of one viewer out of another viewer", async () => {
    const busyViewer = fakeContext(fakeLockManager(true));
    const otherViewer = fakeContext(fakeLockManager(true));
    await removeStorageUnlessConverting(busyViewer, { kind: "all-cached" });
    expect(otherViewer.blockedByConversion.get()).toBeNull();
  });
});

describe("refreshStorageAndForgetBlockedCleanup", () => {
  it.each(EVERY_TARGET)(
    "forgets the busy notice when the storage page is opened again after the conversion ended: $kind",
    async (target) => {
      const lockManager = fakeLockManager(true);
      const ctx = fakeContext(lockManager);
      await removeStorageUnlessConverting(ctx, target);
      lockManager.held = false;
      await refreshStorageAndForgetBlockedCleanup(ctx);
      expect(ctx.blockedByConversion.get()).toBeNull();
      expect(ctx.refreshStorageInfo).toHaveBeenCalledTimes(1);
    },
  );

  it("forgets the busy notice of a cached conversion row when the list is refreshed", async () => {
    const ctx = fakeContext(fakeLockManager(true));
    await removeStorageUnlessConverting(ctx, { kind: "one-cached", entry: CACHED_A });
    await refreshStorageAndForgetBlockedCleanup(ctx);
    expect(ctx.blockedByConversion.get()).toBeNull();
  });
});

describe("showsBusyNoticeFor", () => {
  const listed = breakdownWith(["pcv-scratch-a"], ["a.copc.laz"]);

  it("shows the notice only next to the button that was blocked", () => {
    expect(showsBusyNoticeFor({ kind: "all-cached" }, { kind: "all-cached" }, listed)).toBe(true);
    expect(showsBusyNoticeFor({ kind: "all-cached" }, { kind: "all-scratch" }, listed)).toBe(false);
    expect(showsBusyNoticeFor({ kind: "all-cached" }, { kind: "one-cached", entry: CACHED_A }, listed)).toBe(false);
    expect(showsBusyNoticeFor({ kind: "all-scratch" }, { kind: "all-scratch" }, listed)).toBe(true);
    expect(showsBusyNoticeFor({ kind: "all-scratch" }, { kind: "one-scratch", name: "pcv-scratch-a" }, listed)).toBe(false);
    expect(showsBusyNoticeFor(null, { kind: "all-cached" }, listed)).toBe(false);
  });

  it("matches the blocked row by name or output", () => {
    const blockedScratch: StorageCleanupTarget = { kind: "one-scratch", name: "pcv-scratch-a" };
    expect(showsBusyNoticeFor(blockedScratch, { kind: "one-scratch", name: "pcv-scratch-a" }, listed)).toBe(true);
    expect(showsBusyNoticeFor(blockedScratch, { kind: "one-scratch", name: "pcv-scratch-b" }, listed)).toBe(false);
    const blockedCached: StorageCleanupTarget = { kind: "one-cached", entry: CACHED_A };
    expect(showsBusyNoticeFor(blockedCached, { kind: "one-cached", entry: CACHED_A }, listed)).toBe(true);
    expect(showsBusyNoticeFor(blockedCached, { kind: "one-cached", entry: CACHED_B }, listed)).toBe(false);
  });

  it.each(EVERY_TARGET)("hides the notice once its target is no longer listed: $kind", (target) => {
    expect(showsBusyNoticeFor(target, target, listed)).toBe(true);
    expect(showsBusyNoticeFor(target, target, breakdownWith([], []))).toBe(false);
  });

  it("hides the notice of a removed cached row while the other rows stay", () => {
    const onlyB = breakdownWith([], ["b.copc.laz"]);
    expect(showsBusyNoticeFor({ kind: "one-cached", entry: CACHED_A }, { kind: "one-cached", entry: CACHED_A }, onlyB)).toBe(
      false,
    );
    expect(showsBusyNoticeFor({ kind: "all-cached" }, { kind: "all-cached" }, onlyB)).toBe(true);
  });
});
