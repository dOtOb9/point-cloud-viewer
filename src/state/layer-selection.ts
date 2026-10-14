// L2-F: selecting several layers in the layer list (pure functions).
//
// The list keeps one "primary" selection (`selectedLayerId`: the layer the action buttons act on, the
// one chosen last) and, in addition, a list of ids that are selected together for the multi-layer tool.
// The extra list is only trusted while it contains the primary id; otherwise the selection is just the
// primary. That happens by itself after a plain click, an open or a delete, so those places do not have
// to reset the list.

import { isMeasureLayer, type ViewerLayer } from "./layers";

/** The ids that are selected: `stored` kept to existing layers, or just the primary when it is stale. */
export function effectiveSelectedIds(layers: readonly ViewerLayer[], primaryId: string | null, stored: readonly string[]): string[] {
  if (primaryId === null) return [];
  const alive = stored.filter((id) => layers.some((l) => l.id === id));
  return alive.includes(primaryId) ? alive : [primaryId];
}

/** Ctrl/Cmd click: add the layer (it becomes the primary), or remove it if already selected. */
export function toggleSelectedId(
  layers: readonly ViewerLayer[],
  primaryId: string | null,
  stored: readonly string[],
  id: string,
): { primaryId: string | null; ids: string[] } {
  const current = effectiveSelectedIds(layers, primaryId, stored);
  if (current.includes(id)) {
    const ids = current.filter((x) => x !== id);
    // Removing the primary hands the primary to the one added most recently before it (the last in the list).
    const nextPrimary = id === primaryId ? (ids[ids.length - 1] ?? null) : primaryId;
    return { primaryId: nextPrimary, ids };
  }
  return { primaryId: id, ids: [...current, id] };
}

/** Shift click: select the rows between the primary (the anchor) and the clicked row, both included. */
export function rangeSelectedIds(layers: readonly ViewerLayer[], primaryId: string | null, id: string): string[] {
  const to = layers.findIndex((l) => l.id === id);
  if (to < 0) return [];
  const from = primaryId === null ? -1 : layers.findIndex((l) => l.id === primaryId);
  if (from < 0) return [id];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return layers.slice(lo, hi + 1).map((l) => l.id);
}

/** Point-cloud layers a tool can read: not measurement layers, and with a path to read. In list order. */
export function toolSourceLayers(layers: readonly ViewerLayer[], ids: readonly string[]): ViewerLayer[] {
  return layers.filter((l) => ids.includes(l.id) && !isMeasureLayer(l) && typeof l.sourcePath === "string");
}
