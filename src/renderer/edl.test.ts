import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDL_ENABLED,
  DEFAULT_EDL_RADIUS_PX,
  DEFAULT_EDL_STRENGTH,
  EDL_MIN_SHADE,
  EDL_RESPONSE_SCALE,
  edlShadingFactor,
  linearizeDepth,
} from "./edl";

const SMALL_RATIO = Math.pow(2, 0.5 / EDL_RESPONSE_SCALE);
const LARGE_RATIO = Math.pow(2, 5 / EDL_RESPONSE_SCALE);
const NEAR_DISTANCE = 10;
const FAR_DISTANCE = 1000;

describe("DEFAULT_EDL_ENABLED / DEFAULT_EDL_STRENGTH / DEFAULT_EDL_RADIUS_PX / EDL_MIN_SHADE", () => {
  it("既定はオン（タスクシートの指示通り）", () => {
    expect(DEFAULT_EDL_ENABLED).toBe(true);
  });

  it("強さはlog2の式に合わせて決めた0.15、半径は未検証だが、どちらも意味のある正の値が入っている", () => {
    expect(DEFAULT_EDL_STRENGTH).toBe(0.15);
    expect(DEFAULT_EDL_RADIUS_PX).toBeGreaterThan(0);
  });

  it("陰影の下限は0より大きく1より小さい（エッジは暗くなるが真っ黒にはならない）", () => {
    expect(EDL_MIN_SHADE).toBeGreaterThan(0);
    expect(EDL_MIN_SHADE).toBeLessThan(1);
  });
});

describe("linearizeDepth", () => {
  const NEAR = 0.01;
  const FAR = 1e7;

  it("ndcDepth=0（近クリップ）でnearになる", () => {
    expect(linearizeDepth(0, NEAR, FAR)).toBeCloseTo(NEAR, 9);
  });

  it("ndcDepth=1（遠クリップ）でfarになる（相対誤差で確認: farが桁の大きい値のため、浮動小数点の丸め誤差を許容する）", () => {
    const result = linearizeDepth(1, NEAR, FAR);
    expect(Math.abs(result - FAR) / FAR).toBeLessThan(1e-6);
  });

  it("ndcDepthが大きいほど、線形化した深度も単調に増える", () => {
    const d0 = linearizeDepth(0.1, NEAR, FAR);
    const d1 = linearizeDepth(0.5, NEAR, FAR);
    const d2 = linearizeDepth(0.9, NEAR, FAR);
    expect(d0).toBeLessThan(d1);
    expect(d1).toBeLessThan(d2);
  });

  it("near=farのように退化した入力でも例外を投げない（0除算はInfinityになるだけ）", () => {
    expect(() => linearizeDepth(0.5, 1, 1)).not.toThrow();
  });
});

