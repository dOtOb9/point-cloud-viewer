export interface SectionLineInput {
  a: [number, number, number];
  b: [number, number, number];
  up: [number, number, number];
}

const HEADER_BYTES = 24;
const RECORD_BYTES = 12;
const RECORD_WORDS = RECORD_BYTES / 4;
const FLAG_THINNED = 1;
const FLAG_COLOR = 2;

export const DEFAULT_SECTION_POINT_CAP = 2_000_000;

export interface SectionPoints {
  count: number;
  thinned: boolean;
  hasColor: boolean;
  sRange: { min: number; max: number };
  zRange: { min: number; max: number };
  floats: Float32Array;
  words: Uint32Array;
}

export const NO_SECTION_POINTS: SectionPoints = {
  count: 0,
  thinned: false,
  hasColor: false,
  sRange: { min: 0, max: 0 },
  zRange: { min: 0, max: 0 },
  floats: new Float32Array(0),
  words: new Uint32Array(0),
};

export function decodeSectionProfile(buffer: ArrayBuffer): SectionPoints {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`断面の点のデータが短すぎます（${buffer.byteLength} バイト）`);
  }
  const header = new DataView(buffer);
  const count = header.getUint32(0, true);
  const flags = header.getUint32(4, true);
  if (buffer.byteLength !== HEADER_BYTES + count * RECORD_BYTES) {
    throw new Error(`断面の点のデータの大きさが合いません（${count} 点なのに ${buffer.byteLength} バイト）`);
  }
  return {
    count,
    thinned: (flags & FLAG_THINNED) !== 0,
    hasColor: (flags & FLAG_COLOR) !== 0,
    sRange: { min: header.getFloat32(8, true), max: header.getFloat32(12, true) },
    zRange: { min: header.getFloat32(16, true), max: header.getFloat32(20, true) },
    floats: new Float32Array(buffer, HEADER_BYTES, count * RECORD_WORDS),
    words: new Uint32Array(buffer, HEADER_BYTES, count * RECORD_WORDS),
  };
}
