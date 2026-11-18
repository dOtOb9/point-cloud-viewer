import type { CrsInfo } from "../../datasource/DataSource";

export const CRS_READ_FAILED = "読み取れなかった";
export const CRS_NONE_LONG = "なし（ファイルに座標系情報が無い）";

export function formatCrsLong(crs: CrsInfo): string {
  if (crs.error) return CRS_READ_FAILED;
  if (crs.kind === "none") return CRS_NONE_LONG;
  if (crs.epsg === undefined) return crs.name;
  const code = `EPSG:${crs.epsg}`;
  return crs.name === code ? code : `${crs.name} (${code})`;
}

export function formatCrsShort(crs: CrsInfo): string {
  if (crs.error) return CRS_READ_FAILED;
  if (crs.kind === "none") return "なし";
  return crs.epsg !== undefined ? `EPSG:${crs.epsg}` : crs.name;
}
