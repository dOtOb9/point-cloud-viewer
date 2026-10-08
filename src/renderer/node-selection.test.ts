// node-selection.ts のテスト。WebGPUデバイスもReactも要らない純粋関数なので、
// レンダラを一切起動せずに「どのノードが選ばれるか」だけを確認できる。

import { describe, expect, it } from "vitest";
import { frustumPlanes } from "./frustum";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { selectNodesForFrame, type NodeSelectionCache } from "./node-selection";
import { screenSpaceError } from "./screen-space-error";
import type { HierarchyNodeInfo } from "../datasource/DataSource";
import type { CachedNode } from "./node-cache";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

/**
 * 実際のカメラ設定に近いviewProjを組み立てる。原点を見下ろす、ごく普通の透視投影。
 * screenSpaceErrorは実際の投影に依存する値なので、他のテストファイル
 * （screen-space-error.test.ts）のような単純化した行列ではなく、本物の
 * perspective/lookAtを使う。
 */
function testViewProj(): Mat4 {
  const proj = perspective(Math.PI / 3, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
  const view = lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
  return multiply(proj, view);
}

/** 原点付近、カメラの正面(z軸負方向)に置いた小さな立方体ノード。 */
function makeNode(key: string, centerZ: number, pointCount: number, centerX = 0): HierarchyNodeInfo {
  const half = 0.5;
  return {
    key,
    pointCount,
    boundsMin: [centerX - half, -half, centerZ - half],
    boundsMax: [centerX + half, half, centerZ + half],
  };
}

/** テスト用のキャッシュダブル。指定したキーだけ「キャッシュ済み」として振る舞う。 */
function makeCache(cachedKeys: string[]): NodeSelectionCache {
  const dummyNode = (key: string): CachedNode => ({
    key,
    origin: [0, 0, 0],
    pointCount: 0,
    vertexBuffer: {} as GPUBuffer,
    uniformBuffer: {} as GPUBuffer,
    bindGroup: {} as GPUBindGroup,
  });
  return {
    get(key: string): CachedNode | undefined {
      return cachedKeys.includes(key) ? dummyNode(key) : undefined;
    },
  };
}

const EMPTY_CACHE = makeCache([]);

describe("selectNodesForFrame", () => {
  it("視錐台の外のノードは選ばれない", () => {
    const viewProj = testViewProj();
    const planes = frustumPlanes(viewProj);

    // カメラの正面、原点付近のノード(視錐台の中)と、
    // 真横に大きく外れたノード(視錐台の外)を用意する。
    const inside = makeNode("inside", 0, 1000);
    const outside = makeNode("outside", 0, 1000, 100_000);

    const result = selectNodesForFrame(
      [inside, outside],
      planes,
      viewProj,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      1_000_000,
      EMPTY_CACHE,
    );

    const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
    expect(selectedKeys).toContain("inside");
    expect(selectedKeys).not.toContain("outside");
  });

  it("優先度の高い順に、点予算に収まる分だけ選ばれる", () => {
    const viewProj = testViewProj();
    const planes = frustumPlanes(viewProj);

    // カメラ(z=10)に近いノードほど、同じ大きさ・同じ点数でも画面上の見かけが
    // 大きくなり、screenSpaceErrorの優先度が高くなる。
    const near = makeNode("near", 5, 100); // カメラから最も近い = 最優先
    const mid = makeNode("mid", 0, 100);
    const far = makeNode("far", -5, 100); // カメラから最も遠い = 最低優先

    // 予算は1ノード分(100)しか通らない量にする: 最優先のnearだけが選ばれ、
    // mid・farは「足りないので諦める」対象になり toDraw にも wanted にも
    // 現れないはず（node-selection.tsの現在の仕様: 予算超過分は候補から
    // 落ちるだけで、wantedにも積まれない）。
    const result = selectNodesForFrame([far, mid, near], planes, viewProj, CANVAS_WIDTH, CANVAS_HEIGHT, 150, EMPTY_CACHE);

    const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
    expect(selectedKeys).toEqual(["near"]);
  });

  it("キャッシュにあるものはtoDraw、無いものはwantedに入る", () => {
    const viewProj = testViewProj();
    const planes = frustumPlanes(viewProj);

    const cachedNode = makeNode("cached", 0, 100);
    const missingNode = makeNode("missing", 1, 100, 1);

    const cache = makeCache(["cached"]);

    const result = selectNodesForFrame(
      [cachedNode, missingNode],
      planes,
      viewProj,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      1_000_000,
      cache,
    );

    expect(result.toDraw.map((n) => n.key)).toEqual(["cached"]);
    expect(result.wanted.map((n) => n.key)).toEqual(["missing"]);
  });

  // ADR-0010追記: 中央優先度(center-priority.ts)。所有者の要望「画面中央の
  // チャンクを優先して細かく表示しないと使いにくい」への対応。
  describe("中央優先度(centerPriorityStrength)", () => {
    it("強さ0(省略時の既定)は、今までの優先度(画面空間誤差のみ)と完全に一致する", () => {
      const viewProj = testViewProj();
      const planes = frustumPlanes(viewProj);
      const near = makeNode("near", 5, 100);
      const mid = makeNode("mid", 0, 100);
      const far = makeNode("far", -5, 100);

      const omitted = selectNodesForFrame([far, mid, near], planes, viewProj, CANVAS_WIDTH, CANVAS_HEIGHT, 150, EMPTY_CACHE);
      const explicitZero = selectNodesForFrame(
        [far, mid, near],
        planes,
        viewProj,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        150,
        EMPTY_CACHE,
        0,
      );

      expect(explicitZero).toEqual(omitted);
      const selectedKeys = [...explicitZero.toDraw.map((n) => n.key), ...explicitZero.wanted.map((n) => n.key)];
      expect(selectedKeys).toEqual(["near"]);
    });

    it("画面空間誤差が同じ2つのノードでは、画面中央に近い方が優先して選ばれる", () => {
      const viewProj = testViewProj();
      const planes = frustumPlanes(viewProj);

      // testViewProj()のカメラは回転していない素直なlookAt(+z軸上から原点を見る)。
      // ただし奥行き方向(z)に厚みのある箱は、画面の端寄り(x大)に置くと
      // 近い面・遠い面でピクセル/ワールド単位が変わる度合いがxの大きさに応じて
      // 変わる(遠近法の歪み。中心付近ではxが小さいためこの差はほぼ無視できるが、
      // 端ではxが大きいため同じz方向の厚みでも無視できない差になる)。この効果を
      // 避けて「画面空間誤差が厳密に同じ」を作るため、z方向の厚みを無視できるほど
      // 薄い箱(boundsMinとboundsMaxのzをほぼ同じ値)を使う。
      const halfXY = 0.5;
      const thinZ = 1e-6;
      const center: HierarchyNodeInfo = {
        key: "center",
        pointCount: 100,
        boundsMin: [-halfXY, -halfXY, -thinZ],
        boundsMax: [halfXY, halfXY, thinZ],
      };
      const edge: HierarchyNodeInfo = {
        key: "edge",
        pointCount: 100,
        // 視錐台内だが画面の端寄り(z=0平面での可視半幅≈7.7)。
        boundsMin: [7 - halfXY, -halfXY, -thinZ],
        boundsMax: [7 + halfXY, halfXY, thinZ],
      };

      const errorCenter = screenSpaceError(
        viewProj,
        center.boundsMin,
        center.boundsMax,
        center.pointCount,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
      );
      const errorEdge = screenSpaceError(
        viewProj,
        edge.boundsMin,
        edge.boundsMax,
        edge.pointCount,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
      );
      // 前提の確認: 画面空間誤差そのものは同じ(中央優先度を入れる前の優先度に差が無い)。
      expect(errorEdge).toBeCloseTo(errorCenter, 6);

      // 2ノード分の点数(200)は入らないが1ノード分(100)は入る予算にして、
      // 中央優先度が無ければ同点、ある場合はcenterだけが選ばれるようにする。
      const budgetForOne = 150;
      const result = selectNodesForFrame(
        [edge, center],
        planes,
        viewProj,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        budgetForOne,
        EMPTY_CACHE,
        2, // centerPriorityStrength
      );

      const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
      expect(selectedKeys).toEqual(["center"]);
    });

    it("端のノードの画面空間誤差が十分大きければ、重みの下限のおかげで中央の細かいノードより先に選ばれる(飢餓防止)", () => {
      const viewProj = testViewProj();
      const planes = frustumPlanes(viewProj);

      // 中央・細かい(点が密=誤差が小さい)ノード。
      const centerFine: HierarchyNodeInfo = {
        key: "centerFine",
        pointCount: 1000,
        boundsMin: [-0.1, -0.1, -0.1],
        boundsMax: [0.1, 0.1, 0.1],
      };
      // 画面の端寄り・粗い(点が疎=誤差が大きい)ノード。箱も大きいので、
      // centerFineとの誤差の比は非常に大きくなる(下限0.2を掛けても勝てる
      // だけの余裕を持たせるため)。
      const edgeCoarse: HierarchyNodeInfo = {
        key: "edgeCoarse",
        pointCount: 1000,
        boundsMin: [2, -3, -3],
        boundsMax: [8, 3, 3],
      };

      const errorCenterFine = screenSpaceError(
        viewProj,
        centerFine.boundsMin,
        centerFine.boundsMax,
        centerFine.pointCount,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
      );
      const errorEdgeCoarse = screenSpaceError(
        viewProj,
        edgeCoarse.boundsMin,
        edgeCoarse.boundsMax,
        edgeCoarse.pointCount,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
      );
      // 前提の確認: edgeCoarseの画面空間誤差が、重みの下限(0.2)の逆数(5倍)を
      // 大きく超えていること。これが無いと、下限が効いても中央優先度の
      // 重みに負けてしまい、このテストの意図(飢餓防止)が確認できない。
      expect(errorEdgeCoarse).toBeGreaterThan(errorCenterFine * 10);

      // 点数は同じ(1000)なので、両方は入らず片方だけ入る予算にする。
      const budgetForOne = 1500;
      const result = selectNodesForFrame(
        [centerFine, edgeCoarse],
        planes,
        viewProj,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        budgetForOne,
        EMPTY_CACHE,
        1000, // 非常に強いcenterPriorityStrength(端の重みを下限近くまで落とす)
      );

      const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
      expect(selectedKeys).toEqual(["edgeCoarse"]);
    });
  });
});
