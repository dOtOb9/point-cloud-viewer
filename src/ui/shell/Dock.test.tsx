// @vitest-environment jsdom
//
// I-1 (TaskSheets/I1-ui-forge-dock.md 受け入れ基準2・3): Dockをui-forgeの生成物
// (Dock.generated.tsx)に置き換えた前後で、見た目(クラスの集合)と振る舞い
// (ハイライト・クリックで呼ばれるコールバック)が変わらないことを確かめる。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Dock } from "./Dock";
import { glassSurfaceClass } from "./glass";

// @testing-library/react等を使わず`react-dom/client`を直接叩くため、Reactに
// 「ここはactで囲む前提のテスト環境」と明示する(無いと`act()`が実際には警告するだけで
// 効かず、クリック→状態更新の反映がテストから見えないことがある)。
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * I-1より前の`Dock.tsx`の外枠div(1個だけの要素)が実際に持っていたクラス全部。
 * 置き換え後の3要素(Canvas/Panel/HBox)の和集合と比べるための基準値として、
 * ここに固定する(このテスト自体が「前の姿」の記録を兼ねる。git履歴にも残る)。
 */
function previousDockFrameClasses(glassEnabled: boolean): Set<string> {
  const base =
    "pointer-events-auto fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-full p-1.5 text-sm shadow-lg";
  return new Set([...base.split(" "), ...glassSurfaceClass(glassEnabled).split(" ")].filter((c) => c.length > 0));
}

/**
 * 受け入れ基準2は「元のクラスから`fixed`を除き`absolute` `inset-0`
 * `pointer-events-none`を足したもの」と書かれているが、実測すると2点補正が要る
 * (実装記録に詳細を記載。どちらも見た目には影響しない):
 *
 * 1. `fixed`は消えない。ui-forgeの`Canvas`自身が`fixed inset-0`を持つ
 *    (`CANVAS_CLASS`)。`Panel`(旧外枠に対応する要素)は`fixed`から`absolute`に
 *    変わるが、新しく挟まった`Canvas`が`fixed`を引き継ぐため、3要素の和集合
 *    全体としては`fixed`を引くのではなく3つを足すだけで一致する。
 * 2. `items-stretch`が増える。`HBox`の`align`は省略時も既定値`stretch`の
 *    クラスを常に書き出す(ui-forgeの`generate.ts`の`pushEnumClass`)。
 *    横一列flexでの`align-items`の既定値と同じクラスなので見た目は変わらない。
 */
function expectedFrameClasses(glassEnabled: boolean): Set<string> {
  const expected = previousDockFrameClasses(glassEnabled);
  for (const c of ["absolute", "inset-0", "pointer-events-none", "items-stretch"]) expected.add(c);
  return expected;
}

function renderedFrameClasses(glassEnabled: boolean): Set<string> {
  const html = renderToStaticMarkup(
    <Dock
      layerOpen={true}
      infoOpen={true}
      onToggleLayer={() => {}}
      onToggleInfo={() => {}}
      onOpenSettings={() => {}}
      glassEnabled={glassEnabled}
    />,
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  const classes = new Set<string>();
  // Canvasの層(root) / Panel(dock) / HBox(dock_buttons)の3要素。
  // ADR-0014が明記する「外枠が3つの要素に分かれる」の分かれ方そのもの。
  for (const id of ["root", "dock", "dock_buttons"]) {
    const el = doc.querySelector(`[data-ui-id="${id}"]`);
    if (el === null) throw new Error(`data-ui-id="${id}" の要素が見つからない`);
    for (const c of el.className.split(" ")) if (c.length > 0) classes.add(c);
  }
  return classes;
}

describe("Dock (I-1: Dock.ui/ui-forgeの生成物への置き換え)", () => {
  it.each([true, false])("外枠のクラスの和集合が置き換え前と一致する(glassEnabled=%s)", (glassEnabled) => {
    const actual = Array.from(renderedFrameClasses(glassEnabled)).sort();
    const expected = Array.from(expectedFrameClasses(glassEnabled)).sort();
    expect(actual).toEqual(expected);
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("layerOpen=%s / infoOpen=%s でハイライトが切り替わり、クリックで対応するコールバックが呼ばれる", (layerOpen, infoOpen) => {
    const onToggleLayer = vi.fn();
    const onToggleInfo = vi.fn();
    const onOpenSettings = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <Dock
          layerOpen={layerOpen}
          infoOpen={infoOpen}
          onToggleLayer={onToggleLayer}
          onToggleInfo={onToggleInfo}
          onOpenSettings={onOpenSettings}
          glassEnabled={true}
        />,
      );
    });

    const layerButton = container.querySelector('[data-ui-id="layer_button"]');
    const infoButton = container.querySelector('[data-ui-id="info_button"]');
    const settingsButton = container.querySelector('[data-ui-id="settings_button"]');
    if (layerButton === null || infoButton === null || settingsButton === null) {
      throw new Error("ドックのボタンが見つからない");
    }

    // ADR-0005: 開いている側のボタンだけが背景色反転(BUTTON_ACTIVE_CLASS)でハイライトされる。
    const ACTIVE_MARKER = "bg-slate-900";
    expect(layerButton.className.includes(ACTIVE_MARKER)).toBe(layerOpen);
    expect(infoButton.className.includes(ACTIVE_MARKER)).toBe(infoOpen);
    // 設定ボタンは開閉状態を持たず、常に非アクティブの見た目。
    expect(settingsButton.className.includes(ACTIVE_MARKER)).toBe(false);

    act(() => (layerButton as HTMLButtonElement).click());
    act(() => (infoButton as HTMLButtonElement).click());
    act(() => (settingsButton as HTMLButtonElement).click());

    expect(onToggleLayer).toHaveBeenCalledTimes(1);
    expect(onToggleInfo).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
