// Pure helpers for the "open / convert a file" flow: file-name handling and error texts.
// No React, no I/O, so each one is unit-tested (open-file-text.test.ts).
// Used by: useFileOpen.ts, useConversionSession.ts.

/**
 * M4-12 (`TaskSheets/M4-import-and-conversion.md`): the part of `path` after the last separator
 * (backslash and slash both work). Used for extension checks and the breakdown text. The path need not exist,
 * the same simplification as `pcv_convert::output_path`.
 */
export function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

/** Extension of a file name in lower case, or "(不明)" when there is none. Shown in the "形式" row of the breakdown. */
export function extensionOfFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "(不明)" : fileName.slice(dotIndex + 1).toLowerCase();
}

/** Error text for the desktop "not enough disk space" outcome (sizes in GiB, one decimal). */
export function describeInsufficientSpaceDesktop(requiredBytes: number, availableBytes: number): string {
  const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `空き容量が足りません(必要: 約${toGiB(requiredBytes)}GiB、空き: 約${toGiB(availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`;
}
