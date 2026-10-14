import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective, transformPoint } from "./mat4";
import {
  COARSE_HALF,
  depthQuantumAt,
  depthToEyeDistance,
  nearestHit,
  refineDepthRange,
  unprojectWindowSample,
  windowViewProj,
} from "./pick-math";

const NEAR = 0.01;
const FAR = 1e7;

describe("depthToEyeDistance", () => {
  it("perspective の深度から元の距離に戻る", () => {
    const proj = perspective(Math.PI / 3, 1.5, NEAR, FAR);
    for (const z of [0.5, 10, 3000, 90000]) {
      // 視点座標系で前方 z にある点（-z 方向）
      const [, , cz, cw] = transformPoint(proj, [0, 0, -z]);
      expect(depthToEyeDistance(cz / cw, NEAR, FAR)).toBeCloseTo(z, 3);
    }
  });
});

describe("refineDepthRange", () => {
  it("z/2 〜 2z（距離に比例した余裕）で、z を含む。非常に遠いときは刻みの4倍まで広がる", () => {
    const r100 = refineDepthRange(100, NEAR, FAR);
    expect(r100.near).toBeCloseTo(50, 9);
    expect(r100.far).toBeCloseTo(200, 9);
    const farAway = refineDepthRange(2e5, NEAR, FAR);
    expect(farAway.near).toBe(NEAR);
    expect(farAway.far).toBeGreaterThan(4e5);
    // 遠くの1刻みは約54（z=3000, near=0.01, 24bit）。式どおりであること。
    expect(depthQuantumAt(3000, NEAR, FAR)).toBeGreaterThan(50);
    expect(depthQuantumAt(3000, NEAR, FAR)).toBeLessThan(60);
  });
  it("near/far の範囲を出ない", () => {
    const r = refineDepthRange(0.011, NEAR, FAR);
    expect(r.near).toBeGreaterThanOrEqual(NEAR);
    expect(r.far).toBeLessThanOrEqual(FAR);
  });
});

describe("nearestHit", () => {
  it("点が無い（全部 1.0）なら null", () => {
    expect(nearestHit(new Float32Array(81).fill(1), 9)).toBeNull();
  });
  it("深度 0 も点なしとして扱う（作り直し直後のテクスチャ）", () => {
    expect(nearestHit(new Float32Array(81).fill(0), 9)).toBeNull();
  });
  it("中心に近い画素を選ぶ。同距離なら手前", () => {
    const d = new Float32Array(81).fill(1);
    d[0] = 0.5; // 隅（遠い画素）
    d[4 * 9 + 6] = 0.9; // 中心から (2,0)
    d[4 * 9 + 2] = 0.8; // 中心から (-2,0)。同距離で手前
    expect(nearestHit(d, 9)).toEqual({ ix: 2, iy: 4, depth: Math.fround(0.8) });
    d[4 * 9 + 4] = 0.95; // 中心そのもの
    expect(nearestHit(d, 9)?.ix).toBe(4);
  });
});

describe("windowViewProj と unprojectWindowSample", () => {
  it("大きな実座標（60万台）でも、窓の画素から元の点に戻る", () => {
    const width = 1280;
    const height = 720;
    const eye: [number, number, number] = [637000 + 800, 850000 - 900, 700];
    const target: [number, number, number] = [637000, 850000, 520];
    const view = lookAt(eye, target, [0, 0, 1]);
    const aspect = width / height;
    // 世界の点: 注視点の少し横
    const world: [number, number, number] = [637010.25, 850004.5, 515.75];
    // 1段階目: 通常の射影での距離（w）
    const viewProj = multiply(perspective(Math.PI / 3, aspect, NEAR, FAR), view);
    const clip = transformPoint(viewProj, world);
    const z = clip[3];
    const px = Math.floor(((clip[0] / clip[3] + 1) / 2) * width);
    const py = Math.floor((1 - clip[1] / clip[3]) * 0.5 * height);
    // 2段階目: 狭い near/far
    const range = refineDepthRange(z, NEAR, FAR);
    const tight = multiply(perspective(Math.PI / 3, aspect, range.near, range.far), view);
    const size = 2 * 2 + 1;
    const win = windowViewProj(tight, px, py, size, width, height);
    // 点は窓の中のどこかの画素の中にある。その画素の中心の ndc を求めて、深度は点のものを使って戻す。
    const wc = transformPoint(win, world);
    const ndcX = wc[0] / wc[3];
    const ndcY = wc[1] / wc[3];
    const ix = Math.floor(((ndcX + 1) / 2) * size);
    const iy = Math.floor(((1 - ndcY) / 2) * size);
    expect(ix).toBeGreaterThanOrEqual(0);
    expect(ix).toBeLessThan(size);
    expect(iy).toBeGreaterThanOrEqual(0);
    expect(iy).toBeLessThan(size);
    const back = unprojectWindowSample(win, ix, iy, size, wc[2] / wc[3]);
    expect(back).not.toBeNull();
    if (!back) return;
    // 画素の中心に戻すので、画面方向には1ピクセル分の誤差がありうる（距離 z のとき約 z*2*tan(fov/2)/height）。
    const pixelWorld = (z * 2 * Math.tan(Math.PI / 6)) / height;
    expect(Math.hypot(back[0] - world[0], back[1] - world[1], back[2] - world[2])).toBeLessThan(pixelWorld);
  });

  it("画面中央の点は、窓の中央（COARSE_HALF 番目の画素の左上）に来る", () => {
    const size = 2 * COARSE_HALF + 1;
    const view = lookAt([0, -10, 0], [0, 0, 0], [0, 0, 1]);
    const vp = multiply(perspective(Math.PI / 3, 1, 0.1, 100), view);
    // 画面中央 = 画素 (100,100) の左上の角。窓の中心画素は (100,100)。
    const win = windowViewProj(vp, 100, 100, size, 200, 200);
    const c = transformPoint(win, [0, 0, 0]);
    const ix = ((c[0] / c[3] + 1) / 2) * size;
    expect(ix).toBeCloseTo(COARSE_HALF, 6);
  });
});
