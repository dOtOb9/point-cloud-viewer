// 空とグリッドが効かない件の診断、および修正後の新方式が同じ条件でNaNを出さないことの確認。
//
// 前半（旧方式）: レンダラが実機不具合を起こしていた当時の手順で viewProj を組み、
// その逆行列(invViewProj)からシェーダと同じ式でレイ方向を復元し、f64 と f32 の
// 両方で確かめる。f32にした瞬間に全ピクセルでNaNになることを再現する
// （このセクションは修正後もあえて残す。同じ罠を踏まないための記録）。
//
// 後半（新方式）: 修正後の実装（sky.ts/ground-grid.ts、point-cloud-renderer.ts）が
// 実際にやっていること——全画面三角形の3頂点のレイ方向をf64で計算し、
// 正規化済みの小さいベクトル(大きさ~1)だけをf32にキャストしてGPUへ渡す——を
// JS側でシミュレートする。GPUのラスタライザが行う重心座標での線形補間
// （頂点シェーダの`clipPosition.w`が全頂点で1なので、パースペクティブ補正なしの
// 単純な線形補間になる）も再現し、補間後に正規化した結果がNaNにならないことを示す。
//
// 使い方: npx tsx scripts/diag-sky-ray.ts

import { invert, lookAt, multiply, perspective, transformPoint } from "../src/renderer/mat4";
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

console.log("\n========== 旧方式（修正前。invViewProjをそのままf32でGPUに渡す）==========");
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

console.log("\n判定（旧方式）:");
const center64 = dirAt(inv, 0, 0);
const center32 = dirAt(f32, 0, 0);
const t64 = center64.dir[2];
const t32c = center32.dir[2];
const oldMethodIsNaN = !Number.isFinite(t32c);
if (oldMethodIsNaN) console.log("  *** f32 で NaN/Inf が出ている。これが原因 ***");
else if (Math.abs(t64 - t32c) > 0.01) console.log("  *** f32 化で t が大きくずれる。精度が原因 ***");
else console.log("  f64 と f32 で t はほぼ一致。行列と精度は原因ではない");

// ============================================================
// 新方式（修正後）: 行列もeyeもGPUに渡さない。JS(f64)でレイ方向だけを計算し、
// 正規化済みの小さいベクトルだけをf32にキャストしてGPUへ渡す。
// sky.ts/ground-grid.ts/point-cloud-renderer.tsが実際にやっていることと同じ手順を
// ここでJS側に再現し、f32キャストを経てもNaNが出ないことを示す。
// ============================================================
console.log("\n========== 新方式（修正後。レイ方向だけをf32でGPUに渡す）==========");

// sky.ts/ground-grid.tsのvs_mainのpositionsと同じ、全画面三角形の3頂点(NDC座標)。
const TRIANGLE_NDC_VERTS: readonly [number, number][] = [
  [-1, -1],
  [3, -1],
  [-1, 3],
];

// point-cloud-renderer.tsのdrawFrame()と同じ呼び出し。raycast.tsの
// ndcPointToWorldRay（カーソル位置に向かってズームする機能が実際に使っていて、
// 正しく動くことが確認済みの実装）をそのまま使う。f64のまま計算する。
const vertexRays = TRIANGLE_NDC_VERTS.map(([nx, ny]) => ndcPointToWorldRay(viewProj, nx, ny));
if (vertexRays.some((r) => r === null)) {
  console.log("  *** ndcPointToWorldRayがnullを返した（viewProjが特異）***");
  process.exit(1);
}
const vertexDirsF64 = vertexRays.map((r) => r!.direction);

// ここでf32にキャストするのは、正規化済みで大きさ~1の方向ベクトルだけ
// （sky.draw()/grid.draw()がGPUに書き込む値そのもの）。invViewProjやeyeの
// 絶対座標はもう登場しない。
const vertexDirsF32 = vertexDirsF64.map((d) => Array.from(new Float32Array(d)) as Vec3);

console.log("頂点方向(f64)      :", vertexDirsF64.map((d) => `[${d.map((v) => v.toFixed(6)).join(", ")}]`).join("  "));
console.log("頂点方向(f32キャスト後):", vertexDirsF32.map((d) => `[${d.map((v) => v.toFixed(6)).join(", ")}]`).join("  "));

/**
 * GPUのラスタライザが行う重心座標での線形補間を再現する。
 * 頂点シェーダの`out.clipPosition = vec4<f32>(p, 0.0, 1.0)`はどの頂点でもw=1なので、
 * パースペクティブ補正は効かず、スクリーン空間のNDC座標そのものでの
 * 単純な線形補間になる（sky.ts/ground-grid.tsのVertexOutのコメント参照）。
 * 三角形の頂点はV0=(-1,-1), V1=(3,-1), V2=(-1,3)で、辺V0->V1、V0->V2の長さが
 * どちらも4なので、重み(a, b)は単純な式になる。
 */
function barycentricLerp(dirs: readonly Vec3[], ndcX: number, ndcY: number): Vec3 {
  const a = (ndcX + 1) / 4; // V1方向の重み
  const b = (ndcY + 1) / 4; // V2方向の重み
  const w0 = 1 - a - b;
  return [
    w0 * dirs[0][0] + a * dirs[1][0] + b * dirs[2][0],
    w0 * dirs[0][1] + a * dirs[1][1] + b * dirs[2][1],
    w0 * dirs[0][2] + a * dirs[1][2] + b * dirs[2][2],
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(...v);
  return [v[0] / len, v[1] / len, v[2] / len];
}

console.log("\n新方式でのt = dot(normalize(補間したdir), up)（旧方式の表と同じ画面位置で比較。NaNが出なければ成功）:");
console.log("  位置          新方式(f32補間->正規化)のt   参考: 直接計算(f64)のt");
let anyNewMethodNaN = false;
for (const [name, nx, ny] of [
  ["上端中央", 0, 1],
  ["中央", 0, 0],
  ["下端中央", 0, -1],
  ["左上", -1, 1],
] as const) {
  const interpolated = normalize(barycentricLerp(vertexDirsF32, nx, ny));
  const tNew = interpolated[0] * up[0] + interpolated[1] * up[1] + interpolated[2] * up[2];
  const direct = dirAt(inv, nx, ny).dir; // 参考値: そのNDC位置を直接f64で計算した場合
  const tDirect = direct[0] * up[0] + direct[1] * up[1] + direct[2] * up[2];
  if (!Number.isFinite(tNew)) anyNewMethodNaN = true;
  console.log(`  ${name.padEnd(10)} ${tNew.toFixed(6).padStart(24)} ${tDirect.toFixed(6).padStart(24)}`);
}

console.log("\n判定（新方式）:");
if (anyNewMethodNaN) {
  console.log("  *** 新方式でもNaNが出ている。修正になっていない ***");
} else {
  console.log("  新方式は全ピクセルで有限値。NaNは出ていない（修正できている）");
}

console.log("\n========== 総合判定 ==========");
console.log(`  旧方式: ${oldMethodIsNaN ? "NaN発生（既知の不具合の再現。想定通り）" : "NaN無し"}`);
console.log(`  新方式: ${anyNewMethodNaN ? "*** NaN発生（要修正） ***" : "NaN無し（修正が効いている）"}`);

if (!oldMethodIsNaN) {
  // 旧方式の再現が失われていたら、このスクリプト自体が不具合の記録として機能しなくなる。
  console.log("\n  *** 旧方式でNaNが再現しなくなっている。診断用のパラメータ(NEAR/FAR/座標)を確認すること ***");
  process.exit(1);
}
if (anyNewMethodNaN) {
  process.exit(1);
}
