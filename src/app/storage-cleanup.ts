import {
  withConversionLock,
  type CachedConversionEntry,
  type LockManagerLike,
  type OpfsUsageBreakdown,
} from "../datasource/opfs";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { createStore, type Store } from "./store";

export type CachedConversionKey = Pick<CachedConversionEntry, "metaFileName" | "outputName">;

export type StorageCleanupTarget =
  | { kind: "all-scratch" }
  | { kind: "one-scratch"; name: string }
  | { kind: "all-cached" }
  | { kind: "one-cached"; entry: CachedConversionKey };

export type StorageCleanupOutcome = "removed" | "busy" | "failed";

export interface StorageCleanupContext {
  lockManager: LockManagerLike;
  removeAllScratchDirs: () => Promise<void>;
  removeScratchDir: (name: string) => Promise<void>;
  removeAllCachedConversions: () => Promise<void>;
  removeCachedConversion: (entry: CachedConversionKey) => Promise<void>;
  refreshStorageInfo: () => Promise<void>;
  reportError: (message: string, source: GpuErrorSource) => void;
  blockedByConversion: Store<StorageCleanupTarget | null>;
}

export const STORAGE_CLEANUP_BUSY_MESSAGE = "変換・ツールの実行中なので消せません。終わってからもう一度押してください。";

export function createBlockedCleanupStore(): Store<StorageCleanupTarget | null> {
  return createStore<StorageCleanupTarget | null>(null);
}

function removeTarget(ctx: StorageCleanupContext, target: StorageCleanupTarget): Promise<void> {
  switch (target.kind) {
    case "all-scratch":
      return ctx.removeAllScratchDirs();
    case "one-scratch":
      return ctx.removeScratchDir(target.name);
    case "all-cached":
      return ctx.removeAllCachedConversions();
    case "one-cached":
      return ctx.removeCachedConversion(target.entry);
  }
}

function failureMessage(target: StorageCleanupTarget, cause: string): string {
  const what = target.kind === "all-scratch" || target.kind === "one-scratch" ? "一時ファイル" : "変換済みキャッシュ";
  return `${what}を消せませんでした: ${cause}`;
}

export async function removeStorageUnlessConverting(
  ctx: StorageCleanupContext,
  target: StorageCleanupTarget,
): Promise<StorageCleanupOutcome> {
  ctx.blockedByConversion.set(null);
  try {
    const outcome = await withConversionLock(ctx.lockManager, () => removeTarget(ctx, target));
    if (outcome.kind === "busy") {
      ctx.blockedByConversion.set(target);
      return "busy";
    }
  } catch (e: unknown) {
    const cause = e instanceof Error ? e.message : String(e);
    ctx.reportError(failureMessage(target, cause), "storage");
    return "failed";
  }
  await ctx.refreshStorageInfo();
  return "removed";
}

export async function refreshStorageAndForgetBlockedCleanup(ctx: StorageCleanupContext): Promise<void> {
  ctx.blockedByConversion.set(null);
  await ctx.refreshStorageInfo();
}

function isSameTarget(a: StorageCleanupTarget, b: StorageCleanupTarget): boolean {
  if (a.kind === "one-scratch" && b.kind === "one-scratch") return a.name === b.name;
  if (a.kind === "one-cached" && b.kind === "one-cached") return a.entry.outputName === b.entry.outputName;
  return a.kind === b.kind;
}

function targetStillListed(breakdown: OpfsUsageBreakdown, target: StorageCleanupTarget): boolean {
  switch (target.kind) {
    case "all-scratch":
      return breakdown.staleScratchDirs.length > 0;
    case "one-scratch":
      return breakdown.staleScratchDirs.some((dir) => dir.name === target.name);
    case "all-cached":
      return breakdown.cachedConversions.length > 0;
    case "one-cached":
      return breakdown.cachedConversions.some((entry) => entry.outputName === target.entry.outputName);
  }
}

export function showsBusyNoticeFor(
  blocked: StorageCleanupTarget | null,
  target: StorageCleanupTarget,
  breakdown: OpfsUsageBreakdown,
): boolean {
  return blocked !== null && isSameTarget(blocked, target) && targetStillListed(breakdown, target);
}
