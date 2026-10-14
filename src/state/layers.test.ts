import { describe, expect, it } from "vitest";
import type { CloudInfo } from "../datasource/DataSource";
import {
  EMPTY_LAYERS,
  addLayerToState,
  findLayer,
  initialColorModeFor,
  removeLayerFromState,
  resolveLayerColorMode,
  selectLayerInState,
  setLayerColorModeInList,
  setLayerVisibleInList,
  type ViewerLayer,
} from "./layers";

function info(hasColor: boolean): CloudInfo {
  return { hasColor } as CloudInfo;
}

function layer(id: string, hasColor = true): ViewerLayer {
  return {
    id,
    name: id,
    info: info(hasColor),
    nodeCount: 1,
    visible: true,
    colorMode: hasColor ? "rgb" : "elevation",
    cloudId: 1,
    conversionBreakdownText: null,
    download: null,
  };
}

describe("addLayerToState", () => {
  it("末尾に足し、足したレイヤーを選択にする", () => {
    const s1 = addLayerToState(EMPTY_LAYERS, layer("a"));
    const s2 = addLayerToState(s1, layer("b"));
    expect(s2.layers.map((l) => l.id)).toEqual(["a", "b"]);
    expect(s2.selectedLayerId).toBe("b");
  });
});

describe("removeLayerFromState", () => {
  const two = addLayerToState(addLayerToState(EMPTY_LAYERS, layer("a")), layer("b"));

  it("選択中を消したら、残りの先頭を選ぶ", () => {
    const r = removeLayerFromState(two, "b");
    expect(r.layers.map((l) => l.id)).toEqual(["a"]);
    expect(r.selectedLayerId).toBe("a");
  });

  it("選択中でないものを消しても選択は変わらない", () => {
    const r = removeLayerFromState(two, "a");
    expect(r.selectedLayerId).toBe("b");
  });

  it("最後の1つを消すと選択は null", () => {
    const r = removeLayerFromState(removeLayerFromState(two, "a"), "b");
    expect(r).toEqual({ layers: [], selectedLayerId: null });
  });

  it("存在しない id は何もしない", () => {
    expect(removeLayerFromState(two, "zzz")).toBe(two);
  });
});

describe("selectLayerInState", () => {
  it("一覧にある id だけ選べる", () => {
    const s = addLayerToState(addLayerToState(EMPTY_LAYERS, layer("a")), layer("b"));
    expect(selectLayerInState(s, "a").selectedLayerId).toBe("a");
    expect(selectLayerInState(s, "zzz")).toBe(s);
  });
});

describe("表示・着色", () => {
  it("setLayerVisibleInList は指定したレイヤーだけ変える", () => {
    const r = setLayerVisibleInList([layer("a"), layer("b")], "a", false);
    expect(r.map((l) => l.visible)).toEqual([false, true]);
  });

  it("RGB が無いレイヤーで rgb を選ぶと標高に落ちる。他のレイヤーは変わらない", () => {
    const list = [layer("a", false), layer("b", true)];
    const r = setLayerColorModeInList(list, "a", "rgb");
    expect(r[0].colorMode).toBe("elevation");
    expect(r[1].colorMode).toBe("rgb");
    expect(resolveLayerColorMode(list, "a", "rgb")).toBe("elevation");
    expect(resolveLayerColorMode(list, "b", "rgb")).toBe("rgb");
    expect(resolveLayerColorMode(list, "zzz", "rgb")).toBeNull();
  });

  it("着色の初期値は RGB があれば rgb、無ければ標高", () => {
    expect(initialColorModeFor(info(true))).toBe("rgb");
    expect(initialColorModeFor(info(false))).toBe("elevation");
  });

  it("findLayer", () => {
    expect(findLayer([layer("a")], "a")?.id).toBe("a");
    expect(findLayer([layer("a")], null)).toBeNull();
    expect(findLayer([layer("a")], "x")).toBeNull();
  });
});
