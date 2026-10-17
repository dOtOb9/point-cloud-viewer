// How files arrive on this platform: the file chooser and drag and drop.
// The UI and state call only these two functions; they never branch on the platform themselves.
//
// Desktop/Android: the Tauri dialog and drop event, behind `tauri.ts` (rule 2: only that file
// imports the Tauri packages). Web: a plain `<input type="file">` and the window's DOM drag events.

import { isTauriEnvironment } from "./environment";
import { fileExtensionsOf, openableFormatsOn } from "./source-format";
import { onFilesDropped, pickLocalFiles } from "./tauri";

/**
 * Shows the platform's file chooser. Resolves null when the user cancels.
 * Desktop resolves file paths; the Web build resolves `File` objects (a browser gives no paths).
 *
 * Call this as the first thing in a click handler: the Web chooser must be opened synchronously
 * (see `pickFilesOnWeb`).
 */
export function pickFilesToOpen(): Promise<string[] | File[] | null> {
  if (isTauriEnvironment()) return pickLocalFiles();
  return pickFilesOnWeb();
}

/**
 * Subscribes to files dropped on the window. `onDragging` is called with true while files are dragged
 * over the window and false when they leave or drop. Returns an unsubscribe function.
 */
export function onFilesDroppedToOpen(
  onFiles: (items: string[] | File[]) => void,
  onDragging: (dragging: boolean) => void,
): Promise<() => void> {
  if (isTauriEnvironment()) return onFilesDropped(onFiles, onDragging);
  return Promise.resolve(listenForWebDrop(onFiles, onDragging));
}

function pickFilesOnWeb(): Promise<File[] | null> {
  return new Promise((resolve) => {
    // The input is not attached to the document. If a browser needs it attached, attach it hidden
    // and remove it after (see the Record in TaskSheets/R6-file-picker-in-datasource.md).
    const input = document.createElement("input");
    input.type = "file";
    // M4-14: several files can be chosen (one file behaves as before).
    input.multiple = true;
    // M4-3/M4-6b/M4-9: raw LAS/LAZ and PCD can be chosen too (the Web build converts them to COPC on OPFS).
    input.accept = fileExtensionsOf(openableFormatsOn("web"))
      .map((ext) => `.${ext}`)
      .join(",");
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      resolve(files.length > 0 ? files : null);
    });
    // Fired by current browsers when the dialog is closed without a choice. If a browser never fires it,
    // this promise stays pending, which is harmless: nothing waits on it except the click handler.
    input.addEventListener("cancel", () => resolve(null));
    // `click()` must run synchronously inside the caller's click handler, before any `await`; otherwise
    // the browser blocks the chooser as not user-initiated. That is why this function is not `async`.
    input.click();
  });
}

function listenForWebDrop(
  onFiles: (items: File[]) => void,
  onDragging: (dragging: boolean) => void,
): () => void {
  // Only drags that contain files count (dragging selected text etc. is ignored).
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    onDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    // Clear only when the pointer leaves the window (relatedTarget is null).
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
