import { useState } from "react";
import { useCopcViewer } from "../../state/useCopcViewer";
import { useTheme } from "../../state/useTheme";
import { useWebGpuSupport } from "../../state/useWebGpuSupport";
import { ViewerPanel } from "../ViewerPanel";
import { Dock } from "./Dock";
import { GpuErrorBanner } from "./GpuErrorBanner";
import { InfoPanel } from "./InfoPanel";
import { LayerPanel } from "./LayerPanel";
import { SettingsModal } from "./SettingsModal";
import { UnsupportedDeviceScreen } from "./UnsupportedDeviceScreen";

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
  const webGpuSupport = useWebGpuSupport();

  const [layerOpen, setLayerOpen] = useState(true);
  const [infoOpen, setInfoOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // M3-5: WebGPUが確定して「非対応」だった場合はここで打ち切り、専用画面に差し替える。
  // useCopcViewer()自体は上で呼び終えている(Reactのフックは条件分岐の前で呼ぶ規約)が、
  // 内部のeffectは<canvas>がDOMに無ければ何もしない(canvasRef.currentがnullのまま)ので、
  // 以降<ViewerPanel>を描画しないことで実質的に何も起動させない。
  if (webGpuSupport.status === "done" && !webGpuSupport.result.supported) {
    return <UnsupportedDeviceScreen reason={webGpuSupport.result.reason} />;
  }

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

      {/* WebGPUのエラーバナー（新設）。z-50で他のすべての面より前面に出す
          （EDL(M2-1)の事故のように画面が真っ黒になっても、devtoolsを開かずに
          原因が読めるようにするため。詳細はGpuErrorBanner.tsx冒頭のコメント）。 */}
      <GpuErrorBanner errors={viewer.gpuErrors} onDismiss={viewer.dismissGpuError} />
    </div>
  );
}
