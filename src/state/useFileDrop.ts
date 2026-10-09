import { useEffect, useRef, useState } from "react";
import { onFilesDropped } from "../datasource/tauri";

/**
 * ADR-0017: ファイルのドラッグ&ドロップで開く。戻り値は「ドラッグ中か」(重ねて出す案内用)。
 *
 * - Web: ブラウザ標準のdragover/drop。`File`をそのまま`openFiles`へ渡す。
 * - デスクトップ(Tauri): OSのドロップはDOMのdropでは届かないため、Tauriのイベントを
 *   `src/datasource/tauri.ts`の`onFilesDropped`越しに受け取る(規約2: Tauriのパッケージは
 *   そこだけがimportする)。受け取るのはパスで、`openFiles`にそのまま渡す。
 *
 * 開く処理はファイル選択ダイアログと同じ`openFiles`(複数ならマージ、1件なら従来どおり)。
 * パスを人が打つ口は作らない(所有者の要件)。
 */
export function useFileDrop(isBrowser: boolean, openFiles: (items: string[] | File[]) => Promise<void>): boolean {
  const [dragging, setDragging] = useState(false);
  // 最新のopenFilesを、購読を張り直さずに呼ぶためのref(useCopcViewer.tsのopenFileRefと同じ理由)。
  const openFilesRef = useRef(openFiles);
  useEffect(() => {
    openFilesRef.current = openFiles;
  });

  useEffect(() => {
    if (isBrowser) {
      // ファイルを含むドラッグだけを対象にする(テキスト選択のドラッグ等は無視)。
      const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
      const onDragOver = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      };
      const onDragLeave = (e: DragEvent) => {
        // ウィンドウの外へ出たとき(relatedTargetがnull)だけ解除する。
        if (e.relatedTarget === null) setDragging(false);
      };
      const onDrop = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) void openFilesRef.current(files);
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

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onFilesDropped(
      (paths) => void openFilesRef.current(paths),
      setDragging,
    )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e: unknown) => console.error("onFilesDropped failed", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isBrowser]);

  return dragging;
}
