import { useState } from "react";
import { useCopcViewer } from "../../state/useCopcViewer";
import { useTheme } from "../../state/useTheme";
import { useUpdateCheck } from "../../state/useUpdateCheck";
import { useWebGpuSupport } from "../../state/useWebGpuSupport";
import { defaultRenderSettings, readDeviceProfileInput } from "../../renderer/device-profile";
import { ViewerPanel } from "../ViewerPanel";
import { Dock } from "./Dock";
import { GpuErrorBanner } from "./GpuErrorBanner";
import { InfoPanel } from "./InfoPanel";
import { LayerPanel } from "./LayerPanel";
import { SettingsModal } from "./SettingsModal";
import { UnsupportedDeviceScreen } from "./UnsupportedDeviceScreen";
import { UpdateNotice } from "./UpdateNotice";

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
  const update = useUpdateCheck();

  const [layerOpen, setLayerOpen] = useState(true);
  const [infoOpen, setInfoOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // M3-8: ガラス表現(backdrop-blur)のオン/オフ。「点群の3Dビューとは無関係な
  // 純粋なUIの見た目の設定」なので、`useCopcViewer`のCopcViewerStateには
  // 含めず、AppShellが直接持つ(子のLayerPanel/InfoPanel/Dock/UpdateNoticeへ
  // propsで配る。GpuErrorBanner/SettingsModalは意図的にガラスを使わないため
  // 対象外。理由はそれぞれのファイル冒頭のコメント参照)。既定値は
  // `useCopcViewer`内部と同じ`defaultRenderSettings(readDeviceProfileInput())`
  // から決める(同じ純粋関数を呼ぶだけなのでハンドシェイク不要。呼び出しが
  // 2箇所に増えるが、この関数は副作用が無く呼び出しコストも無視できるほど
  // 軽いため、共有のためだけに新しいhook/contextを作るより単純)。
  const [glassEnabled, setGlassEnabled] = useState(() => defaultRenderSettings(readDeviceProfileInput()).glassEnabled);

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

      <LayerPanel viewer={viewer} open={layerOpen} onToggleOpen={() => setLayerOpen((v) => !v)} glassEnabled={glassEnabled} />
      <InfoPanel viewer={viewer} open={infoOpen} onToggleOpen={() => setInfoOpen((v) => !v)} glassEnabled={glassEnabled} />

      <Dock
        layerOpen={layerOpen}
        infoOpen={infoOpen}
        onToggleLayer={() => setLayerOpen((v) => !v)}
        onToggleInfo={() => setInfoOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
        glassEnabled={glassEnabled}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        update={update}
        viewer={viewer}
        glassEnabled={glassEnabled}
        onGlassEnabledChange={setGlassEnabled}
      />

      {/* M3-2/M3-4: 更新通知。新しいバージョンがあるときだけ出る（デスクトップ・Android共通）。 */}
      <UpdateNotice update={update} glassEnabled={glassEnabled} />

      {/* WebGPUのエラーバナー（新設）。z-50で他のすべての面より前面に出す
          （EDL(M2-1)の事故のように画面が真っ黒になっても、devtoolsを開かずに
          原因が読めるようにするため。詳細はGpuErrorBanner.tsx冒頭のコメント）。 */}
      <GpuErrorBanner errors={viewer.gpuErrors} onDismiss={viewer.dismissGpuError} />
    </div>
  );
}
