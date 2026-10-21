// G2-4: types and decoder for the ground line of a cross section (the "section line").
// The buffer is built by `crates/pcv-core/src/section_line.rs` (read its module docs for the layout):
//
//   header, 16 bytes   u32 count | u32 flags | u32 ground_points | u32 cells
//   then count * 8     f32 s | f32 z
//
// Desktop gets the buffer from a Tauri command, the Web build from the Worker; both go through `decodeSectionLine`.

/** The CSF presets of the section dialog (plan 2.2). The values behind them are in Rust (`CsfParams::standard` / `steep`). */
export type SectionLinePreset = "standard" | "steep";

/**
 * What the section tool asks for. Lengths are in the file's unit (the dialog converts metres with the layer's CRS
 * factor). The Rust type is `SectionLineRequest` in `crates/pcv-core/src/section_line.rs`.
 */
export interface SectionLineRequest {
  preset: SectionLinePreset;
  /** Half width of the corridor read around the line on each side. */
  corridorHalfWidth: number;
  /** Grid spacing of the cloth, also the spacing of the samples of the line. */
  clothResolution: number;
}

/** The corridor half width the section tool uses by default, in metres (plan 8.3: 20 m on each side). */
export const DEFAULT_CORRIDOR_HALF_WIDTH_M = 20;
/** The cloth resolution of both presets, in metres. */
export const DEFAULT_CLOTH_RESOLUTION_M = 0.5;

/** A polyline along the section: point i is `(s, z)` = `points[i * 2]`, `points[i * 2 + 1]`, in the file's unit. */
export interface SectionGroundLine {
  points: Float32Array;
  /** Ground points the TIN was built from (at most `cells`). */
  groundPoints: number;
  /** Cells of the grid the ground points were chosen on. */
  cells: number;
}

const HEADER_BYTES = 16;
const RECORD_BYTES = 8;

/** Read the buffer from Rust. Throws if its size does not match its header. */
export function decodeSectionLine(buffer: ArrayBuffer): SectionGroundLine {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`断面線のデータが短すぎます（${buffer.byteLength} バイト）`);
  }
  const header = new DataView(buffer);
  const count = header.getUint32(0, true);
  if (buffer.byteLength !== HEADER_BYTES + count * RECORD_BYTES) {
    throw new Error(`断面線のデータの大きさが合いません（${count} 点なのに ${buffer.byteLength} バイト）`);
  }
  const points = new Float32Array(count * 2);
  for (let i = 0; i < count * 2; i++) {
    points[i] = header.getFloat32(HEADER_BYTES + i * 4, true);
  }
  return { points, groundPoints: header.getUint32(8, true), cells: header.getUint32(12, true) };
}
