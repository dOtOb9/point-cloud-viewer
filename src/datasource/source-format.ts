// M4-9追記(`TaskSheets/M4-import-and-conversion.md`): Web版で選んだファイルが
// どの形式かを、変換を試みる前に判定する。
//
// 所有者の実機不具合(PCDを開くと「空き容量が足りません」と出る)の原因の一つ:
// Web版は`isCopcFile`でCOPCでないと分かったファイルを、形式を確かめずすべて
// LAS/LAZ変換の経路(`WebSource.startConversion`)に回していた。PCD(sofi.pcd、
// 9.47GB)はLAS/LAZではないため、ファイルサイズ×11というLAS/LAZ向けの見積もりが
// 大きく外れた値になり、誤って「空き容量不足」と判定されていた。
//
// 拡張子で判定する(`crates/pcv-convert/src/import/mod.rs`の`detect_format`と
// 同じ考え方・同じ大文字小文字を区別しない判定)。`isCopcFile`(ヘッダーで
// 判定)とは役割が違う: こちらは「どの変換経路に回すか」、`isCopcFile`は
// 「そもそも変換が要るか」を判定する。

export type SourceFormat = "lasLaz" | "pcd" | "ply" | "e57" | "unknown";

/** ファイル名の拡張子から形式を判定する(大文字小文字を区別しない)。 */
export function detectSourceFormatByName(fileName: string): SourceFormat {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return "unknown";
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  switch (ext) {
    case "las":
    case "laz":
      return "lasLaz";
    case "pcd":
      return "pcd";
    case "ply":
      return "ply";
    case "e57":
      return "e57";
    default:
      return "unknown";
  }
}

/**
 * Every format the app opens (converts to COPC). One list for all platforms: the desktop dialog filter,
 * the Web picker's `accept` and the Web "cannot convert yet" check are all built from it.
 * The order is the order shown in the desktop dialog.
 */
export const OPENABLE_FORMATS: readonly SourceFormat[] = ["lasLaz", "e57", "ply", "pcd"];

/**
 * The Web build has no PLY/E57 conversion yet (M4-9). The owner intends Web and desktop to match;
 * delete this list (and its uses) when the Web conversion exists.
 */
export const NOT_YET_CONVERTIBLE_ON_WEB: readonly SourceFormat[] = ["ply", "e57"];

export type Platform = "web" | "desktop";

/** The formats this platform can open: all of `OPENABLE_FORMATS`, minus the temporary Web gap on "web". */
export function openableFormatsOn(platform: Platform): SourceFormat[] {
  return OPENABLE_FORMATS.filter((f) => platform === "desktop" || !NOT_YET_CONVERTIBLE_ON_WEB.includes(f));
}

/** File name extensions (without the dot, lower case) of the given formats. */
export function fileExtensionsOf(formats: readonly SourceFormat[]): string[] {
  return formats.flatMap((format): string[] => {
    switch (format) {
      case "lasLaz":
        return ["las", "laz"];
      case "pcd":
        return ["pcd"];
      case "ply":
        return ["ply"];
      case "e57":
        return ["e57"];
      case "unknown":
        return [];
    }
  });
}
