const HEADER_SIZE_OFFSET = 94;
const VLR_USER_ID_OFFSET = 2;
const VLR_USER_ID_LENGTH = 16;
const VLR_RECORD_ID_OFFSET = 18;
const VLR_HEADER_MIN_BYTES = 20;

const COPC_INFO_USER_ID = "copc";
const COPC_INFO_RECORD_ID = 1;

export function isCopcHeader(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_SIZE_OFFSET + 2) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint16(HEADER_SIZE_OFFSET, true);

  const vlrStart = headerSize;
  if (bytes.length < vlrStart + VLR_HEADER_MIN_BYTES) return false;

  const userIdBytes = bytes.subarray(vlrStart + VLR_USER_ID_OFFSET, vlrStart + VLR_USER_ID_OFFSET + VLR_USER_ID_LENGTH);
  const nullIndex = userIdBytes.indexOf(0);
  const userIdLength = nullIndex === -1 ? userIdBytes.length : nullIndex;
  const userId = new TextDecoder("ascii").decode(userIdBytes.subarray(0, userIdLength));

  const recordId = view.getUint16(vlrStart + VLR_RECORD_ID_OFFSET, true);

  return userId === COPC_INFO_USER_ID && recordId === COPC_INFO_RECORD_ID;
}

export async function isCopcFile(file: File): Promise<boolean> {
  const PROBE_BYTES = 512;
  const head = await file.slice(0, PROBE_BYTES).arrayBuffer();
  return isCopcHeader(new Uint8Array(head));
}
