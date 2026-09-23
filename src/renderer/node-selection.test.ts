// node-selection.ts のテスト。WebGPUデバイスもReactも要らない純粋関数なので、
// レンダラを一切起動せずに「どのノードが選ばれるか」だけを確認できる。

import { describe, expect, it } from "vitest";
import { frustumPlanes } from "./frustum";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { selectNodesForFrame, type NodeSelectionCache } from "./node-selection";
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
});
