// G2-1: types and decoder for the points of a cross-section layer as 2D `(s, z)` points.
// The buffer is built by `crates/pcv-core/src/profile.rs` (read its module docs for the layout):
//
//   header, 24 bytes   u32 count | u32 flags | f32 s_min | f32 s_max | f32 z_min | f32 z_max
//   then count * 12    f32 s | f32 z | u8 r | u8 g | u8 b | u8 classification
//
// Desktop gets the buffer from a Tauri command, the Web build from the Worker; both go through `decodeSectionProfile`.

/** The section line, in the file's coordinates (the same values the section tool used to cut the slab). */
export interface SectionLineInput {
  a: [number, number, number];
  b: [number, number, number];
  /** Direction of "up" of the view that picked the points. */
  up: [number, number, number];
}

const HEADER_BYTES = 24;
const RECORD_BYTES = 12;
/** Number of 32-bit words per record. */
const RECORD_WORDS = RECORD_BYTES / 4;
const FLAG_THINNED = 1;
const FLAG_COLOR = 2;

/** Default maximum number of points (the Rust side uses the same default for 0). */
export const DEFAULT_SECTION_POINT_CAP = 2_000_000;

export interface SectionPoints {
  count: number;
  /** The layer had more points than were returned. */
  thinned: boolean;
  /** `rgb` of each point is a real colour. When false, colour by the classification byte. */
  hasColor: boolean;
  sRange: { min: number; max: number };
  zRange: { min: number; max: number };
  /** Point i: s = floats[i * 3], z = floats[i * 3 + 1], packed = words[i * 3 + 2] (r | g << 8 | b << 16 | classification << 24). */
  floats: Float32Array;
  words: Uint32Array;
}

/** The empty set, for the panel's initial state. */
export const NO_SECTION_POINTS: SectionPoints = {
  count: 0,
  thinned: false,
  hasColor: false,
  sRange: { min: 0, max: 0 },
  zRange: { min: 0, max: 0 },
  floats: new Float32Array(0),
  words: new Uint32Array(0),
};

/** Read the buffer from Rust. Throws if its size does not match its header (a wrong or cut buffer). */
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
