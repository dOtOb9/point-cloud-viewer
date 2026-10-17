// M4-9追記(`TaskSheets/M4-import-and-conversion.md`): 変換に必要なOPFS容量を、
// ファイルサイズではなく**点数**から見積もるための、各形式のヘッダー読み取り。
//
// # なぜファイルサイズではなく点数か(所有者の実機不具合の原因)
//
// 旧実装(`opfs.ts`の`requiredScratchBytes`)は「入力ファイルサイズ×11」で
// 見積もっていた。この係数はADR-0006/M4-1bの実測(sofi.copc.laz、LAZ圧縮)から
// 来ており、**圧縮された入力でしか正しくない**。PCD(非圧縮、f64座標)は
// ファイルサイズに対して点数が少ない(1点あたりのバイト数が大きい)ため、
// 「ファイルサイズ×11」は実際に必要な量を大きく超えてしまい(例: sofi.pcd
// 9.47GB×11≈104GB)、誤って「空き容量不足」と判定される不具合が実際に起きた。
//
// 変換の一時領域(OPFSスクラッチ)・出力COPCのサイズは、どちらも**点数**に
// ほぼ比例する(`copc-writer`の設計、M4-1b/ADR-0006の実測)。そのため、
// ファイルサイズではなく点数から見積もる方が、形式(圧縮の有無・座標の型)に
// よらず一貫して正確になる。
//
// # ヘッダーだけを読む(ファイル全体を読まない)
//
// ここで行う判定は、LAS/LAZ・PCD・PLYいずれも**ヘッダー(ファイル先頭の
// 小さい範囲)だけ**を読んで完結する(メインスレッドから`File.slice`+
// `arrayBuffer()`/`text()`で読める。`FileReaderSync`のようなWorker専用APIは
// 不要)。E57はファイル先頭の48バイトとファイル末尾のXML(スキャンごとの
// `recordCount`)だけを読む(R7。下の`estimatePointCountForE57File`参照)。

/** LASヘッダーのバイト配置(ASPRS LAS仕様書)。`copc-header.ts`と同じ
 *  出典だが、見る場所が違う(あちらはVLR、こちらは点数)ので独立に持つ。 */
const LAS_MINOR_VERSION_OFFSET = 25;
const LAS_HEADER_SIZE_OFFSET = 94;
const LAS_LEGACY_POINT_COUNT_OFFSET = 107;
/** LAS 1.4で追加された64bitの点数フィールド。1.4のヘッダーサイズは375バイト。 */
const LAS_EXTENDED_POINT_COUNT_OFFSET = 247;
const LAS_1_4_HEADER_SIZE = 375;

/**
 * LASヘッダーのバイト列(ファイル先頭を含む十分な長さ、目安として先頭256バイト
 * 程度)から、申告されている点数を読む。判定できなければ`null`。
 *
 * LAS 1.4は64bitの点数フィールド(オフセット247)を持つ。レガシーな32bit
 * フィールド(オフセット107)は1.4でも書かれるが、点数が`u32`に収まらない、
 * または点フォーマットが6〜10の場合は0になりうる(ASPRS LAS 1.4仕様書)ため、
 * 1.4かつ64bitフィールドが0でなければそちらを優先する。
 */
export function peekLasPointCount(bytes: Uint8Array): number | null {
  if (bytes.length < LAS_LEGACY_POINT_COUNT_OFFSET + 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minorVersion = bytes[LAS_MINOR_VERSION_OFFSET];
  const headerSize = view.getUint16(LAS_HEADER_SIZE_OFFSET, true);
  const legacyCount = view.getUint32(LAS_LEGACY_POINT_COUNT_OFFSET, true);

  if (
    minorVersion >= 4 &&
    headerSize >= LAS_1_4_HEADER_SIZE &&
    bytes.length >= LAS_EXTENDED_POINT_COUNT_OFFSET + 8
  ) {
    const extendedCount = view.getBigUint64(LAS_EXTENDED_POINT_COUNT_OFFSET, true);
    if (extendedCount > 0n) {
      // 点数は実務上2^53を超えない(超えればu64のまま扱う意味がない規模の
      // ファイルになる)ため、Numberへ変換して問題ない。
      return Number(extendedCount);
    }
  }
  return legacyCount;
}

/**
 * PCDヘッダー(ASCIIテキスト、`DATA`行までの部分)から`POINTS`フィールドを
 * 読む。無ければ`WIDTH`×`HEIGHT`から計算する(PCD仕様では本来`POINTS`は
 * 必須だが、無い場合の安全策として)。判定できなければ`null`。
 */
export function peekPcdPointCount(headerText: string): number | null {
  let points: number | null = null;
  let width: number | null = null;
  let height: number | null = null;

  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const key = tokens[0];
    if (key === "DATA") break; // ヘッダー終端。これ以降は点データ本体。
    if (key === "POINTS" && tokens[1] !== undefined) {
      points = Number(tokens[1]);
    } else if (key === "WIDTH" && tokens[1] !== undefined) {
      width = Number(tokens[1]);
    } else if (key === "HEIGHT" && tokens[1] !== undefined) {
      height = Number(tokens[1]);
    }
  }

  if (points !== null && Number.isFinite(points)) return points;
  if (width !== null && height !== null && Number.isFinite(width) && Number.isFinite(height)) {
    return width * height;
  }
  return null;
}

