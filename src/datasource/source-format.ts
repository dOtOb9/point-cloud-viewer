export type SourceFormat = "lasLaz" | "pcd" | "ply" | "e57" | "unknown";

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

export const OPENABLE_EXTENSIONS = ["las", "laz", "e57", "ply", "pcd"] as const;

export function needsPointMerge(fileNames: string[]): boolean {
  return fileNames.some((name) => {
    const format = detectSourceFormatByName(name);
    return format === "pcd" || format === "ply" || format === "e57";
  });
}

export function multiSourceFormatLabel(fileNames: string[]): string {
  return needsPointMerge(fileNames) ? "複数ファイル(形式混在)" : "las/laz(複数ファイル)";
}
