// 空とグリッドが効かない件の診断。同じ根本原因（ワールド空間の情報をf32でGPUに
// 渡すこと）が2回、別の経路でNaNを引き起こした顛末を、3世代の方式を並べて
// 検証する（TaskSheets/M2-shading-and-ui.md M2-0c参照）。
//
// 世代0（最初の実装。壊れていた）: viewProjの逆行列(invViewProj)をそのまま
// f32でGPUに渡し、シェーダで`invViewProj * ndc`からレイ方向を復元する。
// NEAR/FAR(0.01/1e7)のダイナミックレンジとautzenのような大きなワールド座標が
// 重なると、変換後のwがf32で桁落ちして0になり、`xyz/w`がInf、`normalize`が
// NaNになる。
//
// 世代1（1回目の修正のつもり。これも壊れていた）: 行列を渡すのをやめ、
// 全画面三角形の3頂点それぞれのレイ方向(正規化済み)をf64で計算してf32で渡し、
// 線形補間してから再度normalizeする方式にした。だが三角形の頂点はNDC=3
// （画面中心から70度以上）まで延びており、**正規化済みの単位ベクトルをこの
// 角度で線形補間すると、球面上の弧ではなく弦を取ることになって長さが縮む**。
// 前回の診断はNaNの有無しか見ておらず、この「値が真値からずれる」問題
// （縮んだ長さがほぼ0になった場所ではNaNにもなる）を見逃した。
// **教訓: 「NaNが出ない」ことは「値が正しい」ことを意味しない。**
//
// 世代2（現在の実装）: レイ方向の補間そのものをやめた。頂点シェーダで補間するのは
// NDC座標（位置。アフィンな量なので線形補間で正しい）だけにし、フラグメント
// シェーダで画素ごとに`dir = normalize(forward + ndc.x*rightScaled + ndc.y*upScaled)`
// として直接組み立てる。`forward`/`right`/`up`はmat4.tsの`cameraBasis()`から
// f64で求める。NDCがいくつでも厳密（外挿ではなく透視投影の逆関数そのもの）。
//
// このスクリプトは世代0・世代1が実際に壊れている（NaN、または真値との
// 数値的な不一致）ことを再現しつつ、世代2が真値と数値的に一致することを
// assertする。「NaNが出ない」ではなく「値が正しい」を検証する
// （2回目の実機不具合が、この違いを検証していなかったために見逃されたため）。
//
// 使い方: npx tsx scripts/diag-sky-ray.ts

import { cameraBasis, invert, lookAt, multiply, perspective, transformPoint } from "../src/renderer/mat4";
import { ndcPointToWorldRay } from "../src/renderer/raycast";
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
const aspect = width / height;

// f64での基底方式(世代2)の誤差は実測で~1e-8（丸め誤差そのもの）。1e-6は十分な
// 余裕を持って厳しい閾値（コーディネーターの数値検証より。1e-9のような厳しすぎる
// 値は正しい実装でも丸め誤差で落ちるので避ける）。
const F64_TOLERANCE = 1e-6;
// f32にキャストした基底(世代2)の誤差はもう少し乗るため、閾値を緩める。
const F32_TOLERANCE = 1e-4;
// 世代1（線形補間方式）が「明確に壊れている」と判定する下限。実測の誤差は
// 最大0.16程度で、上のF64_TOLERANCE/F32_TOLERANCEとは3〜4桁違う。
const BROKEN_METHOD_MIN_ERROR = 0.01;

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

// 画面上の検証点。中心・上下端・4隅（NDCが±1に近い、視野の端に一番近い場所。
// 受け入れ条件「特にNDCが±1に近い隅」に対応）。
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

// 真値: invert(viewProj)からf64で直接求めたレイ方向（raycast.tsのndcPointToWorldRayと
// 同じ実装。カーソルのズームで実際に使われていて正しく動くことが確認済み）。
function truthAt(nx: number, ny: number): Vec3 {
  const ray = ndcPointToWorldRay(viewProj, nx, ny);
  if (!ray) throw new Error(`ndcPointToWorldRay(${nx}, ${ny}) がnullを返した（viewProjが特異）`);
  return ray.direction;
}

let anyFailure = false;

// ============================================================
// 世代0: invViewProjをそのままf32でGPUに渡す（最初の実装。壊れていた）
// ============================================================
console.log("\n========== 世代0: invViewProjをそのままf32でGPUに渡す ==========");

const inv = invert(viewProj);
console.log("invert(viewProj) =", inv ? "取得できた" : "*** null（逆行列が求まらない） ***");
if (!inv) process.exit(1);

const mags = inv.map(Math.abs).filter((v) => v > 0);
console.log("invViewProj の成分の大きさ: 最小", Math.min(...mags).toExponential(2), " 最大", Math.max(...mags).toExponential(2));

// シェーダと同じ式（世代0）で dir を求める
function dirAtGen0(m: number[], ndcX: number, ndcY: number): { dir: Vec3; w: number } {
  const [x, y, z, w] = transformPoint(m, [ndcX, ndcY, 1]); // NDC z=1（遠クリップ面）
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

// ============================================================
// 世代1: 全画面三角形の3頂点の方向を線形補間する（1回目の修正のつもり。壊れていた）
// ============================================================
console.log("\n========== 世代1: 頂点方向(正規化済み)を線形補間する ==========");

// sky.ts/ground-grid.tsのvs_mainのpositionsと同じ、全画面三角形の3頂点(NDC座標)。
const TRIANGLE_NDC_VERTS: readonly [number, number][] = [
  [-1, -1],
  [3, -1],
  [-1, 3],
];
const vertexDirsF64 = TRIANGLE_NDC_VERTS.map(([nx, ny]) => truthAt(nx, ny));
const vertexDirsF32 = vertexDirsF64.map((d) => Array.from(new Float32Array(d)) as Vec3);

/**
 * GPUのラスタライザが行う重心座標での線形補間を再現する（w=1で全頂点共通なので
 * パースペクティブ補正なしの単純な線形補間になる。V0->V1、V0->V2の辺の長さが
 * どちらも4なので重み(a,b)は単純な式）。
 */
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

// ============================================================
// 世代2（現在の実装）: 画素ごとに基底(forward/rightScaled/upScaled)から直接組み立てる
// ============================================================
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

// f32にキャストした基底（sky.draw()/grid.draw()がGPUに書き込む値そのもの）。
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

// ============================================================
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
