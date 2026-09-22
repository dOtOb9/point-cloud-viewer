// raycast.ts のテスト（M1-5）。
//
// ここで担保したいのは「カーソル位置に向かってズームする」機能の土台になる部分:
// - スクリーン座標からワールド空間のレイを正しく作れること
// - レイとAABBの交差判定が、当たる・当たらない・複数ノードのうち一番手前を選ぶ、を
//   正しく処理できること
//
// M5で正確なピッキング（深度バッファ読み出し）に置き換えるまでは、この粗いAABB交差が
// 「カーソルの下に何があるか」を知る唯一の手段になる。

import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective } from "./mat4";
import { closestHierarchyHit, intersectRayAabb, screenPointToWorldRay, type Ray } from "./raycast";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

describe("intersectRayAabb", () => {
  const box: [[number, number, number], [number, number, number]] = [
    [-1, -1, -1],
    [1, 1, 1],
  ];

  it("箱に正面から当たるレイは交点までの距離を返す", () => {
    const ray: Ray = { origin: [0, 0, -5], direction: [0, 0, 1] };
    const t = intersectRayAabb(ray, ...box);
    expect(t).toBeCloseTo(4, 6); // z=-5 から z=-1(箱の手前面)まで距離4
  });

  it("箱を外れるレイはnullを返す", () => {
    const ray: Ray = { origin: [10, 10, -5], direction: [0, 0, 1] };
    expect(intersectRayAabb(ray, ...box)).toBeNull();
  });

  it("箱の後ろ向きに進むレイ（箱がレイの後ろ側）はnullを返す", () => {
    const ray: Ray = { origin: [0, 0, -5], direction: [0, 0, -1] };
    expect(intersectRayAabb(ray, ...box)).toBeNull();
  });

  it("レイの原点が箱の内側にあるときは0を返す", () => {
    const ray: Ray = { origin: [0, 0, 0], direction: [1, 0, 0] };
    expect(intersectRayAabb(ray, ...box)).toBe(0);
  });

  it("軸に平行なレイでも、スラブの範囲内なら交差する", () => {
    const ray: Ray = { origin: [0, 0, -5], direction: [0, 0, 1] };
    // x, y方向は動かない（平行）が、x=0, y=0は箱の範囲[-1,1]の中なので交差する。
    const t = intersectRayAabb(ray, [-1, -1, -1], [1, 1, 1]);
    expect(t).not.toBeNull();
  });

  it("軸に平行なレイが、スラブの外を通るなら交差しない", () => {
    const ray: Ray = { origin: [5, 0, -5], direction: [0, 0, 1] };
    expect(intersectRayAabb(ray, [-1, -1, -1], [1, 1, 1])).toBeNull();
  });
});

describe("closestHierarchyHit", () => {
  it("複数のノードに当たるとき、最も近い交点を返す（遠いノードに引っ張られない）", () => {
    const ray: Ray = { origin: [0, 0, -20], direction: [0, 0, 1] };
    const near = { boundsMin: [-1, -1, -1] as const, boundsMax: [1, 1, 1] as const };
    const far = { boundsMin: [-1, -1, 10] as const, boundsMax: [1, 1, 12] as const };

    const hit = closestHierarchyHit(ray, [far, near]); // 配列の順序をわざと遠い方から
    expect(hit).not.toBeNull();
    expect(hit![2]).toBeCloseTo(-1, 6); // 近い箱の手前面(z=-1)で当たるはず
  });

  it("どのノードとも交差しなければnullを返す（空を指しているケース）", () => {
    const ray: Ray = { origin: [0, 0, -20], direction: [0, 1, 0] }; // 箱を通らない向き
    const node = { boundsMin: [-1, -1, -1] as const, boundsMax: [1, 1, 1] as const };
    expect(closestHierarchyHit(ray, [node])).toBeNull();
  });

  it("ノードが1つも無ければnullを返す", () => {
    const ray: Ray = { origin: [0, 0, 0], direction: [0, 0, 1] };
    expect(closestHierarchyHit(ray, [])).toBeNull();
  });
});

describe("screenPointToWorldRay", () => {
  it("画面中心のレイは、カメラのtarget方向をおおよそ向く", () => {
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    const ray = screenPointToWorldRay(viewProj, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, CANVAS_WIDTH, CANVAS_HEIGHT);
    expect(ray).not.toBeNull();

    // eyeからtargetへ向かう方向は (0,0,-1)。画面中心のレイもほぼ同じ向きのはず。
    expect(ray!.direction[0]).toBeCloseTo(0, 3);
    expect(ray!.direction[1]).toBeCloseTo(0, 3);
    expect(ray!.direction[2]).toBeCloseTo(-1, 3);
  });

  it("画面端のレイは中心のレイと異なる方向を向く（カーソル位置が反映されている）", () => {
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    const center = screenPointToWorldRay(viewProj, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, CANVAS_WIDTH, CANVAS_HEIGHT);
    const corner = screenPointToWorldRay(viewProj, CANVAS_WIDTH - 1, 1, CANVAS_WIDTH, CANVAS_HEIGHT);
    expect(center).not.toBeNull();
    expect(corner).not.toBeNull();

    const dx = corner!.direction[0] - center!.direction[0];
    const dy = corner!.direction[1] - center!.direction[1];
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0.01);
  });

  it("端にある物にカーソルを合わせたとき、そのAABBに実際に交差する（M1-5の核心）", () => {
    // カメラは原点付近から-z方向を見ている。点群の「端」を模した箱を画面の右寄りに置く。
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    // 画面中心から見て右にずれた位置にある小さな箱（点群の端の建物、のつもり）。
    const edgeBox = { boundsMin: [4, -1, -1] as const, boundsMax: [6, 1, 1] as const };

    // カーソルは画面右寄り（箱に重なる位置）に置く。中心ではないことがポイント。
    const ray = screenPointToWorldRay(viewProj, CANVAS_WIDTH * 0.85, CANVAS_HEIGHT / 2, CANVAS_WIDTH, CANVAS_HEIGHT);
    expect(ray).not.toBeNull();

    const hit = closestHierarchyHit(ray!, [edgeBox]);
    expect(hit).not.toBeNull();

    // 画面中心のレイでは同じ箱に当たらないはず（中心に寄る旧挙動との違いを示す）。
    const centerRay = screenPointToWorldRay(viewProj, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, CANVAS_WIDTH, CANVAS_HEIGHT);
    const centerHit = closestHierarchyHit(centerRay!, [edgeBox]);
    expect(centerHit).toBeNull();
  });
});
