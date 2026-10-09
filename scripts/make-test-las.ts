// E2E(`e2e/web-conversion.spec.ts`)が使う、テスト専用の小さなLASファイルを
// その場で作るスクリプト。
//
// なぜコミットされた固定ファイルを使わないか: `CLAUDE.md`の「守ること」で
// 点群データ(`*.las`等)はコミットしない方針になっている。テストのたびに
// このスクリプトで生成し、使い終わったら(E2Eテスト側のafterAllで)消す。
//
// なぜ`las`クレートや既存のRustのテストフィクスチャを流用しないか:
// このファイルはE2E(Playwright、Node側)専用で、Rustのビルド
// (`cargo build`、wasm32ターゲットの用意)をE2Eの前提に加えたくない
// (CIのfrontendジョブはRustツールチェインを前提にしていない。
// `.github/workflows/ci.yml`のfrontendジョブ参照)。LAS 1.2・Point Data
// Record Format 2(色+強度、GPS時刻なし)は仕様が小さく安定しているため、
// このファイル単体で素朴に書き出す。
//
// 仕様の参照先: ASPRS LAS 1.2仕様。ヘッダーは227バイト固定
// (VLRを一切使わないため、offset to point data = header size = 227)。
// Point Data Record Format 2は26バイト/点
// (X,Y,Z: i32 x3 → Intensity: u16 → flags: u8 → Classification: u8 →
//  ScanAngleRank: i8 → UserData: u8 → PointSourceID: u16 →
//  Red,Green,Blue: u16 x3)。
//
// 固定長文字列フィールド(System Identifier・Generating Software)は
// 32バイトのASCII、残りをnullで埋める。

const HEADER_SIZE = 227;
const POINT_RECORD_FORMAT = 2;
const POINT_RECORD_LENGTH = 26;

/** 0.01(cm単位)の精度で十分(受け入れ条件は「変換が通ること」であり、
 *  実データのmm精度を再現する必要はない)。 */
const SCALE = 0.01;

