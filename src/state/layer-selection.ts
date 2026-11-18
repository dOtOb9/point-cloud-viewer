import { isMeasureLayer, type ViewerLayer } from "./layers";

export function effectiveSelectedIds(layers: readonly ViewerLayer[], primaryId: string | null, stored: readonly string[]): string[] {
  if (primaryId === null) return [];
  const alive = stored.filter((id) => layers.some((l) => l.id === id));
  return alive.includes(primaryId) ? alive : [primaryId];
}

export function toggleSelectedId(
  layers: readonly ViewerLayer[],
  primaryId: string | null,
  stored: readonly string[],
  id: string,
): { primaryId: string | null; ids: string[] } {
  const current = effectiveSelectedIds(layers, primaryId, stored);
  if (current.includes(id)) {
    const ids = current.filter((x) => x !== id);
    const nextPrimary = id === primaryId ? (ids[ids.length - 1] ?? null) : primaryId;
    return { primaryId: nextPrimary, ids };
  }
  return { primaryId: id, ids: [...current, id] };
}

export function rangeSelectedIds(layers: readonly ViewerLayer[], primaryId: string | null, id: string): string[] {
  const to = layers.findIndex((l) => l.id === id);
  if (to < 0) return [];
  const from = primaryId === null ? -1 : layers.findIndex((l) => l.id === primaryId);
  if (from < 0) return [id];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return layers.slice(lo, hi + 1).map((l) => l.id);
}

export function toolSourceLayers(layers: readonly ViewerLayer[], ids: readonly string[]): ViewerLayer[] {
  return layers.filter((l) => ids.includes(l.id) && !isMeasureLayer(l) && typeof l.sourcePath === "string");
}
