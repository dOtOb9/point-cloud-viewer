export const NODE_MAGIC = "PCVN";
export const NODE_VERSION = 1;
export const NODE_HEADER_BYTES = 32;
export const NODE_POINT_STRIDE = 20;

export const NODE_FLAG_COLOR = 1 << 0;

export interface ParsedNode {
  pointCount: number;
  origin: readonly [number, number, number];
  flags: number;
  hasColor: boolean;
  pointsBytes: Uint8Array;
}

export function parseNodeBuffer(buffer: ArrayBuffer): ParsedNode {
  if (buffer.byteLength < NODE_HEADER_BYTES) {
    throw new Error(
      `node buffer is too short: ${buffer.byteLength} bytes (header alone needs ${NODE_HEADER_BYTES})`,
    );
  }

  const view = new DataView(buffer);

  const magicBytes = new Uint8Array(buffer, 0, 4);
  let magic = "";
  for (const byte of magicBytes) {
    magic += String.fromCharCode(byte);
  }
  if (magic !== NODE_MAGIC) {
    throw new Error(`bad node magic: "${magic}" (expected "${NODE_MAGIC}")`);
  }

  const version = view.getUint32(4, true);
  if (version !== NODE_VERSION) {
    throw new Error(`unsupported node version: ${version} (expected ${NODE_VERSION})`);
  }

  const pointCount = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  if (stride !== NODE_POINT_STRIDE) {
    throw new Error(`unexpected node point stride: ${stride} (expected ${NODE_POINT_STRIDE})`);
  }

  const origin: [number, number, number] = [
    view.getFloat32(16, true),
    view.getFloat32(20, true),
    view.getFloat32(24, true),
  ];
  const flags = view.getUint32(28, true);

  const expectedBytes = NODE_HEADER_BYTES + pointCount * NODE_POINT_STRIDE;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `node buffer length ${buffer.byteLength} does not match header (point_count=${pointCount} implies ${expectedBytes} bytes)`,
    );
  }

  const pointsBytes = new Uint8Array(buffer, NODE_HEADER_BYTES, pointCount * NODE_POINT_STRIDE);

  return {
    pointCount,
    origin,
    flags,
    hasColor: (flags & NODE_FLAG_COLOR) !== 0,
    pointsBytes,
  };
}

export function computeIntensityRange(node: ParsedNode): { min: number; max: number } | null {
  if (node.pointCount === 0) return null;

  const bytes = node.pointsBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < node.pointCount; i++) {
    const intensity = view.getUint16(i * NODE_POINT_STRIDE + 16, true);
    if (intensity < min) min = intensity;
    if (intensity > max) max = intensity;
  }
  return { min, max };
}
