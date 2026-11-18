export type SectionLinePreset = "standard" | "steep";

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

export interface SectionLineRequest {
  corridorHalfWidth: number;
  csf: CsfParamsInFileUnits;
}

export interface SectionGroundLine {
  points: Float32Array;
  edited?: boolean;
  groundPoints: number;
  cells: number;
}

const HEADER_BYTES = 16;
const RECORD_BYTES = 8;

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
