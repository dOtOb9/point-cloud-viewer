import type { GpuErrorEntry } from "../renderer/gpu-error-log";

export function mergeErrorHistory(previous: GpuErrorEntry[], current: GpuErrorEntry[]): GpuErrorEntry[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry] as const));
  for (const entry of current) byId.set(entry.id, entry);
  return Array.from(byId.values()).sort((a, b) => a.firstAt - b.firstAt);
}
