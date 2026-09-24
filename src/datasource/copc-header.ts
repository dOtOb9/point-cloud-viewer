// M4-3: Web版で「選んだファイルがCOPCかどうか」を、拡張子ではなくヘッダーで
// 判定する。Rust側の`crates/pcv-convert/src/copc_detect.rs`(`is_copc_file`)と
// 同じ考え方(受け入れ条件「拡張子だけでなく、ヘッダーで判定するのが確実」)を
// Web版でも一貫させる。Web版はLAS/LAZの変換ができない(ADR-0006: 変換は
// デスクトップとAndroidのみ、Webは別段階M4-6)ため、選んだファイルが生LAZ/LASだと
// 分かった時点で「デスクトップ版で変換してください」と知らせるために使う
// (`LayerPanel.tsx`参照)。
//
// LASヘッダーのバイナリレイアウトを自前で最小限だけ読む(Rustと違い`las`相当の
// パーサライブラリはWeb側に無いため)。COPCの仕様は「COPC info VLRは
// ファイル中の最初のVLR」と定めており、`copc-writer`(Rust側の書き出し実装)も
// この前提で書く(`M4-import-and-conversion.md`のM4-1実施記録参照)。そのため
// 「ヘッダーの直後にあるVLRのuser_id/record_idを見る」だけで判定できる。
//
// LASヘッダーのバイト配置(LAS 1.2〜1.4共通、出典: ASPRS LAS仕様書):
// - オフセット94: Header Size (u16 LE)
// VLRレコード(ヘッダー直後から開始)のバイト配置:
// - オフセット+2: User ID (16バイト、ヌル終端されうるASCII)
// - オフセット+18: Record ID (u16 LE)

const HEADER_SIZE_OFFSET = 94;
const VLR_USER_ID_OFFSET = 2;
const VLR_USER_ID_LENGTH = 16;
const VLR_RECORD_ID_OFFSET = 18;
const VLR_HEADER_MIN_BYTES = 20;

const COPC_INFO_USER_ID = "copc";
const COPC_INFO_RECORD_ID = 1;

/**
 * バイト列(ファイル先頭を含む十分な長さ、目安として先頭512バイト程度)から、
 * LAS/LAZファイルの最初のVLRがCOPC info VLRかどうかを判定する。
 *
 * 判定できない(LASヘッダーとして短すぎる等)場合は`false`を返す
 * (「COPCと確認できなければ生LAZ/LASとして扱う」という安全側の既定)。
 */
export function isCopcHeader(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_SIZE_OFFSET + 2) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint16(HEADER_SIZE_OFFSET, true);

  const vlrStart = headerSize;
  if (bytes.length < vlrStart + VLR_HEADER_MIN_BYTES) return false;

  const userIdBytes = bytes.subarray(vlrStart + VLR_USER_ID_OFFSET, vlrStart + VLR_USER_ID_OFFSET + VLR_USER_ID_LENGTH);
  // user_idはヌル終端されたASCII。ヌルバイトまでを文字列として比較する。
  const nullIndex = userIdBytes.indexOf(0);
  const userIdLength = nullIndex === -1 ? userIdBytes.length : nullIndex;
  const userId = new TextDecoder("ascii").decode(userIdBytes.subarray(0, userIdLength));

  const recordId = view.getUint16(vlrStart + VLR_RECORD_ID_OFFSET, true);

  return userId === COPC_INFO_USER_ID && recordId === COPC_INFO_RECORD_ID;
}

/** `File`から判定に必要な範囲(先頭512バイト)だけを読んで`isCopcHeader`に渡す。
 *  ファイル全体を読まない(大きいファイルでも軽い処理)。 */
export async function isCopcFile(file: File): Promise<boolean> {
  const PROBE_BYTES = 512;
  const head = await file.slice(0, PROBE_BYTES).arrayBuffer();
  return isCopcHeader(new Uint8Array(head));
}