export interface SyntheticLasOptions {
  /** 点数。既定2,000点(`TaskSheets/TEST-DATA.md`の「テスト内で生成」の下限と同じ)。 */
  pointCount?: number;
  /** 疑似乱数の種。既定値を固定し、テストのたびに同じ点群を再現できるようにする。 */
  seed?: number;
  /**
   * M4-14: ヘッダーのX/Y/Z offset(既定0,0,0)。複数ファイルをマージする
   * 受け入れ条件(「異なるscale/offsetを持つ入力を混ぜても座標が正しい」)を
   * 実ブラウザのE2E(`e2e/web-multi-conversion.spec.ts`)で確かめるため、
   * ファイルごとに異なる値を指定できるようにした。点の生のXYZ(ローカル座標、
   * 0〜50m四方)は変えず、ヘッダーのoffsetだけを変えることで、実世界座標
   * (`offset + raw*scale`)がファイルごとに異なる場所になる
   * (`crates/pcv-convert/src/merge.rs`のscale/offsetに関する設計ドキュメント
   * 「`LasPointRecord`は実世界座標(f64)を運ぶ」を、合成データでも再現する)。
   */
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

/** 依存を増やさないための最小限の疑似乱数生成器(mulberry32)。
 *  暗号強度は不要(テストデータの座標・色をばらけさせるだけの用途)。 */
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

/** 色・強度・分類にばらつきを持たせた点群を作る(受け入れ条件「色・強度付き」)。
 *  座標は原点付近の50m四方・高さ10mの範囲に収める(スケール0.01でもi32に余裕で収まる)。 */
function generatePoints(count: number, seed: number): SyntheticPoint[] {
  const random = makeRandom(seed);
  const points: SyntheticPoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = random() * 50;
    const y = random() * 50;
    // 高さは緩やかな起伏(sin合成)+ノイズ。平面にならないようにする
    // (bounds.z.max === bounds.z.minだと縮退するケースがあるため避ける)。
    const z = 5 + Math.sin(x * 0.3) * Math.cos(y * 0.3) * 2 + random() * 0.5;
    points.push({
      x,
      y,
      z,
      intensity: Math.floor(random() * 65536),
      // 分類はASPRS標準分類の範囲内でいくつかの値を混ぜる(1=未分類, 2=地面)。
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

/**
 * LAS 1.2・Point Data Record Format 2のバイト列を組み立てる。
 * `src/datasource/tauri.ts`・`crates/pcv-wasm`が読む経路と同じ「ヘッダーから
 * 判定する」実装なので、拡張子以外はこの関数の出力がそのまま本物のLASとして
 * 扱われる。
 */
export function buildSyntheticLas(options: SyntheticLasOptions = {}): Uint8Array {
  const pointCount = options.pointCount ?? 2000;
  const seed = options.seed ?? 1;
  const offsetX = options.offsetX ?? 0;
  const offsetY = options.offsetY ?? 0;
  const offsetZ = options.offsetZ ?? 0;
  const points = generatePoints(pointCount, seed);

  const totalSize = HEADER_SIZE + pointCount * POINT_RECORD_LENGTH;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const minZ = Math.min(...points.map((p) => p.z));
  const maxZ = Math.max(...points.map((p) => p.z));

  // --- Public Header Block(227バイト、オフセットを1つずつ進めながら書く。
  //     手で計算したオフセット定数を並べるより、仕様の記述順そのままで
  //     追いやすくするため)。 ---
  let o = 0;
  writeAscii(view, o, "LASF", 4);
  o += 4;
  view.setUint16(o, 0, true); // File Source ID
  o += 2;
  view.setUint16(o, 0, true); // Global Encoding
  o += 2;
  view.setUint32(o, 0, true); // Project ID - GUID data 1
  o += 4;
  view.setUint16(o, 0, true); // GUID data 2
  o += 2;
  view.setUint16(o, 0, true); // GUID data 3
  o += 2;
  for (let i = 0; i < 8; i++) view.setUint8(o + i, 0); // GUID data 4
  o += 8;
  view.setUint8(o, 1); // Version Major
  o += 1;
  view.setUint8(o, 2); // Version Minor
  o += 1;
  writeAscii(view, o, "pcv-e2e", 32); // System Identifier
  o += 32;
  writeAscii(view, o, "make-test-las.ts", 32); // Generating Software
  o += 32;
  view.setUint16(o, 1, true); // File Creation Day of Year
  o += 2;
  view.setUint16(o, 2024, true); // File Creation Year
  o += 2;
  view.setUint16(o, HEADER_SIZE, true); // Header Size
  o += 2;
  view.setUint32(o, HEADER_SIZE, true); // Offset to point data(VLR無し)
  o += 4;
  view.setUint32(o, 0, true); // Number of variable length records
  o += 4;
  view.setUint8(o, POINT_RECORD_FORMAT);
  o += 1;
  view.setUint16(o, POINT_RECORD_LENGTH, true);
  o += 2;
  view.setUint32(o, pointCount, true); // Legacy number of point records
  o += 4;
  view.setUint32(o, pointCount, true); // Legacy number of points by return[0]
  o += 4;
  for (let i = 0; i < 4; i++) {
    view.setUint32(o, 0, true); // return[1..4]
    o += 4;
  }
  view.setFloat64(o, SCALE, true); // X scale factor
  o += 8;
  view.setFloat64(o, SCALE, true); // Y scale factor
  o += 8;
  view.setFloat64(o, SCALE, true); // Z scale factor
  o += 8;
  view.setFloat64(o, offsetX, true); // X offset
  o += 8;
  view.setFloat64(o, offsetY, true); // Y offset
  o += 8;
  view.setFloat64(o, offsetZ, true); // Z offset
  o += 8;
  // Max/Min(実世界座標 = offset + raw*scale。M4-14追記: offsetが0でない
  // 場合も正しくbounds表示されるようにする)。
  view.setFloat64(o, offsetX + maxX, true);
  o += 8;
  view.setFloat64(o, offsetX + minX, true);
  o += 8;
  view.setFloat64(o, offsetY + maxY, true);
  o += 8;
  view.setFloat64(o, offsetY + minY, true);
  o += 8;
  view.setFloat64(o, offsetZ + maxZ, true);
  o += 8;
  view.setFloat64(o, offsetZ + minZ, true);
  o += 8;

  if (o !== HEADER_SIZE) {
    throw new Error(`ヘッダーの組み立てが${HEADER_SIZE}バイトからずれている: ${o}`);
  }

  // --- Point Data Record(26バイト x pointCount) ---
  for (const p of points) {
    const rawX = Math.round(p.x / SCALE);
    const rawY = Math.round(p.y / SCALE);
    const rawZ = Math.round(p.z / SCALE);
    view.setInt32(o, rawX, true);
    o += 4;
    view.setInt32(o, rawY, true);
    o += 4;
    view.setInt32(o, rawZ, true);
    o += 4;
    view.setUint16(o, p.intensity, true);
    o += 2;
    view.setUint8(o, 1 | (1 << 3)); // Return Number=1, Number of Returns=1
    o += 1;
    view.setUint8(o, p.classification);
    o += 1;
    view.setInt8(o, 0); // Scan Angle Rank
    o += 1;
    view.setUint8(o, 0); // User Data
    o += 1;
    view.setUint16(o, 1, true); // Point Source ID
    o += 2;
    view.setUint16(o, p.red, true);
    o += 2;
    view.setUint16(o, p.green, true);
    o += 2;
    view.setUint16(o, p.blue, true);
    o += 2;
  }

  if (o !== totalSize) {
    throw new Error(`点データの組み立てが期待サイズ${totalSize}からずれている: ${o}`);
  }

  return new Uint8Array(buffer);
}
