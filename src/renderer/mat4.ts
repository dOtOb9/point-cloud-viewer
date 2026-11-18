export type Mat4 = number[];

export function identity(): Mat4 {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

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
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

export function perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1.0 / Math.tan(fovYRadians / 2);
  const rangeInv = 1 / (near - far);
  return [
    f / aspect, 0, 0,                       0,
    0,          f, 0,                       0,
    0,          0, far * rangeInv,          -1,
    0,          0, near * far * rangeInv,   0,
  ];
}

export function orthographicMatrix(halfHeight: number, aspect: number, near: number, far: number): Mat4 {
  const rangeInv = 1 / (near - far);
  return [
    1 / (halfHeight * aspect), 0,              0,               0,
    0,                         1 / halfHeight, 0,               0,
    0,                         0,              rangeInv,        0,
    0,                         0,              near * rangeInv, 1,
  ];
}

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

  const ux = right[1] * forward[2] - right[2] * forward[1];
  const uy = right[2] * forward[0] - right[0] * forward[2];
  const uz = right[0] * forward[1] - right[1] * forward[0];
  const uLen = Math.hypot(ux, uy, uz) || 1;
  const up: [number, number, number] = [ux / uLen, uy / uLen, uz / uLen];

  return { forward, right, up };
}

export function invert(m: Mat4): Mat4 | null {
  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
  const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
  const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

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
