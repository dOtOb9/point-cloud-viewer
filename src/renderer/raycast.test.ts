import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective } from "./mat4";
import { closestHierarchyHit, intersectRayAabb, ndcPointToWorldRay, screenPointToWorldRay, type Ray } from "./raycast";

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
    expect(t).toBeCloseTo(4, 6);
  });

  it("箱を外れるレイはnullを返す", () => {
    const ray: Ray = { origin: [10, 10, -5], direction: [0, 0, 1] };
    expect(intersectRayAabb(ray, ...box)).toBeNull();
  });

  it("箱の後ろ向きに進むレイ（箱がレイの後ろ側）はnullを返す", () => {
    const ray: Ray = { origin: [0, 0, -5], direction: [0, 0, -1] };
    expect(intersectRayAabb(ray, ...box)).toBeNull();
  });

  it("レイの原点が箱の内側にあるときはnullを返す（バグ1の回帰）", () => {
    const ray: Ray = { origin: [0, 0, 0], direction: [1, 0, 0] };
    expect(intersectRayAabb(ray, ...box)).toBeNull();
  });

  it("交点がレイ原点のごく近く（MIN_HIT_DISTANCE以下）にしかない場合もnullを返す", () => {
    const ray: Ray = { origin: [-1.001, 0, 0], direction: [1, 0, 0] };
    expect(intersectRayAabb(ray, ...box)).toBeNull();
  });

  it("軸に平行なレイでも、スラブの範囲内なら交差する", () => {
    const ray: Ray = { origin: [0, 0, -5], direction: [0, 0, 1] };
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

    const hit = closestHierarchyHit(ray, [far, near]);
    expect(hit).not.toBeNull();
    expect(hit![2]).toBeCloseTo(-1, 6);
  });

  it("バグ2の回帰: 入れ子のAABBを両方渡すと、粗い外側の箱が常に勝つ（正しい表面まで届かない）", () => {
    const ray: Ray = { origin: [-10, 0, 0], direction: [1, 0, 0] };
    const coarseRegion = { boundsMin: [0, -10, -10] as const, boundsMax: [100, 10, 10] as const };
    const fineLeaf = { boundsMin: [5, -1, -1] as const, boundsMax: [7, 1, 1] as const };

    const hitWithBothLevels = closestHierarchyHit(ray, [coarseRegion, fineLeaf]);
    expect(hitWithBothLevels).not.toBeNull();
    expect(hitWithBothLevels![0]).toBeCloseTo(0, 6);

    const hitWithDrawnOnly = closestHierarchyHit(ray, [fineLeaf]);
    expect(hitWithDrawnOnly).not.toBeNull();
    expect(hitWithDrawnOnly![0]).toBeCloseTo(5, 6);
  });

  it("どのノードとも交差しなければnullを返す（空を指しているケース）", () => {
    const ray: Ray = { origin: [0, 0, -20], direction: [0, 1, 0] };
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
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    const edgeBox = { boundsMin: [4, -1, -1] as const, boundsMax: [6, 1, 1] as const };

    const ray = screenPointToWorldRay(viewProj, CANVAS_WIDTH * 0.85, CANVAS_HEIGHT / 2, CANVAS_WIDTH, CANVAS_HEIGHT);
    expect(ray).not.toBeNull();

    const hit = closestHierarchyHit(ray!, [edgeBox]);
    expect(hit).not.toBeNull();

    const centerRay = screenPointToWorldRay(viewProj, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, CANVAS_WIDTH, CANVAS_HEIGHT);
    const centerHit = closestHierarchyHit(centerRay!, [edgeBox]);
    expect(centerHit).toBeNull();
  });
});

describe("ndcPointToWorldRay", () => {
  it("screenPointToWorldRayと同じ結果になる（画面中心のNDCは(0,0)）", () => {
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    const viaScreen = screenPointToWorldRay(viewProj, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, CANVAS_WIDTH, CANVAS_HEIGHT);
    const viaNdc = ndcPointToWorldRay(viewProj, 0, 0);
    expect(viaScreen).not.toBeNull();
    expect(viaNdc).not.toBeNull();
    expect(viaNdc!.direction[0]).toBeCloseTo(viaScreen!.direction[0], 9);
    expect(viaNdc!.direction[1]).toBeCloseTo(viaScreen!.direction[1], 9);
    expect(viaNdc!.direction[2]).toBeCloseTo(viaScreen!.direction[2], 9);
  });

  it("[-1, 1]の外側のNDC座標も扱える（全画面三角形の頂点。sky.ts/ground-grid.tsが使う）", () => {
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    for (const [nx, ny] of [
      [-1, -1],
      [3, -1],
      [-1, 3],
    ] as const) {
      const ray = ndcPointToWorldRay(viewProj, nx, ny);
      expect(ray).not.toBeNull();
      expect(Number.isFinite(ray!.direction[0])).toBe(true);
      expect(Number.isFinite(ray!.direction[1])).toBe(true);
      expect(Number.isFinite(ray!.direction[2])).toBe(true);
    }
  });

  it("回帰: autzen規模の大きな座標 + NEAR/FARの広いレンジでもNaNにならない（実機不具合の再現と修正の担保）", () => {
    const target: [number, number, number] = [637290.8, 851209.9, 510.7];
    const eye: [number, number, number] = [637290.8, 855031.2, 1692.8];
    const up: [number, number, number] = [0, 0, 1];
    const view = lookAt(eye, target, up);
    const proj = perspective(Math.PI / 3, 1600 / 900, 0.01, 1e7);
    const viewProj = multiply(proj, view);

    for (const [nx, ny] of [
      [0, 1],
      [0, 0],
      [0, -1],
      [-1, 1],
    ] as const) {
      const ray = ndcPointToWorldRay(viewProj, nx, ny);
      expect(ray).not.toBeNull();
      expect(Number.isFinite(ray!.direction[0])).toBe(true);
      expect(Number.isFinite(ray!.direction[1])).toBe(true);
      expect(Number.isFinite(ray!.direction[2])).toBe(true);
      const len = Math.hypot(...ray!.direction);
      expect(len).toBeCloseTo(1, 6);
    }
  });
});