/**
 * PLYヘッダー(ASCIIテキスト、binary形式でもヘッダー自体は常にASCII)から
 * `element vertex N`行を読む。判定できなければ`null`。
 */
export function peekPlyPointCount(headerText: string): number | null {
  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "end_header") break;
    const match = /^element\s+vertex\s+(\d+)/.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

/** ヘッダー判定に使う範囲(バイト数)。PCD/PLYのヘッダーは通常数百バイトだが、
 *  プロパティの多いPLYや長いコメントを見込んで余裕を持たせる。 */
const TEXT_HEADER_PROBE_BYTES = 16 * 1024;
const LAS_HEADER_PROBE_BYTES = 256;

async function readHeaderText(file: File, maxBytes: number): Promise<string> {
  const head = await file.slice(0, maxBytes).arrayBuffer();
  return new TextDecoder("ascii").decode(head);
}

/** `File`からLASヘッダーを読んで点数を見積もる。 */
export async function estimatePointCountForLasFile(file: File): Promise<number | null> {
  const head = await file.slice(0, LAS_HEADER_PROBE_BYTES).arrayBuffer();
  return peekLasPointCount(new Uint8Array(head));
}

/** `File`からPCDヘッダーを読んで点数を見積もる。 */
export async function estimatePointCountForPcdFile(file: File): Promise<number | null> {
  const text = await readHeaderText(file, TEXT_HEADER_PROBE_BYTES);
  return peekPcdPointCount(text);
}

/** `File`からPLYヘッダーを読んで点数を見積もる。 */
export async function estimatePointCountForPlyFile(file: File): Promise<number | null> {
  const text = await readHeaderText(file, TEXT_HEADER_PROBE_BYTES);
  return peekPlyPointCount(text);
}

// --- E57 (R7) ---
//
// An E57 file starts with a 48 byte header that says where the XML section is (at the end of
// the file). The XML lists every scan with `<points ... recordCount="N">`, so the point count is the
// sum of those. The XML lives in a "paged" section: every page (1024 bytes by default) ends with a
// 4 byte CRC that is not part of the data, so the CRCs are removed before the text is read.
// Only the header and the XML are read, never the point data.

const E57_HEADER_BYTES = 48;
const E57_SIGNATURE = "ASTM-E57";
const E57_CRC_BYTES = 4;
/** An XML section bigger than this is not read (a guard; real files have tens of KB). */
const E57_MAX_XML_BYTES = 64 * 1024 * 1024;

/** Where the XML section is, from the 48 byte header. `null` if this is not an E57 header. */
export function parseE57Header(
  bytes: Uint8Array,
): { xmlOffset: number; xmlLength: number; pageSize: number } | null {
  if (bytes.length < E57_HEADER_BYTES) return null;
  if (new TextDecoder("ascii").decode(bytes.subarray(0, 8)) !== E57_SIGNATURE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xmlOffset = Number(view.getBigUint64(24, true));
  const xmlLength = Number(view.getBigUint64(32, true));
  const pageSize = Number(view.getBigUint64(40, true));
  if (pageSize <= E57_CRC_BYTES) return null;
  return { xmlOffset, xmlLength, pageSize };
}

/** Remove the 4 byte CRC at the end of every `pageSize` bytes. */
export function stripE57PageCrcs(raw: Uint8Array, pageSize: number): Uint8Array {
  const dataPerPage = pageSize - E57_CRC_BYTES;
  const pageCount = Math.ceil(raw.length / pageSize);
  const out = new Uint8Array(pageCount * dataPerPage);
  let written = 0;
  for (let page = 0; page < pageCount; page++) {
    const chunk = raw.subarray(page * pageSize, page * pageSize + dataPerPage);
    out.set(chunk, written);
    written += chunk.length;
  }
  return out.subarray(0, written);
}

/** Sum of `recordCount` over the `<points>` elements of the E57 XML. `null` if there is none. */
export function peekE57PointCount(xml: string): number | null {
  let total = 0;
  let found = false;
  for (const match of xml.matchAll(/<points\b[^>]*\brecordCount="(\d+)"/g)) {
    total += Number(match[1]);
    found = true;
  }
  return found ? total : null;
}

/** Read the E57 header and XML section of `file` and sum the scans' point counts. */
export async function estimatePointCountForE57File(file: File): Promise<number | null> {
  const header = parseE57Header(new Uint8Array(await file.slice(0, E57_HEADER_BYTES).arrayBuffer()));
  if (!header || header.xmlLength > E57_MAX_XML_BYTES) return null;

  const { xmlOffset, xmlLength, pageSize } = header;
  const firstPageStart = Math.floor(xmlOffset / pageSize) * pageSize;
  const skip = xmlOffset - firstPageStart;
  const pages = Math.ceil((skip + xmlLength) / (pageSize - E57_CRC_BYTES));
  const raw = new Uint8Array(await file.slice(firstPageStart, firstPageStart + pages * pageSize).arrayBuffer());
  const data = stripE57PageCrcs(raw, pageSize);
  if (data.length < skip + xmlLength) return null;
  const xml = new TextDecoder("utf-8").decode(data.subarray(skip, skip + xmlLength));
  return peekE57PointCount(xml);
}
