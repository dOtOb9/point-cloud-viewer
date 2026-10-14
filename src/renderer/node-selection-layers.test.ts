// 複数レイヤー（L1-C）のノード選択とキャッシュのテスト。WebGPUは使わない。
//
// 確かめること:
//  - 1レイヤーのとき、従来の selectNodesForFrame と結果が同じ（キーの前置きを除いて）
//  - 点予算は全レイヤーで1つを分け合う（レイヤーごとに分けない）
//  - 手前のレイヤーのノードが、遠いレイヤーのノードより先に予算を取る（同じ優先度の物差しで比べている）
//  - 選択に渡さなかった（=非表示の）レイヤーのノードは、toDraw にも wanted にも出ない
//  - キーの前置きの組み立てと分解、NodeCache.removeByPrefix（レイヤー削除でGPUバッファを解放する）

import { describe, expect, it } from "vitest";
import type { HierarchyNodeInfo } from "../datasource/DataSource";
import { frustumPlanes } from "./frustum";
import { layerKeyPrefix, layerNodeKey, parseLayerNodeKey } from "./layer-key";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { NodeCache, type CachedNode } from "./node-cache";
import { selectNodesForFrame, selectNodesForLayers, type NodeSelectionCache } from "./node-selection";

const W = 800;
const H = 600;

function viewProj(): Mat4 {
  const proj = perspective(Math.PI / 3, W / H, 0.1, 1000);
  return multiply(proj, lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]));
}

/** 原点付近、カメラの正面に置いた小さな立方体ノード（子なしの1枚）。 */
function node(key: string, centerZ: number, pointCount: number): HierarchyNodeInfo {
  return {
    key,
    pointCount,
    boundsMin: [-0.5, -0.5, centerZ - 0.5],
    boundsMax: [0.5, 0.5, centerZ + 0.5],
  };
}

const EMPTY_CACHE: NodeSelectionCache = { get: () => undefined };

describe("selectNodesForLayers", () => {
  it("1レイヤーのとき、selectNodesForFrame と同じノードが同じ順で選ばれる（キーの前置きを除く）", () => {
    const vp = viewProj();
    const h = [node("0-0-0-0", 0, 1000), node("1-0-0-0", -3, 1000), node("1-1-0-0", 3, 1000)];
    const expected = selectNodesForFrame(h, frustumPlanes(vp), vp, W, H, 2500, EMPTY_CACHE);
    const actual = selectNodesForLayers([{ keyPrefix: "1:", hierarchy: h }], frustumPlanes(vp), vp, W, H, 2500, EMPTY_CACHE);
    expect(actual.wanted.map((w) => w.key)).toEqual(expected.wanted.map((w) => "1:" + w.key));
    expect(actual.wanted.map((w) => w.priority)).toEqual(expected.wanted.map((w) => w.priority));
  });

  it("点予算は全レイヤーで1つを分け合う（レイヤーごとに予算を持たない）", () => {
    const vp = viewProj();
    // 同じ形のレイヤーが2つ。1レイヤーなら3ノードとも入る予算(3000)を、2レイヤーで分け合う。
    const make = (): HierarchyNodeInfo[] => [node("a", 0, 1000), node("b", 1, 1000), node("c", 2, 1000)];
    const single = selectNodesForLayers([{ keyPrefix: "1:", hierarchy: make() }], frustumPlanes(vp), vp, W, H, 3000, EMPTY_CACHE);
    expect(single.wanted).toHaveLength(3);

    const both = selectNodesForLayers(
      [
        { keyPrefix: "1:", hierarchy: make() },
        { keyPrefix: "2:", hierarchy: make() },
      ],
      frustumPlanes(vp),
      vp,
      W,
      H,
      3000,
      EMPTY_CACHE,
    );
    // 合計の点数は予算以内。レイヤーごとに3000ずつ持っていれば6ノードになってしまう。
    expect(both.wanted).toHaveLength(3);
    expect(both.wanted.length * 1000).toBeLessThanOrEqual(3000);
  });

  it("手前のレイヤーのノードが、遠いレイヤーのノードより先に予算を取る", () => {
    const vp = viewProj();
    const near = [node("n", 5, 1000)]; // カメラ(z=10)に近い
    const far = [node("f", -20, 1000)]; // 遠い
    // 予算は1ノード分。レイヤーの並びは遠い方が先でも、画面上で大きい方が選ばれる。
    const r = selectNodesForLayers(
      [
        { keyPrefix: "far:", hierarchy: far },
        { keyPrefix: "near:", hierarchy: near },
      ],
      frustumPlanes(vp),
      vp,
      W,
      H,
      1000,
      EMPTY_CACHE,
    );
    expect(r.wanted.map((w) => w.key)).toEqual(["near:n"]);
  });

  it("選択に渡さない（非表示の）レイヤーのノードは、toDraw にも wanted にも出ない", () => {
    const vp = viewProj();
    const visible = [node("v", 0, 1000)];
    const hidden = [node("h", 0, 1000)];
    // 呼び出し側（renderer）は見えているレイヤーだけを渡す。ここでは hidden を渡さない。
    const cache: NodeSelectionCache = {
      get: (key) => (key === "1:v" ? ({ key } as unknown as CachedNode) : undefined),
    };
    const r = selectNodesForLayers([{ keyPrefix: "1:", hierarchy: visible }], frustumPlanes(vp), vp, W, H, 1e9, cache);
    const keys = [...r.toDraw.map((n) => n.key), ...r.wanted.map((w) => w.key)];
    expect(keys).toEqual(["1:v"]);
    expect(keys.some((k) => hidden.some((h) => k.endsWith(h.key)))).toBe(false);
  });

  it("キャッシュ済みのノードは、レイヤーの前置きを付けたキーで引かれる", () => {
    const vp = viewProj();
    const asked: string[] = [];
    const cache: NodeSelectionCache = {
      get: (key) => {
        asked.push(key);
        return undefined;
      },
    };
    selectNodesForLayers(
      [
        { keyPrefix: "1:", hierarchy: [node("0-0-0-0", 0, 10)] },
        { keyPrefix: "2:", hierarchy: [node("0-0-0-0", 1, 10)] },
      ],
      frustumPlanes(vp),
      vp,
      W,
      H,
      1e9,
      cache,
    );
    expect(asked.sort()).toEqual(["1:0-0-0-0", "2:0-0-0-0"]);
  });
});

