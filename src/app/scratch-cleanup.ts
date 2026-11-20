import { withConversionLock, type LockManagerLike } from "../datasource/opfs";
import { createStore, type Store } from "./store";

export type ScratchCleanupTarget = { kind: "all" } | { kind: "one"; name: string };

export type ScratchCleanupOutcome = "removed" | "busy";

export interface ScratchCleanupContext {
  lockManager: LockManagerLike;
  removeAllScratchDirs: () => Promise<void>;
  removeScratchDir: (name: string) => Promise<void>;
  refreshStorageInfo: () => Promise<void>;
  blockedByConversion: Store<ScratchCleanupTarget | null>;
}

export const scratchCleanupBlockedByConversion: Store<ScratchCleanupTarget | null> =
  createStore<ScratchCleanupTarget | null>(null);

export const SCRATCH_CLEANUP_BUSY_MESSAGE = "変換・ツールの実行中なので消せません。終わってからもう一度押してください。";

function removeTarget(ctx: ScratchCleanupContext, target: ScratchCleanupTarget): Promise<void> {
  return target.kind === "all" ? ctx.removeAllScratchDirs() : ctx.removeScratchDir(target.name);
}

export async function removeScratchDirsUnlessConverting(
  ctx: ScratchCleanupContext,
  target: ScratchCleanupTarget,
): Promise<ScratchCleanupOutcome> {
  ctx.blockedByConversion.set(null);
  const outcome = await withConversionLock(ctx.lockManager, () => removeTarget(ctx, target));
  if (outcome.kind === "busy") {
    ctx.blockedByConversion.set(target);
    return "busy";
  }
  await ctx.refreshStorageInfo();
  return "removed";
}

export function isBlockedCleanupFor(
  blocked: ScratchCleanupTarget | null,
  target: ScratchCleanupTarget,
): boolean {
  if (blocked === null || blocked.kind !== target.kind) return false;
  return blocked.kind === "all" || (target.kind === "one" && blocked.name === target.name);
}
