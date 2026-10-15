import type { CopcViewerState } from "../../state/useCopcViewer";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "../common/glass";
import { RibbonFileGroup } from "./RibbonFileGroup";
import { RibbonSettingsGroup } from "./RibbonSettingsGroup";
import { RibbonToolsGroup } from "./RibbonToolsGroup";
import type { MeasureToolState } from "../../state/useMeasureTool";
import type { LayerToolState } from "../../state/useLayerTool";
import { toolSourceLayers } from "../../state/layer-selection";
import { isMeasureLayer } from "../../state/layers";
import { useRibbonDragScroll } from "./useRibbonDragScroll";

interface Props {
  viewer: CopcViewerState;
  glassEnabled: boolean;
  onOpenSettings: () => void;
  /** L2-D: state of the measurement tool (used by the buttons of the tools group). */
  measure: MeasureToolState;
  /** L2-F: state of the point selection / cross section tools. */
  layerTool: LayerToolState;
}

/**
 * ADR-0017 (UIシェル再構築): 画面上部の「リボン」。デスクトップの点群/GIS系
 * ソフトに多い構成(上部リボン+左レイヤーツリー+下部ステータスバー)の一角。
 *
 * 「ファイル/ツール/設定」の3グループを横に並べる。各グループの中身は
 * `RibbonFileGroup`/`RibbonToolsGroup`/`RibbonSettingsGroup`
 * にそれぞれ分けてある(1ファイル1関心事)。ボタンはアイコンが上・ラベルが下
 * (`RibbonButton.tsx`)。
 *
 * L2-A (2026-10-14): 「表示」グループは撤去（着色・見た目はレイヤー欄の操作ボタンへ、読み込み優先は設定へ）。
 *
 * L1-A (2026-10-14): 画面幅によらず常に1列。幅が足りなければ横スクロールする
 * (スクロールバーは隠す)。マウスは左ボタンで押したまま横に引く／ホイールの縦回転で動かせ
 * (`useRibbonDragScroll.ts`)、タッチは素の横スクロール。以前の「768px未満は
 * 『メニュー』ボタンで縦に開く」形はやめた。768px未満(`useNarrowViewport`)では
 * 端まで広げて角丸をやめるだけ。タッチ領域は44px以上(ボタンは`min-h-14`=56px)。
 */
export function Ribbon({ viewer, glassEnabled, onOpenSettings, measure, layerTool }: Props) {
  const narrow = useNarrowViewport();
  const { ref, onClickCapture } = useRibbonDragScroll();
  // 狭い画面は端まで広げて角丸なし、広い画面は少し浮かせて角丸。違いは位置と角丸だけ。
  const placement = narrow ? "inset-x-0 top-0" : "inset-x-3 top-3 rounded-2xl";

  return (
    <>
      <div
        ref={ref}
        onClickCapture={onClickCapture}
        data-testid="ribbon"
        className={`pointer-events-auto absolute ${placement} z-20 flex flex-nowrap items-stretch gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain border-t-[3px] border-t-primary px-3 py-2 shadow-lg select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${glassSurfaceClass(glassEnabled)}`}
      >
        <RibbonFileGroup viewer={viewer} />
        <RibbonToolsGroup
          measure={measure}
          layerTool={layerTool}
          hasPointCloud={viewer.layers.some((l) => !isMeasureLayer(l))}
          selectedPointCloudCount={toolSourceLayers(viewer.layers, viewer.selectedLayerIds).length}
          onMerge={() => void viewer.mergeSelectedLayers()}
          toolRunning={viewer.toolProgress !== null}
        />
        <RibbonSettingsGroup onOpenSettings={onOpenSettings} />
      </div>
    </>
  );
}
