import { useState } from "react";
import { useCopcViewer } from "../../state/useCopcViewer";
import { useTheme } from "../../state/useTheme";
import { useUpdateCheck } from "../../state/useUpdateCheck";
import { useWebGpuSupport } from "../../state/useWebGpuSupport";
import { defaultRenderSettings, readDeviceProfileInput } from "../../renderer/device-profile";
import { ViewerPanel } from "../ViewerPanel";
import { ErrorLogDialog } from "./ErrorLogDialog";
import { GpuErrorBanner } from "./GpuErrorBanner";
import { LayerPanel } from "./LayerPanel";
import { Ribbon } from "./Ribbon";
import { SettingsModal } from "./SettingsModal";
import { StatusBar } from "./StatusBar";
import { UnsupportedDeviceScreen } from "./UnsupportedDeviceScreen";
import { UpdateNotice } from "./UpdateNotice";

/**
 * ADR-0017 (UIシェル再構築): UIシェルの組み立て役。
 *
 * レイアウトを、デスクトップの点群/GIS系ソフトに多い構成
 * 「上部リボン + 左レイヤーツリー + 下部ステータスバー」に変えた
 * (以前は画面下部中央のフローティングドック+左右2枚のパネル。ADR-0005時点の
 * 構成。対応関係の詳細はADR-0017の対応表を参照)。ADR-0005の決定(全面ビューア+
 * 浮かぶガラス面、設定モーダルだけ不透明)自体は変えていない。
 *
 * `useCopcViewer()`をここで一度だけ呼び、canvasRefとviewer状態を各部品へ
 * propsで配る方針もM2-3から変えていない。
 */
export function AppShell() {
  const [canvasRef, viewer] = useCopcViewer();
  const theme = useTheme();
  const webGpuSupport = useWebGpuSupport();
  const update = useUpdateCheck();

  // 狭幅(<768px)ではドロワーが画面を覆うため、最初は閉じて点群が見えるようにする。
  // 広い画面では従来どおり開いておく(E2Eが変換の内訳の表示を待つため、
  // デスクトップ幅では開いていることが必要)。
  const [layerOpen, setLayerOpen] = useState(() => !(typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [errorLogOpen, setErrorLogOpen] = useState(false);

  // M3-8: ガラス表現(backdrop-blur)のオン/オフ。「点群の3Dビューとは無関係な
  // 純粋なUIの見た目の設定」なので、`useCopcViewer`のCopcViewerStateには
  // 含めず、AppShellが直接持つ(子のRibbon/LayerPanel/StatusBar/UpdateNoticeへ
  // propsで配る。GpuErrorBanner/SettingsModal/ErrorLogDialogは意図的にガラスを
  // 使わないため対象外。理由はそれぞれのファイル冒頭のコメント参照)。既定値は
  // `useCopcViewer`内部と同じ`defaultRenderSettings(readDeviceProfileInput())`
  // から決める(同じ純粋関数を呼ぶだけなのでハンドシェイク不要)。
  const [glassEnabled, setGlassEnabled] = useState(() => defaultRenderSettings(readDeviceProfileInput()).glassEnabled);

  // M3-5: WebGPUが確定して「非対応」だった場合はここで打ち切り、専用画面に差し替える。
  if (webGpuSupport.status === "done" && !webGpuSupport.result.supported) {
    return <UnsupportedDeviceScreen reason={webGpuSupport.result.reason} />;
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <ViewerPanel canvasRef={canvasRef} />

      <Ribbon viewer={viewer} glassEnabled={glassEnabled} onOpenSettings={() => setSettingsOpen(true)} />

      <LayerPanel viewer={viewer} open={layerOpen} onToggleOpen={() => setLayerOpen((v) => !v)} glassEnabled={glassEnabled} />

      <StatusBar viewer={viewer} glassEnabled={glassEnabled} onOpenErrorLog={() => setErrorLogOpen(true)} />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        update={update}
        viewer={viewer}
        glassEnabled={glassEnabled}
        onGlassEnabledChange={setGlassEnabled}
      />

      <ErrorLogDialog open={errorLogOpen} onClose={() => setErrorLogOpen(false)} errors={viewer.errorHistory} />

      {/* M3-2/M3-4: 更新通知。新しいバージョンがあるときだけ出る（デスクトップ・Android共通）。 */}
      <UpdateNotice update={update} glassEnabled={glassEnabled} />

      {/* WebGPUのエラーバナー（ADR-0011）。z-50で他のすべての面より前面に出す。 */}
      <GpuErrorBanner errors={viewer.gpuErrors} onDismiss={viewer.dismissGpuError} onOpenErrorLog={() => setErrorLogOpen(true)} />
    </div>
  );
}