describe("edlShadingFactor", () => {
  it("strength=0のときは常に1.0（無変化）を返す — 受け入れ条件「強さ0でM1と同じ見た目になる」", () => {
    expect(edlShadingFactor(100, [10, 500, 1000], 0)).toBe(1.0);
    expect(edlShadingFactor(100, [1000, 2000], 0)).toBe(1.0);
  });

  it("近傍が空(要素数0)のときは1.0（無変化）を返す（画面端などで近傍が取れない場合の安全側）", () => {
    expect(edlShadingFactor(100, [], 1.0)).toBe(1.0);
  });

  it("平らな面（自分と近傍の深度がすべて同じ）なら、差が無いので1.0のまま", () => {
    expect(edlShadingFactor(100, [100, 100, 100, 100], DEFAULT_EDL_STRENGTH)).toBeCloseTo(1.0, 12);
    expect(edlShadingFactor(100, [100, 100, 100, 100], 1.0)).toBeCloseTo(1.0, 12);
  });

  it("自分が近傍より奥にある(depthが大きい)ほど暗くなる(shadeが1未満で小さくなる)", () => {
    const base = 100;
    const smallGap = edlShadingFactor(base * SMALL_RATIO, [base, base, base, base], 1.0);
    const largeGap = edlShadingFactor(base * LARGE_RATIO, [base, base, base, base], 1.0);
    expect(smallGap).toBeLessThan(1.0);
    expect(largeGap).toBeLessThan(smallGap);
  });

  it("自分が近傍より手前にある(depthが小さい)場合は暗くならない — 手前に飛び出した部分は明るいまま残る", () => {
    const base = 100;
    expect(edlShadingFactor(base / LARGE_RATIO, [base, base * LARGE_RATIO, base * LARGE_RATIO ** 2], 1.0)).toBeCloseTo(1.0, 12);
  });

  it("strengthが大きいほど、同じ深度差でもより暗くなる", () => {
    const base = 100;
    const weak = edlShadingFactor(base * SMALL_RATIO, [base, base, base, base], 0.2);
    const strong = edlShadingFactor(base * SMALL_RATIO, [base, base, base, base], 0.6);
    expect(strong).toBeLessThan(weak);
  });

  it("距離に依らない: 同じ深度の比なら、10mでも1000mでも同じshadeになる（メートル差だったときの不具合の回帰テスト）", () => {
    for (const ratio of [SMALL_RATIO, LARGE_RATIO, 1.5]) {
      const near = edlShadingFactor(NEAR_DISTANCE * ratio, [NEAR_DISTANCE, NEAR_DISTANCE, NEAR_DISTANCE], 1.0);
      const far = edlShadingFactor(FAR_DISTANCE * ratio, [FAR_DISTANCE, FAR_DISTANCE, FAR_DISTANCE], 1.0);
      expect(near).toBeCloseTo(far, 12);
    }
  });

  it("メートルで10mの段差でも、距離1000mなら比は1%なので浅い陰影にしかならない（旧実装は距離を問わず黒に飽和した）", () => {
    const shade = edlShadingFactor(1010, [1000, 1000, 1000, 1000], DEFAULT_EDL_STRENGTH);
    expect(shade).toBeGreaterThan(EDL_MIN_SHADE);
  });

  it("shadeはEDL_MIN_SHADEを下回らない（極端な段差でも真っ黒にならない）", () => {
    expect(edlShadingFactor(1e6, [1, 1, 1], 5.0)).toBe(EDL_MIN_SHADE);
    expect(edlShadingFactor(1e6, [1, 1, 1], DEFAULT_EDL_STRENGTH)).toBe(EDL_MIN_SHADE);
    expect(edlShadingFactor(100 * LARGE_RATIO, [100, 100, 100], 2.0)).toBeGreaterThanOrEqual(EDL_MIN_SHADE);
  });

  it("戻り値は常に[EDL_MIN_SHADE, 1]の範囲に収まる", () => {
    const values = [
      edlShadingFactor(100 * LARGE_RATIO, [100, 100, 100], 2.0),
      edlShadingFactor(10, [10, 10], 1.0),
      edlShadingFactor(1000, [1], 1.0),
      edlShadingFactor(1, [1000], 1.0),
    ];
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(EDL_MIN_SHADE);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

import { orthographicMatrix, transformPoint } from "./mat4";
import { edlLogDepth, edlLogDepthOrtho, edlShadingFactorFromLogs, linearizeDepthOrtho } from "./edl";

describe("linearizeDepthOrtho", () => {
  it("returns the eye distance of a point (also for negative near)", () => {
    const near = -300;
    const far = 500;
    const m = orthographicMatrix(10, 1.6, near, far);
    for (const z of [-250, 0, 120, 480]) {
      const c = transformPoint(m, [1, 2, -z]);
      expect(linearizeDepthOrtho(c[2] / c[3], near, far)).toBeCloseTo(z, 6);
    }
  });
});

describe("edlShadingFactorFromLogs / the two projections", () => {
  it("perspective: unchanged (edlShadingFactor is edlShadingFactorFromLogs of log2)", () => {
    const own = 100;
    const neighbours = [99, 100, 98];
    expect(edlShadingFactor(own, neighbours, 0.15)).toBeCloseTo(
      edlShadingFactorFromLogs(edlLogDepth(own), neighbours.map(edlLogDepth), 0.15),
      12,
    );
  });

  it("orthographic: the response depends on the step relative to the orbit distance, not on the eye plane", () => {
    const ref = 100;
    const a = edlShadingFactorFromLogs(edlLogDepthOrtho(-50 + 2, ref), [edlLogDepthOrtho(-50, ref)], 0.15);
    const b = edlShadingFactorFromLogs(edlLogDepthOrtho(900 + 2, ref), [edlLogDepthOrtho(900, ref)], 0.15);
    expect(a).toBeCloseTo(b, 9);
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThanOrEqual(EDL_MIN_SHADE);
  });

  it("orthographic: a bigger step relative to the zoom is darker; a step toward the camera does not darken", () => {
    const ref = 100;
    const small = edlShadingFactorFromLogs(edlLogDepthOrtho(1, ref), [edlLogDepthOrtho(0, ref)], 0.15);
    const large = edlShadingFactorFromLogs(edlLogDepthOrtho(5, ref), [edlLogDepthOrtho(0, ref)], 0.15);
    expect(large).toBeLessThanOrEqual(small);
    expect(edlShadingFactorFromLogs(edlLogDepthOrtho(0, ref), [edlLogDepthOrtho(5, ref)], 0.15)).toBe(1);
  });

  it("orthographic: matches the perspective value near the target plane (first order, the same zoom)", () => {
    const persp = edlLogDepth(101) - edlLogDepth(100);
    const ortho = edlLogDepthOrtho(101, 100) - edlLogDepthOrtho(100, 100);
    expect(ortho).toBeCloseTo(persp, 3);
  });

  it("strength 0 and no neighbours give 1 (both projections)", () => {
    expect(edlShadingFactorFromLogs(1, [0], 0)).toBe(1);
    expect(edlShadingFactorFromLogs(1, [], 0.15)).toBe(1);
  });
});
