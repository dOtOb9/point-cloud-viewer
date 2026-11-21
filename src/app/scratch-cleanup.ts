import { withConversionLock, type LockManagerLike } from "../datasource/opfs";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { createStore, type Store } from "./store";

export type ScratchCleanupTarget = { kind: "all" } | { kind: "one"; name: string };

export type ScratchCleanupOutcome = "removed" | "busy" | "failed";

export interface ScratchCleanupContext {
  lockManager: LockManagerLike;
  removeAllScratchDirs: () => Promise<void>;
  removeScratchDir: (name: string) => Promise<void>;
  refreshStorageInfo: () => Promise<void>;
  reportError: (message: string, source: GpuErrorSource) => void;
  blockedByConversion: Store<ScratchCleanupTarget | null>;
}

export const SCRATCH_CLEANUP_BUSY_MESSAGE = "変換・ツールの実行中なので消せません。終わってからもう一度押してください。";

export function createBlockedCleanupStore(): Store<ScratchCleanupTarget | null> {
  return createStore<ScratchCleanupTarget | null>(null);
}

function removeTarget(ctx: ScratchCleanupContext, target: ScratchCleanupTarget): Promise<void> {
  return target.kind === "all" ? ctx.removeAllScratchDirs() : ctx.removeScratchDir(target.name);
}

export async function removeScratchDirsUnlessConverting(
  ctx: ScratchCleanupContext,
  target: ScratchCleanupTarget,
): Promise<ScratchCleanupOutcome> {
  ctx.blockedByConversion.set(null);
  try {
    const outcome = await withConversionLock(ctx.lockManager, () => removeTarget(ctx, target));
    if (outcome.kind === "busy") {
      ctx.blockedByConversion.set(target);
      return "busy";
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.reportError(`一時ファイルを消せませんでした: ${message}`, "storage");
    return "failed";
  }
  await ctx.refreshStorageInfo();
  return "removed";
}

export async function refreshStorageAndForgetBlockedCleanup(ctx: ScratchCleanupContext): Promise<void> {
  ctx.blockedByConversion.set(null);
  await ctx.refreshStorageInfo();
}

export function isBlockedCleanupFor(
  blocked: ScratchCleanupTarget | null,
  target: ScratchCleanupTarget,
): boolean {
  if (blocked === null || blocked.kind !== target.kind) return false;
  return blocked.kind === "all" || (target.kind === "one" && blocked.name === target.name);
}
