import { useEffect, useRef, useState } from "react";
import { onFilesDroppedToOpen } from "../datasource/file-picker";

/**
 * ADR-0017: open files by drag and drop. Returns whether a drag is in progress (for the overlay hint).
 *
 * How the drop arrives (DOM events on the Web, the Tauri event on desktop) is the data source's
 * concern: see `onFilesDroppedToOpen` in `src/datasource/file-picker.ts`. The dropped items are
 * `File`s on the Web and paths on desktop, and both go straight to `openFiles`.
 *
 * Opening is the same `openFiles` as the file chooser (several files are merged, one file behaves as before).
 * There is no way to type a path (owner requirement).
 */
export function useFileDrop(openFiles: (items: string[] | File[]) => Promise<void>): boolean {
  const [dragging, setDragging] = useState(false);
  // Ref to the latest openFiles, so it can be called without resubscribing (same reason as openFileRef in useCopcViewer.ts).
  const openFilesRef = useRef(openFiles);
  useEffect(() => {
    openFilesRef.current = openFiles;
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onFilesDroppedToOpen((items) => void openFilesRef.current(items), setDragging)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      // Still console only (not `reportError`): the hook has no access to the viewer state.
      .catch((e: unknown) => console.error("onFilesDroppedToOpen failed", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return dragging;
}
