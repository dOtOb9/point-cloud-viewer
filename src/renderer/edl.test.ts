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
  EDL_RESPONSE_SCALE,
  edlShadingFactor,
  linearizeDepth,
} from "./edl";

// EDL_RESPONSE_SCALE(既定300)を深度差に掛けるため、生の深度差(メートル相当)を
// そのまま数十・数百のオーダーで渡すと`exp(-response*scale*strength)`が
// 一瞬で0に潰れてしまい、shadeの大小関係を確認できない(実際に最初の実装で
// この落とし穴を踏んだ)。EDL_RESPONSE_SCALEから逆算した「指数部がおよそ0.5〜5に
// 収まる」小さい深度差を使うことで、定数の値が変わってもテストの意図
// (差が大きいほど暗くなる/strengthが強いほど暗くなる)がそのまま検証できるようにする。
const SMALL_GAP = 0.5 / EDL_RESPONSE_SCALE;
const LARGE_GAP = 5 / EDL_RESPONSE_SCALE;

describe("DEFAULT_EDL_ENABLED / DEFAULT_EDL_STRENGTH / DEFAULT_EDL_RADIUS_PX", () => {
  it("既定はオン（タスクシートの指示通り）", () => {
    expect(DEFAULT_EDL_ENABLED).toBe(true);
  });

  it("強さは所有者が実機で確認した0.05、半径は未検証だが、どちらも意味のある正の値が入っている", () => {
    expect(DEFAULT_EDL_STRENGTH).toBe(0.05);
    expect(DEFAULT_EDL_RADIUS_PX).toBeGreaterThan(0);
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

  it("自分と近傍の深度がすべて同じなら、差が無いので1.0のまま", () => {
    expect(edlShadingFactor(100, [100, 100, 100], 1.0)).toBeCloseTo(1.0, 12);
  });

  it("自分が近傍より奥にある(depthが大きい)ほど暗くなる(shadeが1未満で小さくなる)", () => {
    const base = 100;
    const shadeSmallGap = edlShadingFactor(base + SMALL_GAP, [base, base, base, base], 1.0);
    const shadeLargeGap = edlShadingFactor(base + LARGE_GAP, [base, base, base, base], 1.0);
    expect(shadeSmallGap).toBeLessThan(1.0);
    expect(shadeLargeGap).toBeLessThan(shadeSmallGap);
  });

  it("自分が近傍より手前にある(depthが小さい)場合は暗くならない — 手前に飛び出した部分は明るいまま残る", () => {
    const base = 100;
    // 近傍(奥)より自分(手前)のほうが浅い depth なので、max(0, own - neighbour) は
    // すべて0にクリップされ、response=0のまま。
    expect(edlShadingFactor(base - LARGE_GAP, [base, base + LARGE_GAP, base + 2 * LARGE_GAP], 1.0)).toBeCloseTo(1.0, 12);
  });

  it("strengthが大きいほど、同じ深度差でもより暗くなる", () => {
    const base = 100;
    const weak = edlShadingFactor(base + LARGE_GAP, [base, base, base, base], 0.5);
    const strong = edlShadingFactor(base + LARGE_GAP, [base, base, base, base], 2.0);
    expect(strong).toBeLessThan(weak);
  });

  it("戻り値は常に(0, 1]の範囲に収まる（現実的な深度差の範囲で）", () => {
    const values = [
      edlShadingFactor(100 + LARGE_GAP, [100, 100, 100], 2.0),
      edlShadingFactor(0, [0, 0], 1.0),
      edlShadingFactor(SMALL_GAP, [0], 1.0),
    ];
    for (const v of values) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("深度差が極端に大きい場合はshadeが0近くまで潰れてよい（浮動小数点のexpのアンダーフロー。異常ではない）", () => {
    // 実際のシーンでは点群と背景の境目のような、桁違いに大きい深度差が起こり得る。
    // その場合shadeが0(完全な黒)に潰れるのは意図通りの挙動であることを明示しておく
    // (最初にこのテストを書いたときはこの潰れを見落として別のテストで誤って
    // failさせていた)。
    expect(edlShadingFactor(1e6, [1, 1, 1], 5.0)).toBe(0);
  });
});
