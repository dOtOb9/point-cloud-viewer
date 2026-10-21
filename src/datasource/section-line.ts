// G2-4: types and decoder for the ground line of a cross section (the "section line").
// The buffer is built by `crates/pcv-core/src/section_line.rs` (read its module docs for the layout):
//
//   header, 16 bytes   u32 count | u32 flags | u32 ground_points | u32 cells
//   then count * 8     f32 s | f32 z
//
// Desktop gets the buffer from a Tauri command, the Web build from the Worker; both go through `decodeSectionLine`.

/** The CSF presets of the section dialog (plan 2.2). Their numbers (in metres) are in `src/app/csf-params.ts`. */
export type SectionLinePreset = "standard" | "steep";

/** CSF parameters with every length in the file's unit. The Rust type is `CsfParamsInput` in `crates/pcv-core/src/section_line.rs`. */
export interface CsfParamsInFileUnits {
  clothResolution: number;
  rigidness: number;
  timeStep: number;
  classThresholdUpper: number;
  classThresholdLower: number;
  iterations: number;
  slopeSmooth: boolean;
  hdiff: number;
  convergenceThreshold: number;
}

/**
 * What the section tool asks for. Lengths are in the file's unit (`src/app/csf-params.ts` converts the owner's metres
 * with the layer's CRS factors). The Rust type is `SectionLineRequest` in `crates/pcv-core/src/section_line.rs`.
 */
export interface SectionLineRequest {
  /** Half width of the corridor read around the line on each side. */
  corridorHalfWidth: number;
  csf: CsfParamsInFileUnits;
}

/** A polyline along the section: point i is `(s, z)` = `points[i * 2]`, `points[i * 2 + 1]`, in the file's unit. */
export interface SectionGroundLine {
  points: Float32Array;
  /** True once the user has changed the line by tracing (G2-5). Absent on a line straight from the computation. */
  edited?: boolean;
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
