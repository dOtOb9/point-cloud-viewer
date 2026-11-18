import { useEffect, useRef, useState } from "react";
import { onFilesDroppedToOpen } from "../datasource/file-picker";

export function useFileDrop(openFiles: (items: string[] | File[]) => Promise<void>): boolean {
  const [dragging, setDragging] = useState(false);
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
      .catch((e: unknown) => console.error("onFilesDroppedToOpen failed", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return dragging;
}
