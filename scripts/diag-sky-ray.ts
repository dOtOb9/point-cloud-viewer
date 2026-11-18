import { cameraBasis, invert, lookAt, multiply, perspective, transformPoint } from "../src/renderer/mat4";
import { ndcPointToWorldRay } from "../src/renderer/raycast";
import { DEFAULT_UP_AXIS, type Vec3 } from "../src/renderer/up-axis";

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
const aspect = width / height;

const F64_TOLERANCE = 1e-6;
const F32_TOLERANCE = 1e-4;
const BROKEN_METHOD_MIN_ERROR = 0.01;

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

const { right: horizRight, forward: horizForward } = horizontalBasis(up);
const cosP = Math.cos(pitch);
const eye: Vec3 = [
  target[0] +
    distance * (cosP * (horizRight[0] * Math.sin(yaw) + horizForward[0] * Math.cos(yaw)) + up[0] * Math.sin(pitch)),
  target[1] +
    distance * (cosP * (horizRight[1] * Math.sin(yaw) + horizForward[1] * Math.cos(yaw)) + up[1] * Math.sin(pitch)),
  target[2] +
    distance * (cosP * (horizRight[2] * Math.sin(yaw) + horizForward[2] * Math.cos(yaw)) + up[2] * Math.sin(pitch)),
];

const view = lookAt(eye, target, up);
const proj = perspective(FOV_Y, aspect, NEAR, FAR);
const viewProj = multiply(proj, view);

console.log("eye    =", eye.map((v) => v.toFixed(1)).join(", "));
console.log("target =", target.map((v) => v.toFixed(1)).join(", "));
console.log("up     =", up.join(", "));

const SCREEN_POINTS: readonly [string, number, number][] = [
  ["中央", 0, 0],
  ["上端中央", 0, 1],
  ["下端中央", 0, -1],
  ["左上", -1, 1],
  ["右上", 1, 1],
  ["左下", -1, -1],
  ["右下", 1, -1],
];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(...v);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function truthAt(nx: number, ny: number): Vec3 {
  const ray = ndcPointToWorldRay(viewProj, nx, ny);
  if (!ray) throw new Error(`ndcPointToWorldRay(${nx}, ${ny}) がnullを返した（viewProjが特異）`);
  return ray.direction;
}

let anyFailure = false;

console.log("\n========== 世代0: invViewProjをそのままf32でGPUに渡す ==========");

const inv = invert(viewProj);
console.log("invert(viewProj) =", inv ? "取得できた" : "*** null（逆行列が求まらない） ***");
if (!inv) process.exit(1);

const mags = inv.map(Math.abs).filter((v) => v > 0);
console.log("invViewProj の成分の大きさ: 最小", Math.min(...mags).toExponential(2), " 最大", Math.max(...mags).toExponential(2));

function dirAtGen0(m: number[], ndcX: number, ndcY: number): { dir: Vec3; w: number } {
  const [x, y, z, w] = transformPoint(m, [ndcX, ndcY, 1]);
  const far: Vec3 = [x / w, y / w, z / w];
  const d: Vec3 = [far[0] - eye[0], far[1] - eye[1], far[2] - eye[2]];
  const len = Math.hypot(...d);
  return { dir: [d[0] / len, d[1] / len, d[2] / len], w };
}

const invF32 = Array.from(new Float32Array(inv));

console.log("\n  位置          f64のt        f32のt        w(f64)");
let gen0AnyNaN = false;
for (const [name, nx, ny] of SCREEN_POINTS) {
  const a = dirAtGen0(inv, nx, ny);
  const b = dirAtGen0(invF32, nx, ny);
  const t64 = dot(a.dir, up);
  const t32 = dot(b.dir, up);
  if (!Number.isFinite(t32)) gen0AnyNaN = true;
  console.log(`  ${name.padEnd(10)} ${t64.toFixed(6).padStart(12)} ${t32.toFixed(6).padStart(12)} ${a.w.toExponential(2)}`);
}
console.log(gen0AnyNaN ? "  *** f32でNaN/Infが発生（既知の不具合。想定通り） ***" : "  NaNは発生しなかった");
if (!gen0AnyNaN) {
  console.log("  *** 世代0の不具合が再現しなくなっている。診断用パラメータを確認すること ***");
  anyFailure = true;
}

console.log("\n========== 世代1: 頂点方向(正規化済み)を線形補間する ==========");

const TRIANGLE_NDC_VERTS: readonly [number, number][] = [
  [-1, -1],
  [3, -1],
  [-1, 3],
];
const vertexDirsF64 = TRIANGLE_NDC_VERTS.map(([nx, ny]) => truthAt(nx, ny));
const vertexDirsF32 = vertexDirsF64.map((d) => Array.from(new Float32Array(d)) as Vec3);

function barycentricLerp(dirs: readonly Vec3[], ndcX: number, ndcY: number): Vec3 {
  const a = (ndcX + 1) / 4;
  const b = (ndcY + 1) / 4;
  const w0 = 1 - a - b;
  return [
    w0 * dirs[0][0] + a * dirs[1][0] + b * dirs[2][0],
    w0 * dirs[0][1] + a * dirs[1][1] + b * dirs[2][1],
    w0 * dirs[0][2] + a * dirs[1][2] + b * dirs[2][2],
  ];
}

