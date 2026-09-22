// 空とグリッドが効かない件の診断。
// レンダラと同じ手順で viewProj を組み、その逆行列からシェーダと同じ式で
// レイ方向を復元し、f64 と f32 の両方で確かめる。
//
// 使い方: npx tsx scripts/diag-sky-ray.ts

import { invert, lookAt, multiply, perspective, transformPoint } from "../src/renderer/mat4";
import { DEFAULT_UP_AXIS, type Vec3 } from "../src/renderer/up-axis";

// autzen の実際の中心（LAS ヘッダから読んだ値）
const target: Vec3 = [637290.8, 851209.9, 510.7];
const distance = 4000;
const pitch = 0.3;
const yaw = 0;
const up = DEFAULT_UP_AXIS;

const FOV_Y = Math.PI / 3;
const NEAR = 0.01;
const FAR = 1e7;
const width = 1600;
const height = 900;

// orbit-camera.ts の eye() と同じ考え方（upAxis に直交する水平基底で yaw を回す）
function horizontalBasis(u: Vec3): { right: Vec3; forward: Vec3 } {
  const ref: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const right = norm(cross(ref, u));
  const forward = norm(cross(u, right));
  return { right, forward };
}

const { right, forward } = horizontalBasis(up);
const cosP = Math.cos(pitch);
const eye: Vec3 = [
  target[0] + distance * (cosP * (right[0] * Math.sin(yaw) + forward[0] * Math.cos(yaw)) + up[0] * Math.sin(pitch)),
  target[1] + distance * (cosP * (right[1] * Math.sin(yaw) + forward[1] * Math.cos(yaw)) + up[1] * Math.sin(pitch)),
  target[2] + distance * (cosP * (right[2] * Math.sin(yaw) + forward[2] * Math.cos(yaw)) + up[2] * Math.sin(pitch)),
];

const view = lookAt(eye, target, up);
const proj = perspective(FOV_Y, width / height, NEAR, FAR);
const viewProj = multiply(proj, view);
const inv = invert(viewProj);

console.log("eye    =", eye.map((v) => v.toFixed(1)).join(", "));
console.log("target =", target.map((v) => v.toFixed(1)).join(", "));
console.log("up     =", up.join(", "));
console.log("invert(viewProj) =", inv ? "取得できた" : "*** null（逆行列が求まらない） ***");
if (!inv) process.exit(1);

console.log("\ninvViewProj の成分の大きさ:");
const mags = inv.map(Math.abs).filter((v) => v > 0);
console.log("  最小", Math.min(...mags).toExponential(2), " 最大", Math.max(...mags).toExponential(2));

// シェーダと同じ式で dir を求める
function dirAt(m: number[], ndcX: number, ndcY: number): { dir: Vec3; w: number } {
  const [x, y, z, w] = transformPoint(m, [ndcX, ndcY, 1]); // NDC z=1（遠クリップ面）
  const far: Vec3 = [x / w, y / w, z / w];
  const d: Vec3 = [far[0] - eye[0], far[1] - eye[1], far[2] - eye[2]];
  const len = Math.hypot(...d);
  return { dir: [d[0] / len, d[1] / len, d[2] / len], w };
}

const f32 = Array.from(new Float32Array(inv));

console.log("\n画面上の各点での t = dot(dir, up)（正なら空、負なら地面）:");
console.log("  位置          f64 の t      f32 の t      w(f64)");
for (const [name, nx, ny] of [
  ["上端中央", 0, 1],
  ["中央", 0, 0],
  ["下端中央", 0, -1],
  ["左上", -1, 1],
] as const) {
  const a = dirAt(inv, nx, ny);
  const b = dirAt(f32, nx, ny);
  const t64 = a.dir[0] * up[0] + a.dir[1] * up[1] + a.dir[2] * up[2];
  const t32 = b.dir[0] * up[0] + b.dir[1] * up[1] + b.dir[2] * up[2];
  console.log(
    `  ${name.padEnd(10)} ${t64.toFixed(6).padStart(12)} ${t32.toFixed(6).padStart(12)} ${a.w.toExponential(2)}`,
  );
}

console.log("\n判定:");
const center64 = dirAt(inv, 0, 0);
const center32 = dirAt(f32, 0, 0);
const t64 = center64.dir[2];
const t32c = center32.dir[2];
if (!Number.isFinite(t32c)) console.log("  *** f32 で NaN/Inf が出ている。これが原因 ***");
else if (Math.abs(t64 - t32c) > 0.01) console.log("  *** f32 化で t が大きくずれる。精度が原因 ***");
else console.log("  f64 と f32 で t はほぼ一致。行列と精度は原因ではない");
