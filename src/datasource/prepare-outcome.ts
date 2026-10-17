// Pure helpers for `DataSource.prepareToOpen`: the error text of the desktop "not enough disk space" outcome.
// (The Web counterpart, `describeInsufficientSpaceWeb`, is in opfs.ts because it reads OPFS numbers.)
// Used by: tauri.ts, web.ts (through `toPrepareOutcome`, added in a later commit).

/** Error text for the desktop "not enough disk space" outcome (sizes in GiB, one decimal). */
export function describeInsufficientSpaceDesktop(requiredBytes: number, availableBytes: number): string {
  const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `空き容量が足りません(必要: 約${toGiB(requiredBytes)}GiB、空き: 約${toGiB(availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`;
}
