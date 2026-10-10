// edl.ts のテスト（M2-1）。
//
// EdlPass本体はGPUDeviceを要る（sky.ts/ground-grid.tsと同様、実機のWebGPUが無いと
// テストできない）。ここではGPUに依存しない純粋関数(linearizeDepth/edlShadingFactor)
// だけを担保する。WGSL側（EDL_SHADER_SRC内の同名ロジック）はこれらのTypeScript版と
// 同じ式を手で再実装したものであり、GPUが無い環境では直接検証できない
// （edl.tsファイル冒頭のコメント参照）。

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

// 深度差はlog2で見る（距離の比。edl.tsの「log2にした理由」参照）ので、テストの深度差も
// 「比」で作る。EDL_RESPONSE_SCALE・既定strengthが変わっても意図が崩れないよう、
// 指数部がおよそ0.5〜5になる比を定数から逆算する（strength=1で試す）。
const SMALL_RATIO = Math.pow(2, 0.5 / EDL_RESPONSE_SCALE);
const LARGE_RATIO = Math.pow(2, 5 / EDL_RESPONSE_SCALE);
// 同じ比を、近いカメラ(10m)と遠いカメラ(1000m)の両方で作る。
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
