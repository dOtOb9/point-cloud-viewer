// Pure helpers for file names (no React, no I/O), unit-tested in file-name.test.ts.
// Used by: tauri.ts, web.ts (the name of a conversion result, the "format" row of the breakdown),
// and app/open-files.ts (the name shown while opening).

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
