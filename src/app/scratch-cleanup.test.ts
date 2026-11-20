import { describe, expect, it, vi } from "vitest";
import { CONVERSION_LOCK_NAME, type LockManagerLike } from "../datasource/opfs";
import {
  isBlockedCleanupFor,
  removeScratchDirsUnlessConverting,
  type ScratchCleanupContext,
  type ScratchCleanupTarget,
} from "./scratch-cleanup";
import { createStore } from "./store";

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

function fakeContext(lockManager: LockManagerLike): ScratchCleanupContext {
  return {
    lockManager,
    removeAllScratchDirs: vi.fn(async () => {}),
    removeScratchDir: vi.fn(async () => {}),
    refreshStorageInfo: vi.fn(async () => {}),
    blockedByConversion: createStore<ScratchCleanupTarget | null>(null),
  };
}

describe("removeScratchDirsUnlessConverting", () => {
  it("asks for the conversion lock by the same name, only if available", async () => {
    const lockManager = fakeLockManager(false);
    await removeScratchDirsUnlessConverting(fakeContext(lockManager), { kind: "all" });
    expect(lockManager.requests).toEqual([{ name: CONVERSION_LOCK_NAME, options: { ifAvailable: true } }]);
  });

  it("removes all scratch dirs and refreshes when the lock is free", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    const outcome = await removeScratchDirsUnlessConverting(ctx, { kind: "all" });
    expect(outcome).toBe("removed");
    expect(ctx.removeAllScratchDirs).toHaveBeenCalledTimes(1);
    expect(ctx.removeScratchDir).not.toHaveBeenCalled();
    expect(ctx.refreshStorageInfo).toHaveBeenCalledTimes(1);
    expect(ctx.blockedByConversion.get()).toBeNull();
  });

  it("removes only the named scratch dir when the lock is free", async () => {
    const ctx = fakeContext(fakeLockManager(false));
    const outcome = await removeScratchDirsUnlessConverting(ctx, { kind: "one", name: "pcv-scratch-a" });
    expect(outcome).toBe("removed");
    expect(ctx.removeScratchDir).toHaveBeenCalledWith("pcv-scratch-a");
    expect(ctx.removeAllScratchDirs).not.toHaveBeenCalled();
  });

  it("removes nothing and reports busy when a conversion holds the lock", async () => {
    const ctx = fakeContext(fakeLockManager(true));
    const outcome = await removeScratchDirsUnlessConverting(ctx, { kind: "all" });
    expect(outcome).toBe("busy");
    expect(ctx.removeAllScratchDirs).not.toHaveBeenCalled();
    expect(ctx.removeScratchDir).not.toHaveBeenCalled();
    expect(ctx.blockedByConversion.get()).toEqual({ kind: "all" });
  });

  it("keeps the named dir when a conversion holds the lock and remembers which button was blocked", async () => {
    const ctx = fakeContext(fakeLockManager(true));
    const outcome = await removeScratchDirsUnlessConverting(ctx, { kind: "one", name: "pcv-scratch-a" });
    expect(outcome).toBe("busy");
    expect(ctx.removeScratchDir).not.toHaveBeenCalled();
    expect(ctx.blockedByConversion.get()).toEqual({ kind: "one", name: "pcv-scratch-a" });
  });

  it("clears the busy notice once a later press removes", async () => {
    const lockManager = fakeLockManager(true);
    const ctx = fakeContext(lockManager);
    await removeScratchDirsUnlessConverting(ctx, { kind: "all" });
    lockManager.held = false;
    const outcome = await removeScratchDirsUnlessConverting(ctx, { kind: "all" });
    expect(outcome).toBe("removed");
    expect(ctx.blockedByConversion.get()).toBeNull();
  });

  it("releases the lock when removing throws, so a later conversion can take it", async () => {
    const lockManager = fakeLockManager(false);
    const ctx = fakeContext(lockManager);
    const failure = new Error("removeEntry failed");
    ctx.removeAllScratchDirs = vi.fn(async () => {
      throw failure;
    });
    await expect(removeScratchDirsUnlessConverting(ctx, { kind: "all" })).rejects.toBe(failure);
    expect(lockManager.held).toBe(false);
    expect(ctx.refreshStorageInfo).not.toHaveBeenCalled();
  });
});

describe("isBlockedCleanupFor", () => {
  it("matches the blocked remove-all button only", () => {
    expect(isBlockedCleanupFor({ kind: "all" }, { kind: "all" })).toBe(true);
    expect(isBlockedCleanupFor({ kind: "all" }, { kind: "one", name: "a" })).toBe(false);
  });

  it("matches the blocked row by name", () => {
    expect(isBlockedCleanupFor({ kind: "one", name: "a" }, { kind: "one", name: "a" })).toBe(true);
    expect(isBlockedCleanupFor({ kind: "one", name: "a" }, { kind: "one", name: "b" })).toBe(false);
    expect(isBlockedCleanupFor({ kind: "one", name: "a" }, { kind: "all" })).toBe(false);
    expect(isBlockedCleanupFor(null, { kind: "all" })).toBe(false);
  });
});