describe("layer-key", () => {
  it("組み立てと分解が往復する。同じノードキーでも通し番号が違えば別のキーになる", () => {
    expect(layerKeyPrefix(3)).toBe("3:");
    expect(layerNodeKey(3, "0-0-0-0")).toBe("3:0-0-0-0");
    expect(layerNodeKey(3, "0-0-0-0")).not.toBe(layerNodeKey(4, "0-0-0-0"));
    expect(parseLayerNodeKey("12:3-1-2-0")).toEqual({ serial: 12, nodeKey: "3-1-2-0" });
  });

  it("この形でないキーは null", () => {
    expect(parseLayerNodeKey("0-0-0-0")).toBeNull();
    expect(parseLayerNodeKey("x:0-0-0-0")).toBeNull();
    expect(parseLayerNodeKey(":a")).toBeNull();
  });
});

describe("NodeCache.removeByPrefix", () => {
  function fakeNode(key: string, pointCount: number, destroyed: string[]): CachedNode {
    const buffer = (name: string) => ({ destroy: () => destroyed.push(`${key}/${name}`) }) as unknown as GPUBuffer;
    return {
      key,
      origin: [0, 0, 0],
      pointCount,
      vertexBuffer: buffer("vertex"),
      uniformBuffer: buffer("uniform"),
      bindGroup: {} as GPUBindGroup,
      firstDrawnAtMs: null,
    };
  }

  it("そのレイヤーのノードだけを捨て、GPUバッファを解放する。他のレイヤーは残る", () => {
    const destroyed: string[] = [];
    const cache = new NodeCache(1_000_000);
    cache.set(fakeNode("1:0-0-0-0", 100, destroyed));
    cache.set(fakeNode("1:1-0-0-0", 200, destroyed));
    cache.set(fakeNode("2:0-0-0-0", 300, destroyed));

    cache.removeByPrefix("1:");

    expect(cache.has("1:0-0-0-0")).toBe(false);
    expect(cache.has("1:1-0-0-0")).toBe(false);
    expect(cache.has("2:0-0-0-0")).toBe(true);
    expect(cache.totalCachedPoints()).toBe(300);
    expect(destroyed.sort()).toEqual([
      "1:0-0-0-0/uniform",
      "1:0-0-0-0/vertex",
      "1:1-0-0-0/uniform",
      "1:1-0-0-0/vertex",
    ]);
  });

  it("前置きが「1:」のとき「12:」のノードは巻き込まない", () => {
    const destroyed: string[] = [];
    const cache = new NodeCache(1_000_000);
    cache.set(fakeNode("1:a", 1, destroyed));
    cache.set(fakeNode("12:a", 1, destroyed));
    cache.removeByPrefix("1:");
    expect(cache.has("12:a")).toBe(true);
  });
});
