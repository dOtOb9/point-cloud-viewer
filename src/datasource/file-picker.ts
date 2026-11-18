import { isTauriEnvironment } from "./environment";
import { OPENABLE_EXTENSIONS } from "./source-format";
import { onFilesDropped, pickLocalFiles } from "./tauri";

export function pickFilesToOpen(): Promise<string[] | File[] | null> {
  if (isTauriEnvironment()) return pickLocalFiles();
  return pickFilesOnWeb();
}

export function onFilesDroppedToOpen(
  onFiles: (items: string[] | File[]) => void,
  onDragging: (dragging: boolean) => void,
): Promise<() => void> {
  if (isTauriEnvironment()) return onFilesDropped(onFiles, onDragging);
  return Promise.resolve(listenForWebDrop(onFiles, onDragging));
}

function pickFilesOnWeb(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = OPENABLE_EXTENSIONS.map((ext) => `.${ext}`).join(",");
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      resolve(files.length > 0 ? files : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function listenForWebDrop(
  onFiles: (items: File[]) => void,
  onDragging: (dragging: boolean) => void,
): () => void {
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    onDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (e.relatedTarget === null) onDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    onDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(files);
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
  };
}
