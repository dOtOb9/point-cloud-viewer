import { useState } from "react";
import { useCopcViewer } from "../../state/useCopcViewer";
import { useTheme } from "../../state/useTheme";
import { ViewerPanel } from "../ViewerPanel";
import { Dock } from "./Dock";
import { InfoPanel } from "./InfoPanel";
import { LayerPanel } from "./LayerPanel";
import { SettingsModal } from "./SettingsModal";

/**
 * M2-3: ADR-0005で決めたUIシェルの組み立て役。
 *
 * `useCopcViewer()`をここで一度だけ呼び、canvasRefとviewer状態を各パネルへ
 * propsで配る(以前はViewerPanelの中で呼んでいたが、パネルを分割するために
 * ここへ引き上げた)。すべてのパネルはViewerPanel(canvas, absolute inset-0)の
 * 上に重ねた絶対配置の層として置く。これがADR-0005の「全面ビューア + 浮かぶガラス面」
 * の実装そのもの。
 */
export function AppShell() {
  const [canvasRef, viewer] = useCopcViewer();
  const theme = useTheme();

  const [layerOpen, setLayerOpen] = useState(true);
  const [infoOpen, setInfoOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <ViewerPanel canvasRef={canvasRef} />

      <LayerPanel viewer={viewer} open={layerOpen} onToggleOpen={() => setLayerOpen((v) => !v)} />
      <InfoPanel viewer={viewer} open={infoOpen} onToggleOpen={() => setInfoOpen((v) => !v)} />

      <Dock
        layerOpen={layerOpen}
        infoOpen={infoOpen}
        onToggleLayer={() => setLayerOpen((v) => !v)}
        onToggleInfo={() => setInfoOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} />
    </div>
  );
}
