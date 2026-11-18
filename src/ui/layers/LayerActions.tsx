import { Crosshair, Eye, Palette, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isMeasureLayer } from "../../state/layers";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { shouldDeleteLayerOnKey } from "./layer-delete-key";
import { ToolbarButton } from "../toolbar/ToolbarButton";
import { AppearanceDialog } from "../dialogs/AppearanceDialog";
import { ColorModeDialog } from "../dialogs/ColorModeDialog";

export function LayerActions({ viewer }: { viewer: CopcViewerState }) {
  const [dialog, setDialog] = useState<"color" | "appearance" | null>(null);
  const layer = viewer.selectedLayer;
  const hasLayer = layer !== null;
  const pointCloudSelected = layer !== null && !isMeasureLayer(layer);
  const { removeLayer, focusLayer } = viewer;
  const selectedId = layer?.id ?? null;

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
        <ToolbarButton icon={Palette} label="着色" title="選んだレイヤーの色の付け方" disabled={!pointCloudSelected} onClick={() => setDialog("color")} />
        <ToolbarButton icon={Eye} label="見た目" title="選んだレイヤーの見た目" disabled={!pointCloudSelected} onClick={() => setDialog("appearance")} />
        <ToolbarButton
          icon={Crosshair}
          label="移動"
          title="選んだレイヤーへカメラを移す"
          disabled={!hasLayer}
          onClick={() => selectedId !== null && focusLayer(selectedId)}
        />
        <ToolbarButton
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
