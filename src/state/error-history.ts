// Pure helper for the session error history (ADR-0017): merge the current error list into the history.
// Used by: useErrorLog.ts.
import type { GpuErrorEntry } from "../renderer/gpu-error-log";

/**
 * Add or update entries by id, never remove any, and return them oldest first (`firstAt`).
 * The history keeps errors the user dismissed from the banner, so the error log dialog can show them later.
 */
export function mergeErrorHistory(previous: GpuErrorEntry[], current: GpuErrorEntry[]): GpuErrorEntry[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry] as const));
  for (const entry of current) byId.set(entry.id, entry);
  return Array.from(byId.values()).sort((a, b) => a.firstAt - b.firstAt);
}
