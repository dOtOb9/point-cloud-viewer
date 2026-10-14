import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective } from "./mat4";
import { projectPoint, projectSegment } from "./screen-project";

const view = lookAt([637000, 850000 - 100, 500], [637000, 850000, 500], [0, 0, 1]);
const viewProj = multiply(perspective(Math.PI / 3, 2, 0.01, 1e7), view);

describe("projectPoint", () => {
  it("注視点は画面の中央", () => {
    const p = projectPoint(viewProj, [637000, 850000, 500], 800, 400);
    expect(p?.x).toBeCloseTo(400, 6);
    expect(p?.y).toBeCloseTo(200, 6);
  });
  it("上にある点は画面の上（y が小さい）", () => {
    const p = projectPoint(viewProj, [637000, 850000, 510], 800, 400);
    expect(p && p.y < 200).toBe(true);
  });
  it("カメラの後ろは null", () => {
    expect(projectPoint(viewProj, [637000, 850000 - 200, 500], 800, 400)).toBeNull();
  });
});

describe("projectSegment", () => {
  it("両端が前なら両端をそのまま投影", () => {
    const s = projectSegment(viewProj, [636990, 850000, 500], [637010, 850000, 500], 800, 400);
    expect(s).not.toBeNull();
    expect(s![0].x).toBeLessThan(s![1].x);
  });
  it("片方が後ろなら、ニアプレーンで切って画面内へ有限の座標を返す", () => {
    const s = projectSegment(viewProj, [637000, 850000, 500], [637000, 850000 - 300, 500], 800, 400);
    expect(s).not.toBeNull();
    expect(Number.isFinite(s![1].x) && Number.isFinite(s![1].y)).toBe(true);
  });
  it("両方が後ろなら null", () => {
    expect(projectSegment(viewProj, [637000, 850000 - 200, 500], [637000, 850000 - 300, 500], 800, 400)).toBeNull();
  });
});
