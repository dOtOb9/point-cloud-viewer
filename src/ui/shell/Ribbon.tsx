import { useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "./glass";
import { RibbonFileGroup } from "./RibbonFileGroup";
import { RibbonSettingsGroup } from "./RibbonSettingsGroup";
import { RibbonToolsGroup } from "./RibbonToolsGroup";
import { RibbonViewGroup } from "./RibbonViewGroup";
import { useRibbonDragScroll } from "./useRibbonDragScroll";
import { AppearanceDialog, ColorModeDialog, LoadPriorityDialog } from "./ViewDialogs";

interface Props {
  viewer: CopcViewerState;
  glassEnabled: boolean;
  onOpenSettings: () => void;
  onOpenUrlDialog: () => void;
}

/**
 * ADR-0017 (UIシェル再構築): 画面上部の「リボン」。デスクトップの点群/GIS系
 * ソフトに多い構成(上部リボン+左レイヤーツリー+下部ステータスバー)の一角。
 *
 * 「ファイル/表示/ツール/設定」の4グループを横に並べる。各グループの中身は
 * `RibbonFileGroup`/`RibbonViewGroup`/`RibbonToolsGroup`/`RibbonSettingsGroup`
 * にそれぞれ分けてある(1ファイル1関心事)。ボタンはアイコンが上・ラベルが下
 * (`RibbonButton.tsx`)。
 *
 * L1-A (2026-10-14): 画面幅によらず常に1列。幅が足りなければ横スクロールする
 * (スクロールバーは隠す)。マウスは左ボタンで押したまま横に引く／ホイールの縦回転で動かせ
 * (`useRibbonDragScroll.ts`)、タッチは素の横スクロール。以前の「768px未満は
 * 『メニュー』ボタンで縦に開く」形はやめた。768px未満(`useNarrowViewport`)では
 * 端まで広げて角丸をやめるだけ。タッチ領域は44px以上(ボタンは`min-h-14`=56px)。
 */
export function Ribbon({ viewer, glassEnabled, onOpenSettings, onOpenUrlDialog }: Props) {
  const narrow = useNarrowViewport();
  const { ref, onClickCapture } = useRibbonDragScroll();
  // 表示グループのダイアログ。ガラス(backdrop-filter)の中に置くとfixedの基準がずれるため、
  // リボンの外枠とは兄弟の位置(下のreturn)に描画する。
  const [viewDialog, setViewDialog] = useState<"color" | "appearance" | "priority" | null>(null);
  const closeViewDialog = () => setViewDialog(null);

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
        <RibbonFileGroup viewer={viewer} onOpenUrlDialog={onOpenUrlDialog} />
        <RibbonViewGroup
          onOpenColorMode={() => setViewDialog("color")}
          onOpenAppearance={() => setViewDialog("appearance")}
          onOpenLoadPriority={() => setViewDialog("priority")}
        />
        <RibbonToolsGroup />
        <RibbonSettingsGroup onOpenSettings={onOpenSettings} />
      </div>
      <ColorModeDialog viewer={viewer} open={viewDialog === "color"} onClose={closeViewDialog} />
      <AppearanceDialog viewer={viewer} open={viewDialog === "appearance"} onClose={closeViewDialog} />
      <LoadPriorityDialog viewer={viewer} open={viewDialog === "priority"} onClose={closeViewDialog} />
    </>
  );
}