console.log("  位置          長さ(補間直後)   誤差|dir-真値|   判定");
let gen1MaxError = 0;
let gen1AnyNaN = false;
for (const [name, nx, ny] of SCREEN_POINTS) {
  const raw = barycentricLerp(vertexDirsF32, nx, ny);
  const rawLen = Math.hypot(...raw);
  const interpolated = normalize(raw);
  const truth = truthAt(nx, ny);
  const error = Number.isFinite(interpolated[0]) ? dist(interpolated, truth) : NaN;
  if (!Number.isFinite(error)) gen1AnyNaN = true;
  else gen1MaxError = Math.max(gen1MaxError, error);
  console.log(
    `  ${name.padEnd(10)} ${rawLen.toFixed(4).padStart(14)} ${Number.isFinite(error) ? error.toFixed(6).padStart(14) : "NaN".padStart(14)}`,
  );
}
console.log(`  最大誤差(NaNを除く): ${gen1MaxError.toFixed(6)}${gen1AnyNaN ? "（一部の点でNaNも発生）" : ""}`);
if (!gen1AnyNaN && gen1MaxError < BROKEN_METHOD_MIN_ERROR) {
  console.log(`  *** 世代1の不具合が再現しなくなっている(誤差<${BROKEN_METHOD_MIN_ERROR})。診断用パラメータを確認すること ***`);
  anyFailure = true;
} else {
  console.log("  *** 明確に真値からずれている（想定通り。これが「画面が真っ黒になる」原因） ***");
}

console.log("\n========== 世代2（現在の実装）: 画素ごとに基底から直接組み立てる ==========");

const { forward, right, up: camUp } = cameraBasis(eye, target, up);
const tanHalfFovY = Math.tan(FOV_Y / 2);
const rightScaled: Vec3 = [right[0] * aspect * tanHalfFovY, right[1] * aspect * tanHalfFovY, right[2] * aspect * tanHalfFovY];
const upScaled: Vec3 = [camUp[0] * tanHalfFovY, camUp[1] * tanHalfFovY, camUp[2] * tanHalfFovY];

function reconstructGen2(basis: { forward: Vec3; rightScaled: Vec3; upScaled: Vec3 }, ndcX: number, ndcY: number): Vec3 {
  const dx = basis.forward[0] + ndcX * basis.rightScaled[0] + ndcY * basis.upScaled[0];
  const dy = basis.forward[1] + ndcX * basis.rightScaled[1] + ndcY * basis.upScaled[1];
  const dz = basis.forward[2] + ndcX * basis.rightScaled[2] + ndcY * basis.upScaled[2];
  return normalize([dx, dy, dz]);
}

const forwardF32 = Array.from(new Float32Array(forward)) as Vec3;
const rightScaledF32 = Array.from(new Float32Array(rightScaled)) as Vec3;
const upScaledF32 = Array.from(new Float32Array(upScaled)) as Vec3;

console.log("  位置          誤差(f64基底)     誤差(f32基底)     判定");
let gen2MaxErrorF64 = 0;
let gen2MaxErrorF32 = 0;
for (const [name, nx, ny] of SCREEN_POINTS) {
  const truth = truthAt(nx, ny);
  const reconstructedF64 = reconstructGen2({ forward, rightScaled, upScaled }, nx, ny);
  const reconstructedF32 = reconstructGen2({ forward: forwardF32, rightScaled: rightScaledF32, upScaled: upScaledF32 }, nx, ny);
  const errorF64 = dist(reconstructedF64, truth);
  const errorF32 = dist(reconstructedF32, truth);
  gen2MaxErrorF64 = Math.max(gen2MaxErrorF64, errorF64);
  gen2MaxErrorF32 = Math.max(gen2MaxErrorF32, errorF32);
  const ok = errorF64 < F64_TOLERANCE && errorF32 < F32_TOLERANCE;
  if (!ok) anyFailure = true;
  console.log(
    `  ${name.padEnd(10)} ${errorF64.toExponential(2).padStart(16)} ${errorF32.toExponential(2).padStart(16)}   ${ok ? "OK" : "*** 不一致 ***"}`,
  );
}
console.log(`  最大誤差: f64基底=${gen2MaxErrorF64.toExponential(2)} (閾値${F64_TOLERANCE.toExponential(0)})  f32基底=${gen2MaxErrorF32.toExponential(2)} (閾値${F32_TOLERANCE.toExponential(0)})`);

console.log("\n========== 総合判定 ==========");
console.log(`  世代0（invViewProjをf32で渡す）        : ${gen0AnyNaN ? "NaN発生（既知の不具合の再現。想定通り）" : "*** NaN無し（再現していない） ***"}`);
console.log(
  `  世代1（頂点方向を線形補間）            : ${
    gen1AnyNaN || gen1MaxError >= BROKEN_METHOD_MIN_ERROR
      ? `真値と不一致（既知の不具合の再現。想定通り。最大誤差${gen1MaxError.toFixed(4)}）`
      : "*** 真値と一致してしまっている（再現していない） ***"
  }`,
);
console.log(
  `  世代2（画素ごとに基底から再構成。現在の実装）: ${
    gen2MaxErrorF64 < F64_TOLERANCE && gen2MaxErrorF32 < F32_TOLERANCE
      ? "真値と一致（修正できている）"
      : "*** 真値と不一致（要修正） ***"
  }`,
);

if (anyFailure) {
  console.log("\n*** 診断失敗。上記の *** を確認すること ***");
  process.exit(1);
}
console.log("\n診断成功。世代0・世代1は既知の不具合を再現し、世代2（現在の実装）は真値と数値的に一致した。");
