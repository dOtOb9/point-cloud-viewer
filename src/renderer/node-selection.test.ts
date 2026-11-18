import { describe, expect, it } from "vitest";
import { frustumPlanes } from "./frustum";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { selectNodesForFrame, type NodeSelectionCache } from "./node-selection";
import { screenSpaceError } from "./screen-space-error";
import type { HierarchyNodeInfo } from "../datasource/DataSource";
import type { CachedNode } from "./node-cache";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

function testViewProj(): Mat4 {
  const proj = perspective(Math.PI / 3, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
  const view = lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
  return multiply(proj, view);
}

function makeNode(key: string, centerZ: number, pointCount: number, centerX = 0): HierarchyNodeInfo {
  const half = 0.5;
  return {
    key,
    pointCount,
    boundsMin: [centerX - half, -half, centerZ - half],
    boundsMax: [centerX + half, half, centerZ + half],
  };
}

function makeCache(cachedKeys: string[]): NodeSelectionCache {
  const dummyNode = (key: string): CachedNode => ({
    key,
    origin: [0, 0, 0],
    pointCount: 0,
    vertexBuffer: {} as GPUBuffer,
    uniformBuffer: {} as GPUBuffer,
    bindGroup: {} as GPUBindGroup,
    firstDrawnAtMs: null,
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

    const near = makeNode("near", 5, 100);
    const mid = makeNode("mid", 0, 100);
    const far = makeNode("far", -5, 100);

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
      expect(errorEdge).toBeCloseTo(errorCenter, 6);

      const budgetForOne = 150;
      const result = selectNodesForFrame(
        [edge, center],
        planes,
        viewProj,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        budgetForOne,
        EMPTY_CACHE,
        2,
      );

      const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
      expect(selectedKeys).toEqual(["center"]);
    });

    it("端のノードの画面空間誤差が十分大きければ、重みの下限のおかげで中央の細かいノードより先に選ばれる(飢餓防止)", () => {
      const viewProj = testViewProj();
      const planes = frustumPlanes(viewProj);

      const centerFine: HierarchyNodeInfo = {
        key: "centerFine",
        pointCount: 1000,
        boundsMin: [-0.1, -0.1, -0.1],
        boundsMax: [0.1, 0.1, 0.1],
      };
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
      expect(errorEdgeCoarse).toBeGreaterThan(errorCenterFine * 10);

      const budgetForOne = 1500;
      const result = selectNodesForFrame(
        [centerFine, edgeCoarse],
        planes,
        viewProj,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        budgetForOne,
        EMPTY_CACHE,
        1000,
      );

      const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
      expect(selectedKeys).toEqual(["edgeCoarse"]);
    });

    describe("重みの下限(minCenterPriorityWeight)", () => {
      const centerFine: HierarchyNodeInfo = {
        key: "centerFine",
        pointCount: 1000,
        boundsMin: [-0.1, -0.1, -0.1],
        boundsMax: [0.1, 0.1, 0.1],
      };
      const edgeCoarse: HierarchyNodeInfo = {
        key: "edgeCoarse",
        pointCount: 1000,
        boundsMin: [2, -3, -3],
        boundsMax: [8, 3, 3],
      };
      const STRENGTH_AT_SLIDER_MAX = 16;
      const budgetForOne = 1500;

      it("下限を省略すると既定値(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT=0.2)が使われ、端の誤差が十分大きいと端が選ばれる", () => {
        const viewProj = testViewProj();
        const planes = frustumPlanes(viewProj);

        const result = selectNodesForFrame(
          [centerFine, edgeCoarse],
          planes,
          viewProj,
          CANVAS_WIDTH,
          CANVAS_HEIGHT,
          budgetForOne,
          EMPTY_CACHE,
          STRENGTH_AT_SLIDER_MAX,
        );

        const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
        expect(selectedKeys).toEqual(["edgeCoarse"]);
      });

      it("下限を0にすると、強さが大きい状況では画面空間誤差の大小が逆転し、端のノードが選ばれなくなることがある(飢餓のリスク)", () => {
        const viewProj = testViewProj();
        const planes = frustumPlanes(viewProj);

        const result = selectNodesForFrame(
          [centerFine, edgeCoarse],
          planes,
          viewProj,
          CANVAS_WIDTH,
          CANVAS_HEIGHT,
          budgetForOne,
          EMPTY_CACHE,
          STRENGTH_AT_SLIDER_MAX,
          0,
        );

        const selectedKeys = [...result.toDraw.map((n) => n.key), ...result.wanted.map((n) => n.key)];
        expect(selectedKeys).toEqual(["centerFine"]);
      });
    });
  });
});
