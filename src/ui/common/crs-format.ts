import type { CrsInfo } from "../../datasource/DataSource";

// CRS(座標参照系)を画面向けの文字列にする純粋関数。
// 左パネルのレイヤー情報(長い形)とステータスバー(短い形)が使う。
// Rust側(pcv-core の CrsInfo)が名前とEPSGコードを決めて渡してくるので、ここは
// 並べ方だけを決める。

/** 読み取りに失敗したときの文言。詳細(エラー本文)はエラーログに出る。 */
export const CRS_READ_FAILED = "読み取れなかった";
export const CRS_NONE_LONG = "なし（ファイルに座標系情報が無い）";

/** 左パネル用。例: 「JGD2011 / 平面直角座標系 第IX系 (EPSG:6677)」。 */
export function formatCrsLong(crs: CrsInfo): string {
  if (crs.error) return CRS_READ_FAILED;
  if (crs.kind === "none") return CRS_NONE_LONG;
  if (crs.epsg === undefined) return crs.name;
  const code = `EPSG:${crs.epsg}`;
  // 名前がコードそのもの(名前を取れなかったとき)なら重ねて書かない。
  return crs.name === code ? code : `${crs.name} (${code})`;
}

/** ステータスバー用。例: 「EPSG:6677」。EPSGが無ければ名前、読めなければその旨。 */
export function formatCrsShort(crs: CrsInfo): string {
  if (crs.error) return CRS_READ_FAILED;
  if (crs.kind === "none") return "なし";
  return crs.epsg !== undefined ? `EPSG:${crs.epsg}` : crs.name;
}
