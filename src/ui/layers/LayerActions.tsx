import { Crosshair, Eye, Palette, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isMeasureLayer } from "../../state/layers";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { shouldDeleteLayerOnKey } from "./layer-delete-key";
import { RibbonButton } from "../ribbon/RibbonButton";
import { AppearanceDialog } from "../dialogs/AppearanceDialog";
import { ColorModeDialog } from "../dialogs/ColorModeDialog";

/**
 * L2-A: レイヤー情報の下に置く「選択中のレイヤーへの操作」ボタン列(着色・見た目・削除)。
 * 見た目はリボンと同じ「アイコン+名前」(`RibbonButton`を再利用)。選択中のレイヤーが対象で、
 * レイヤーが無いときは全部グレーで押せない。削除が右クリックしないと見つからない、という
 * 所有者の指摘への答え(常に見えるボタンにする)。右クリック・長押しのメニュー(LayerList)も残す。
 *
 * ダイアログ(着色・見た目)の開閉状態はここが持つ。レイヤーパネルは transform で滑って出入りし、
 * その中に置くと `position: fixed` の基準がパネルになってしまうため、`document.body` へ portal で出す。
 *
 * 「移動」はそのレイヤーへカメラを移す(`viewer.focusLayer`。L2-B)。並びは着色・見た目・移動・削除。
 */
export function LayerActions({ viewer }: { viewer: CopcViewerState }) {
  const [dialog, setDialog] = useState<"color" | "appearance" | null>(null);
  const layer = viewer.selectedLayer;
  const hasLayer = layer !== null;
  // L2-F: a measurement layer has no points, so coloring and appearance do not apply (move and delete do).
  const pointCloudSelected = layer !== null && !isMeasureLayer(layer);
  const { removeLayer, focusLayer } = viewer;
  const selectedId = layer?.id ?? null;

  // Delete キーで選択中のレイヤーを消す。入力欄にフォーカスがあるときは効かない。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (selectedId === null) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!shouldDeleteLayerOnKey({ key: e.key, target, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }, true)) return;
      e.preventDefault();
      removeLayer(selectedId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedId, removeLayer]);

  const close = () => setDialog(null);
  return (
    <>
      <div className="flex flex-nowrap items-center gap-1 pl-[11px]" data-testid="layer-actions">
        <RibbonButton icon={Palette} label="着色" title="選んだレイヤーの色の付け方" disabled={!pointCloudSelected} onClick={() => setDialog("color")} />
        <RibbonButton icon={Eye} label="見た目" title="選んだレイヤーの見た目" disabled={!pointCloudSelected} onClick={() => setDialog("appearance")} />
        <RibbonButton
          icon={Crosshair}
          label="移動"
          title="選んだレイヤーへカメラを移す"
          disabled={!hasLayer}
          onClick={() => selectedId !== null && focusLayer(selectedId)}
        />
        <RibbonButton
          icon={Trash2}
          label="削除"
          title="選んだレイヤーを削除（Delete キー）"
          disabled={!hasLayer}
          onClick={() => selectedId !== null && removeLayer(selectedId)}
        />
      </div>
      {createPortal(
        <>
          <ColorModeDialog viewer={viewer} open={dialog === "color"} onClose={close} />
          <AppearanceDialog viewer={viewer} open={dialog === "appearance"} onClose={close} />
        </>,
        document.body,
      )}
    </>
  );
}
