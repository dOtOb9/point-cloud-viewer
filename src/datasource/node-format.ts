// ノードのバイナリレイアウト（ヘッダ32B + 点20B）のパーサ。M1-2で決めた形式。
// Rust側の実装は crates/pcv-core/src/node_format.rs にある。並びを変えるときは
// 両方を同じコミットで直すこと。
//
// このファイルはReactもTauriのAPIも知らない。ArrayBufferとDataViewだけを扱う
// 純粋な関数なので、datasource からも renderer からもそのまま使える。

/** ヘッダのmagic。ASCII "PCVN"。 */
export const NODE_MAGIC = "PCVN";
/** ヘッダのバージョン。Rust側の`node_format::VERSION`と一致させる。 */
export const NODE_VERSION = 1;
/** ヘッダのバイト数。 */
export const NODE_HEADER_BYTES = 32;
/** 1点あたりのバイト数。 */
export const NODE_POINT_STRIDE = 20;

/** 色属性が有効かどうかのフラグビット。 */
export const NODE_FLAG_COLOR = 1 << 0;
/** 強度属性が有効かどうかのフラグビット。 */
export const NODE_FLAG_INTENSITY = 1 << 1;
/** 分類属性が有効かどうかのフラグビット。 */
export const NODE_FLAG_CLASSIFICATION = 1 << 2;

export interface ParsedNode {
  pointCount: number;
  /** ノードローカル座標の原点（世界座標、f32相当に丸め済み）。 */
  origin: readonly [number, number, number];
  flags: number;
  hasColor: boolean;
  /**
   * ヘッダを除いた点配列そのもの（`pointCount * NODE_POINT_STRIDE` バイト）。
   * コピーせず元のArrayBufferを参照するだけなので、GPU頂点バッファへ
   * そのまま渡せる。
   */
  pointsBytes: Uint8Array;
}

/**
 * M1-2のバイナリ形式をパースする。ヘッダの `magic` / `version` /
 * `stride` を検証し、想定と違えば例外を投げて弾く。
 */
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

  // 読み出した点数がヘッダの point_count と一致することの確認
  // (実際のバイト長から逆算した点数と、ヘッダが申告する点数を突き合わせる)。
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
