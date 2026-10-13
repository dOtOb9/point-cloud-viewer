import { Menu, X } from "lucide-react";
import { useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "./glass";
import { RibbonButton } from "./RibbonButton";
import { RibbonFileGroup } from "./RibbonFileGroup";
import { RibbonSettingsGroup } from "./RibbonSettingsGroup";
import { RibbonToolsGroup } from "./RibbonToolsGroup";
import { RibbonViewGroup } from "./RibbonViewGroup";
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
 * 768px未満(`useNarrowViewport`)では、4グループをそのまま並べると幅が足りない
 * ため、コンパクトなバー(「メニュー」ボタン1つ。アイコンの下にラベル)に畳み、
 * 開くと下に全グループを縦に並べたメニューが出る。タッチ領域は44px以上
 * (ボタンは`min-h-14`=56px)。
 */
export function Ribbon({ viewer, glassEnabled, onOpenSettings, onOpenUrlDialog }: Props) {
  const narrow = useNarrowViewport();
  const [menuOpen, setMenuOpen] = useState(false);
  // 表示グループのダイアログ。ガラス(backdrop-filter)の中に置くとfixedの基準がずれるため、
  // リボンの外枠とは兄弟の位置(下のreturn)に描画する。
  const [viewDialog, setViewDialog] = useState<"color" | "appearance" | "priority" | null>(null);
  const closeViewDialog = () => setViewDialog(null);

  const groups = (
    <>
      <RibbonFileGroup viewer={viewer} onOpenUrlDialog={onOpenUrlDialog} />
      <RibbonViewGroup
        onOpenColorMode={() => setViewDialog("color")}
        onOpenAppearance={() => setViewDialog("appearance")}
        onOpenLoadPriority={() => setViewDialog("priority")}
      />
      <RibbonToolsGroup />
      <RibbonSettingsGroup onOpenSettings={onOpenSettings} />
    </>
  );

  const dialogs = (
    <>
      <ColorModeDialog viewer={viewer} open={viewDialog === "color"} onClose={closeViewDialog} />
      <AppearanceDialog viewer={viewer} open={viewDialog === "appearance"} onClose={closeViewDialog} />
      <LoadPriorityDialog viewer={viewer} open={viewDialog === "priority"} onClose={closeViewDialog} />
    </>
  );

  if (narrow) {
    return (
      <>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex max-h-[70vh] flex-col">
          <div
            className={`pointer-events-auto flex items-center justify-between gap-2 border-t-[3px] border-t-primary px-3 py-2 shadow-lg ${glassSurfaceClass(glassEnabled)}`}
          >
            <RibbonButton icon={menuOpen ? X : Menu} label={menuOpen ? "閉じる" : "メニュー"} onClick={() => setMenuOpen((v) => !v)} title={menuOpen ? "メニューを閉じる" : "メニューを開く"} />
            <span className="truncate text-sm font-semibold">点群ビューア</span>
            <div className="w-14 shrink-0" aria-hidden="true" />
          </div>
          {menuOpen && (
            <div className={`pointer-events-auto flex flex-col gap-3 overflow-y-auto p-3 shadow-lg ${glassSurfaceClass(glassEnabled)}`}>{groups}</div>
          )}
        </div>
      {dialogs}
      </>
    );
  }

  return (
    <>
      <div
        className={`pointer-events-auto absolute inset-x-3 top-3 z-20 flex flex-wrap items-stretch gap-3 rounded-2xl border-t-[3px] border-t-primary px-3 py-2 shadow-lg ${glassSurfaceClass(glassEnabled)}`}
      >
        {groups}
      </div>
      {dialogs}
    </>
  );
}
