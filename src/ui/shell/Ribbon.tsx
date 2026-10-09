import { useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "./glass";
import { RibbonFileGroup } from "./RibbonFileGroup";
import { RibbonSettingsGroup } from "./RibbonSettingsGroup";
import { RibbonToolsGroup } from "./RibbonToolsGroup";
import { RibbonViewGroup } from "./RibbonViewGroup";

interface Props {
  viewer: CopcViewerState;
  glassEnabled: boolean;
  onOpenSettings: () => void;
}

/**
 * ADR-0017 (UIシェル再構築): 画面上部の「リボン」。デスクトップの点群/GIS系
 * ソフトに多い構成(上部リボン+左レイヤーツリー+下部ステータスバー)の一角。
 *
 * 「ファイル/表示/ツール/設定」の4グループを横に並べる。各グループの中身は
 * `RibbonFileGroup`/`RibbonViewGroup`/`RibbonToolsGroup`/`RibbonSettingsGroup`
 * にそれぞれ分けてある(1ファイル1関心事。タスクシートの指示)。
 *
 * 768px未満(`useNarrowViewport`)では、4グループをそのまま並べると幅が足りない
 * ため、コンパクトなバー(ハンバーガーボタン1つ)に畳み、タップすると下に
 * 全グループを縦に並べたメニューが開く(タスクシートの要求: 「ribbon
 * collapses to a compact toolbar or menu」)。タッチ領域は44px以上
 * (各ボタン/入力は`ribbon-styles.ts`の`min-h-11`(=44px)で統一している)。
 */
export function Ribbon({ viewer, glassEnabled, onOpenSettings }: Props) {
  const narrow = useNarrowViewport();
  const [menuOpen, setMenuOpen] = useState(false);

  const groups = (
    <>
      <RibbonFileGroup viewer={viewer} />
      <RibbonViewGroup viewer={viewer} />
      <RibbonToolsGroup />
      <RibbonSettingsGroup onOpenSettings={onOpenSettings} />
    </>
  );

  if (narrow) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col">
        <div
          className={`pointer-events-auto flex items-center justify-between gap-2 px-3 py-2 shadow-lg ${glassSurfaceClass(glassEnabled)}`}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "メニューを閉じる" : "メニューを開く"}
            aria-expanded={menuOpen}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-lg"
          >
            {menuOpen ? "✕" : "☰"}
          </button>
          <span className="truncate text-sm font-semibold">点群ビューア</span>
          <div className="w-11 shrink-0" aria-hidden="true" />
        </div>
        {menuOpen && (
          <div className={`pointer-events-auto flex flex-col gap-3 p-3 shadow-lg ${glassSurfaceClass(glassEnabled)}`}>{groups}</div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`pointer-events-auto absolute inset-x-3 top-3 z-20 flex flex-wrap items-stretch gap-3 rounded-2xl px-3 py-2 shadow-lg ${glassSurfaceClass(glassEnabled)}`}
    >
      {groups}
    </div>
  );
}
