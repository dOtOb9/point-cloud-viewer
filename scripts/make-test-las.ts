const HEADER_SIZE = 227;
const POINT_RECORD_FORMAT = 2;
const POINT_RECORD_LENGTH = 26;

const SCALE = 0.01;

export interface SyntheticLasOptions {
  pointCount?: number;
  seed?: number;
  offsetX?: number;
  offsetY?: number;
  offsetZ?: number;
}

interface SyntheticPoint {
  x: number;
  y: number;
  z: number;
  intensity: number;
  classification: number;
  red: number;
  green: number;
  blue: number;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatePoints(count: number, seed: number): SyntheticPoint[] {
  const random = makeRandom(seed);
  const points: SyntheticPoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = random() * 50;
    const y = random() * 50;
    const z = 5 + Math.sin(x * 0.3) * Math.cos(y * 0.3) * 2 + random() * 0.5;
    points.push({
      x,
      y,
      z,
      intensity: Math.floor(random() * 65536),
      classification: i % 5 === 0 ? 2 : 1,
      red: Math.floor(random() * 65536),
      green: Math.floor(random() * 65536),
      blue: Math.floor(random() * 65536),
    });
  }
  return points;
}

function writeAscii(view: DataView, offset: number, text: string, fieldLength: number): void {
  for (let i = 0; i < fieldLength; i++) {
    view.setUint8(offset + i, i < text.length ? text.charCodeAt(i) : 0);
  }
}

function lasFieldWriter(view: DataView) {
  let offset = 0;
  return {
    offset: () => offset,
    ascii(_field: string, text: string, fieldLength: number) {
      writeAscii(view, offset, text, fieldLength);
      offset += fieldLength;
    },
    u8(_field: string, value: number) {
      view.setUint8(offset, value);
      offset += 1;
    },
    i8(_field: string, value: number) {
      view.setInt8(offset, value);
      offset += 1;
    },
    u16(_field: string, value: number) {
      view.setUint16(offset, value, true);
      offset += 2;
    },
    u32(_field: string, value: number) {
      view.setUint32(offset, value, true);
      offset += 4;
    },
    i32(_field: string, value: number) {
      view.setInt32(offset, value, true);
      offset += 4;
    },
    f64(_field: string, value: number) {
      view.setFloat64(offset, value, true);
      offset += 8;
    },
  };
}

const NO_VARIABLE_LENGTH_RECORDS = 0;
const RETURN_NUMBER_1_OF_1_RETURNS = 1 | (1 << 3);

export function buildSyntheticLas(options: SyntheticLasOptions = {}): Uint8Array {
  const pointCount = options.pointCount ?? 2000;
  const seed = options.seed ?? 1;
  const offsetX = options.offsetX ?? 0;
  const offsetY = options.offsetY ?? 0;
  const offsetZ = options.offsetZ ?? 0;
  const points = generatePoints(pointCount, seed);

  const totalSize = HEADER_SIZE + pointCount * POINT_RECORD_LENGTH;
  const buffer = new ArrayBuffer(totalSize);
  const w = lasFieldWriter(new DataView(buffer));

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const minZ = Math.min(...points.map((p) => p.z));
  const maxZ = Math.max(...points.map((p) => p.z));

  w.ascii("File Signature", "LASF", 4);
  w.u16("File Source ID", 0);
  w.u16("Global Encoding", 0);
  w.u32("Project ID - GUID data 1", 0);
  w.u16("Project ID - GUID data 2", 0);
  w.u16("Project ID - GUID data 3", 0);
  for (let i = 0; i < 8; i++) w.u8("Project ID - GUID data 4", 0);
  w.u8("Version Major", 1);
  w.u8("Version Minor", 2);
  w.ascii("System Identifier", "pcv-e2e", 32);
  w.ascii("Generating Software", "make-test-las.ts", 32);
  w.u16("File Creation Day of Year", 1);
  w.u16("File Creation Year", 2024);
  w.u16("Header Size", HEADER_SIZE);
  w.u32("Offset to point data", HEADER_SIZE);
  w.u32("Number of Variable Length Records", NO_VARIABLE_LENGTH_RECORDS);
  w.u8("Point Data Record Format", POINT_RECORD_FORMAT);
  w.u16("Point Data Record Length", POINT_RECORD_LENGTH);
  w.u32("Legacy Number of point records", pointCount);
  w.u32("Legacy Number of points by return [0]", pointCount);
  for (let i = 0; i < 4; i++) w.u32("Legacy Number of points by return [1..4]", 0);
  w.f64("X scale factor", SCALE);
  w.f64("Y scale factor", SCALE);
  w.f64("Z scale factor", SCALE);
  w.f64("X offset", offsetX);
  w.f64("Y offset", offsetY);
  w.f64("Z offset", offsetZ);
  w.f64("Max X", offsetX + maxX);
  w.f64("Min X", offsetX + minX);
  w.f64("Max Y", offsetY + maxY);
  w.f64("Min Y", offsetY + minY);
  w.f64("Max Z", offsetZ + maxZ);
  w.f64("Min Z", offsetZ + minZ);

  if (w.offset() !== HEADER_SIZE) {
    throw new Error(`ヘッダーの組み立てが${HEADER_SIZE}バイトからずれている: ${w.offset()}`);
  }

  for (const p of points) {
    w.i32("X", Math.round(p.x / SCALE));
    w.i32("Y", Math.round(p.y / SCALE));
    w.i32("Z", Math.round(p.z / SCALE));
    w.u16("Intensity", p.intensity);
    w.u8("Return Number, Number of Returns", RETURN_NUMBER_1_OF_1_RETURNS);
    w.u8("Classification", p.classification);
    w.i8("Scan Angle Rank", 0);
    w.u8("User Data", 0);
    w.u16("Point Source ID", 1);
    w.u16("Red", p.red);
    w.u16("Green", p.green);
    w.u16("Blue", p.blue);
  }

  if (w.offset() !== totalSize) {
    throw new Error(`点データの組み立てが期待サイズ${totalSize}からずれている: ${w.offset()}`);
  }

  return new Uint8Array(buffer);
}
