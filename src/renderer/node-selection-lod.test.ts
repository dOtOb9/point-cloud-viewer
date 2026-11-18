import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "./center-priority";
import { frustumPlanes } from "./frustum";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import {
  MIN_NODE_SPACING_PIXELS,
  parentKey,
  selectNodesForFrame,
  type NodeSelectionCache,
} from "./node-selection";
import { screenSpaceError, surfaceSpacingPixels } from "./screen-space-error";
import type { HierarchyNodeInfo } from "../datasource/DataSource";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

const EMPTY_CACHE: NodeSelectionCache = { get: () => undefined };

function viewProjAt(distance: number): Mat4 {
  const proj = perspective(Math.PI / 3, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 10_000);
  const view = lookAt([0, 0, distance], [0, 0, 0], [0, 1, 0]);
  return multiply(proj, view);
}

function box(key: string, min: number, max: number, pointCount: number): HierarchyNodeInfo {
  return { key, pointCount, boundsMin: [min, min, min], boundsMax: [max, max, max] };
}

const root = box("0-0-0-0", -0.5, 0.5, 1000);
const child = box("1-0-0-0", -0.5, 0, 1000);

function selectedKeys(nodes: HierarchyNodeInfo[], distance: number): string[] {
  const vp = viewProjAt(distance);
  const r = selectNodesForFrame(nodes, frustumPlanes(vp), vp, CANVAS_WIDTH, CANVAS_HEIGHT, 100_000_000, EMPTY_CACHE);
  return r.wanted.map((n) => n.key).sort();
}

describe("selectNodesForFrame: LOD A（画素より細かい階層は読まない）", () => {
  it("parentKey は d-x-y-z の親を返し、ルートや別形式には null を返す", () => {
    expect(parentKey("3-5-6-7")).toBe("2-2-3-3");
    expect(parentKey("1-0-1-0")).toBe("0-0-0-0");
    expect(parentKey("0-0-0-0")).toBeNull();
    expect(parentKey("inside")).toBeNull();
  });

  it("遠い（見下ろし）カメラでは、親が閾値を下回るので子は候補から外れ、ルートだけ残る", () => {
    expect(selectedKeys([root, child], 100)).toEqual(["0-0-0-0"]);
  });

  it("近寄ると親が閾値以上になり、子も候補に入る", () => {
    expect(selectedKeys([root, child], 10)).toEqual(["0-0-0-0", "1-0-0-0"]);
  });

  it("親が閾値以上なら子は外れない。子が閾値を下回れば、孫だけが外れる", () => {
    const denseChild = box("1-0-0-0", -0.5, 0, 1_000_000);
    const grandchild = box("2-0-0-0", -0.5, -0.25, 1000);
    expect(selectedKeys([root, denseChild, grandchild], 10)).toEqual(["0-0-0-0", "1-0-0-0"]);
  });

  it("階層に親が無いときは、さらに上の先祖で判定する（穴を作らない）", () => {
    const grandchild = box("2-0-0-0", -0.5, -0.25, 1000);
    expect(selectedKeys([root, grandchild], 10)).toEqual(["0-0-0-0", "2-0-0-0"]);
    expect(selectedKeys([root, grandchild], 100)).toEqual(["0-0-0-0"]);
  });

  it("閾値は引数で変えられ、既定は MIN_NODE_SPACING_PIXELS", () => {
    expect(MIN_NODE_SPACING_PIXELS).toBe(0.5);
    const vp = viewProjAt(100);
    const r = selectNodesForFrame(
      [root, child],
      frustumPlanes(vp),
      vp,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      1_000_000,
      EMPTY_CACHE,
      0,
      DEFAULT_MIN_CENTER_PRIORITY_WEIGHT,
      0.1,
    );
    expect(r.wanted.map((n) => n.key).sort()).toEqual(["0-0-0-0", "1-0-0-0"]);
  });
});

describe("surfaceSpacingPixels", () => {
  it("立方体ノードでは 辺/√点数 のワールド間隔をピクセルにした値で、cbrt 版（screenSpaceError）より小さい", () => {
    const vp = viewProjAt(10);
    const surface = surfaceSpacingPixels(vp, root.boundsMin, root.boundsMax, 1000, CANVAS_WIDTH, CANVAS_HEIGHT);
    const volume = screenSpaceError(vp, root.boundsMin, root.boundsMax, 1000, CANVAS_WIDTH, CANVAS_HEIGHT);
    expect(surface / volume).toBeCloseTo(10 / Math.sqrt(1000), 6);
  });
});
