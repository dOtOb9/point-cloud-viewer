// 4x4行列のごく普通のユーティリティ。列優先（column-major）、WebGPUのuniformが
// 期待する並びに合わせている。ライブラリを入れず素朴に書く（このプロジェクトの方針:
// 賢いコードより退屈で読めるコードを書く）。
//
// 中身はすべて普通のJSの数値（=f64）で計算する。GPUにはf32しか無いが、
// f32へのキャストは「uniformバッファに書き込む最後の瞬間」だけにする
// （src/renderer/point-cloud-renderer.ts参照）。これがノードローカル相対座標
// （M1-2）と対になる、精度を守るためのもう半分の仕組み: ワールド座標そのものを
// 行列に持たせず、カメラとノード原点の差分だけを最終行列に残す。

/** 列優先の4x4行列。16要素。 */
export type Mat4 = number[];

export function identity(): Mat4 {
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/** a * b （列優先なので、変換の適用順は「bを先に適用してからa」）。 */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: Mat4 = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

/** WebGPUのNDC（z: 0..1）向けの透視投影行列。fovYはラジアン。 */
export function perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1.0 / Math.tan(fovYRadians / 2);
  const rangeInv = 1 / (near - far);
  // prettier-ignore
  return [
    f / aspect, 0, 0,                       0,
    0,          f, 0,                       0,
    0,          0, far * rangeInv,          -1,
    0,          0, near * far * rangeInv,   0,
  ];
}

/** 右手系のlookAt視点行列。eye/target/upはすべてワールド座標（f64のまま渡してよい）。 */
export function lookAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
): Mat4 {
  const zx = eye[0] - target[0];
  const zy = eye[1] - target[1];
  const zz = eye[2] - target[2];
  const zLen = Math.hypot(zx, zy, zz) || 1;
  const z: [number, number, number] = [zx / zLen, zy / zLen, zz / zLen];

  const xx = up[1] * z[2] - up[2] * z[1];
  const xy = up[2] * z[0] - up[0] * z[2];
  const xz = up[0] * z[1] - up[1] * z[0];
  const xLen = Math.hypot(xx, xy, xz) || 1;
  const x: [number, number, number] = [xx / xLen, xy / xLen, xz / xLen];

  const y: [number, number, number] = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ];

  // prettier-ignore
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ];
}

/**
 * カメラのローカル基底(forward, right, up)を求める。行列を組み立てず、3本の
 * ベクトルだけが要る呼び出し側（sky.ts/ground-grid.tsのレイ方向再構成。
 * TaskSheets/M2-shading-and-ui.md M2-0c、「広角での方向ベクトル線形補間」の
 * 不具合の修正）のために用意した。
 *
 * `forward`はカメラが向いている方向（eye→target、正規化済み）。`right`/`up`は
 * それに直交するカメラのローカル軸。式は次の通り（数値検証済み: autzenの実座標・
 * FOV60°・アスペクト16:9でf64の真値との誤差 ~1e-8）。
 *
 * ```
 * forward = normalize(target - eye)
 * right   = normalize(cross(forward, worldUp))
 * up      = normalize(cross(right, forward))
 * ```
 *
 * `lookAt()`の内部計算（z = normalize(eye-target), x = normalize(cross(up,z)),
 * y = cross(z,x)）と代数的に同じ基底になる（forward = -z, right = x,
 * up = yなのは、cross(a,b) = -cross(b,a)を使えば示せる）。view行列の基底と
 * 食い違わないことが重要なので、変更する場合はこの同値性を保つこと。
 *
 * eye/target/worldUpはすべてf64のワールド座標のまま渡してよい（eye-targetの
 * 引き算はシーンのスケール程度の差分にしかならないので、桁落ちの心配はない。
 * 戻り値はすべて正規化済みで大きさ1）。
 */
export function cameraBasis(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  worldUp: readonly [number, number, number],
): { forward: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
  const fx = target[0] - eye[0];
  const fy = target[1] - eye[1];
  const fz = target[2] - eye[2];
  const fLen = Math.hypot(fx, fy, fz) || 1;
  const forward: [number, number, number] = [fx / fLen, fy / fLen, fz / fLen];

  const rx = forward[1] * worldUp[2] - forward[2] * worldUp[1];
  const ry = forward[2] * worldUp[0] - forward[0] * worldUp[2];
  const rz = forward[0] * worldUp[1] - forward[1] * worldUp[0];
  const rLen = Math.hypot(rx, ry, rz) || 1;
  const right: [number, number, number] = [rx / rLen, ry / rLen, rz / rLen];

  // right, forwardはどちらも単位ベクトルで直交するので、この外積も単位ベクトル
  // （正規化不要だが、丸め誤差の蓄積を避けるため念のため正規化する）。
  const ux = right[1] * forward[2] - right[2] * forward[1];
  const uy = right[2] * forward[0] - right[0] * forward[2];
  const uz = right[0] * forward[1] - right[1] * forward[0];
  const uLen = Math.hypot(ux, uy, uz) || 1;
  const up: [number, number, number] = [ux / uLen, uy / uLen, uz / uLen];

  return { forward, right, up };
}

/**
 * 4x4行列の逆行列。余因子（2x2小行列式）から余因子行列を組み立てる標準的なやり方
 * （閉じた式なので反復計算が要らず、行列が小さい分には数値的にも十分安定する）。
 * 行列式が0に近く逆行列が求まらない場合はnullを返す。
 *
 * M1-5でスクリーン座標からワールド空間のレイを作るために使う
 * （viewProjの逆行列でNDC座標をワールド座標に戻す）。
 */
export function invert(m: Mat4): Mat4 | null {
  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
  const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
  const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

  // 2x2小行列式。上2行(0,1)と下2行(2,3)の組み合わせから、行列式を
  // ラプラス展開で求めるための中間値（このb00..b11で行列式もそのまま組み立てられる）。
  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;

  // prettier-ignore
  return [
    (m11 * b11 - m12 * b10 + m13 * b09) * invDet,
    (m02 * b10 - m01 * b11 - m03 * b09) * invDet,
    (m31 * b05 - m32 * b04 + m33 * b03) * invDet,
    (m22 * b04 - m21 * b05 - m23 * b03) * invDet,
    (m12 * b08 - m10 * b11 - m13 * b07) * invDet,
    (m00 * b11 - m02 * b08 + m03 * b07) * invDet,
    (m32 * b02 - m30 * b05 - m33 * b01) * invDet,
    (m20 * b05 - m22 * b02 + m23 * b01) * invDet,
    (m10 * b10 - m11 * b08 + m13 * b06) * invDet,
    (m01 * b08 - m00 * b10 - m03 * b06) * invDet,
    (m30 * b04 - m31 * b02 + m33 * b00) * invDet,
    (m21 * b02 - m20 * b04 - m23 * b00) * invDet,
    (m11 * b07 - m10 * b09 - m12 * b06) * invDet,
    (m00 * b09 - m01 * b07 + m02 * b06) * invDet,
    (m31 * b01 - m30 * b03 - m32 * b00) * invDet,
    (m20 * b03 - m21 * b01 + m22 * b00) * invDet,
  ];
}

/** 行列を通してxyz点を変換する（w=1として扱い、最後にwで割る）。 */
export function transformPoint(
  m: Mat4,
  p: readonly [number, number, number],
): [number, number, number, number] {
  const x = p[0],
    y = p[1],
    z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}
