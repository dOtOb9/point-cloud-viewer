const LAS_MINOR_VERSION_OFFSET = 25;
const LAS_HEADER_SIZE_OFFSET = 94;
const LAS_LEGACY_POINT_COUNT_OFFSET = 107;
const LAS_EXTENDED_POINT_COUNT_OFFSET = 247;
const LAS_1_4_HEADER_SIZE = 375;

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
      return Number(extendedCount);
    }
  }
  return legacyCount;
}

export function peekPcdPointCount(headerText: string): number | null {
  let points: number | null = null;
  let width: number | null = null;
  let height: number | null = null;

  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const key = tokens[0];
    if (key === "DATA") break;
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

export function peekPlyPointCount(headerText: string): number | null {
  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "end_header") break;
    const match = /^element\s+vertex\s+(\d+)/.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

const TEXT_HEADER_PROBE_BYTES = 16 * 1024;
const LAS_HEADER_PROBE_BYTES = 256;

async function readHeaderText(file: File, maxBytes: number): Promise<string> {
  const head = await file.slice(0, maxBytes).arrayBuffer();
  return new TextDecoder("ascii").decode(head);
}

export async function estimatePointCountForLasFile(file: File): Promise<number | null> {
  const head = await file.slice(0, LAS_HEADER_PROBE_BYTES).arrayBuffer();
  return peekLasPointCount(new Uint8Array(head));
}

export async function estimatePointCountForPcdFile(file: File): Promise<number | null> {
  const text = await readHeaderText(file, TEXT_HEADER_PROBE_BYTES);
  return peekPcdPointCount(text);
}

export async function estimatePointCountForPlyFile(file: File): Promise<number | null> {
  const text = await readHeaderText(file, TEXT_HEADER_PROBE_BYTES);
  return peekPlyPointCount(text);
}

const E57_HEADER_BYTES = 48;
const E57_SIGNATURE = "ASTM-E57";
const E57_CRC_BYTES = 4;
const E57_MAX_XML_BYTES = 64 * 1024 * 1024;

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

export function peekE57PointCount(xml: string): number | null {
  let total = 0;
  let found = false;
  for (const match of xml.matchAll(/<points\b[^>]*\brecordCount="(\d+)"/g)) {
    total += Number(match[1]);
    found = true;
  }
  return found ? total : null;
}

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
