import { useState } from "react";
import { useCopcViewer } from "../../state/useCopcViewer";
import { useTheme } from "../../state/useTheme";
import { useFileDrop } from "../../state/useFileDrop";
import { useUpdateCheck } from "../../state/useUpdateCheck";
import { useWebGpuSupport } from "../../state/useWebGpuSupport";
import { defaultRenderSettings, readDeviceProfileInput } from "../../renderer/device-profile";
import { ViewerPanel } from "../ViewerPanel";
import { ConversionDialog } from "./ConversionDialog";
import { ErrorDialog } from "./ErrorDialog";
import { LayerPanel } from "./LayerPanel";
import { Ribbon } from "./Ribbon";
import { SettingsModal } from "./SettingsModal";
import { StatusBar } from "./StatusBar";
import { UnsupportedDeviceScreen } from "./UnsupportedDeviceScreen";
import { UpdateNotice } from "./UpdateNotice";
import { UrlDialog } from "./UrlDialog";

/**
 * ADR-0017 (UIシェル再構築): UIシェルの組み立て役。
 *
 * レイアウトは「上部リボン + 左レイヤーツリー + 下部ステータスバー」。
 * 設定・変換の進捗・エラーは、共通の`Dialog`に載せた中央ダイアログで出す。
 * ADR-0005の決定(全面ビューア+浮かぶガラス面、設定は不透明)は変えていない
 * (ダイアログは3つとも不透明)。
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
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  // ファイルのドラッグ&ドロップで開く(ADR-0017)。ドラッグ中は案内を重ねて出す。
  const dragging = useFileDrop(viewer.isBrowser, viewer.openFiles);
  const [conversionDialogOpen, setConversionDialogOpen] = useState(false);
  // エラーダイアログ: null=閉じている / "current"=いま出ているエラー / "history"=全履歴。
  const [errorDialogMode, setErrorDialogMode] = useState<"current" | "history" | null>(null);

  // 「変換が始まった」「新しいエラーが出た」を検出して、対応するダイアログを自動で開く。
  // useEffectでsetStateする代わりに、前回の値をstateに持って描画中に比較する
  // (Reactが推奨する「propsの変化に応じてstateを調整する」書き方。lintの
  // react-hooks/set-state-in-effectも避けられる)。
  const [prev, setPrev] = useState({ status: viewer.status, errorCount: viewer.gpuErrors.length, error: viewer.error });
  if (prev.status !== viewer.status || prev.errorCount !== viewer.gpuErrors.length || prev.error !== viewer.error) {
    setPrev({ status: viewer.status, errorCount: viewer.gpuErrors.length, error: viewer.error });
    if (viewer.status === "converting" && prev.status !== "converting") setConversionDialogOpen(true);
    if (viewer.gpuErrors.length > prev.errorCount || (viewer.error !== null && viewer.error !== prev.error)) {
      setErrorDialogMode("current");
    }
  }

  // ガラス表現(backdrop-blur)は固定(ADR-0017: 所有者の決定でユーザー設定は廃止)。
  // ただしモバイル端末では`device-profile.ts`の端末プロファイル(M3-8: GPU負荷の
  // 軽減)が自動でぼかしを切り、不透明のtintにする。これは性能プロファイルであって
  // ユーザーが切り替える設定ではない。子のRibbon/LayerPanel/StatusBar/UpdateNoticeへ
  // propsで配る(ダイアログ類は意図的にガラスを使わない)。
  const [glassEnabled] = useState(() => defaultRenderSettings(readDeviceProfileInput()).glassEnabled);

  // M3-5: WebGPUが確定して「非対応」だった場合はここで打ち切り、専用画面に差し替える。
  if (webGpuSupport.status === "done" && !webGpuSupport.result.supported) {
    return <UnsupportedDeviceScreen reason={webGpuSupport.result.reason} />;
  }

  // 変換ダイアログを出す条件: 変換中、または変換が終わって結果を出している間。
  // 失敗・キャンセル(status="error"/"idle")のときは出さない(エラーダイアログが出る)。
  const conversionFinished = viewer.conversionBreakdownText !== null && viewer.status !== "error" && viewer.status !== "idle";
  const conversionDialogVisible = conversionDialogOpen && (viewer.status === "converting" || conversionFinished);

  const closeErrorDialog = () => {
    // 「現在のエラー」を閉じるときは、それらを一覧から消す(履歴には残る)。
    if (errorDialogMode === "current") {
      for (const e of viewer.gpuErrors) viewer.dismissGpuError(e.id);
    }
    setErrorDialogMode(null);
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <ViewerPanel canvasRef={canvasRef} />

      <Ribbon
        viewer={viewer}
        glassEnabled={glassEnabled}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenUrlDialog={() => setUrlDialogOpen(true)}
      />

      <LayerPanel viewer={viewer} open={layerOpen} onToggleOpen={() => setLayerOpen((v) => !v)} glassEnabled={glassEnabled} />

      <StatusBar
        viewer={viewer}
        glassEnabled={glassEnabled}
        onOpenErrorLog={() => setErrorDialogMode("history")}
        onOpenConversion={() => setConversionDialogOpen(true)}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        update={update}
        viewer={viewer}
      />

      <UrlDialog open={urlDialogOpen} onClose={() => setUrlDialogOpen(false)} onSubmit={(url) => void viewer.openFile(url)} />

      {dragging && (
        // ファイルをドラッグしている間だけ出す案内(操作は受けない。ドロップはuseFileDrop.tsが受ける)。
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/40">
          <p className="rounded-2xl bg-white px-6 py-4 text-lg font-semibold text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
            ここにドロップして開く
          </p>
        </div>
      )}

      <ConversionDialog viewer={viewer} open={conversionDialogVisible} onClose={() => setConversionDialogOpen(false)} />

      {/* M3-2/M3-4: 更新通知。新しいバージョンがあるときだけ出る（デスクトップ・Android共通）。 */}
      <UpdateNotice update={update} glassEnabled={glassEnabled} />

      {/* エラーダイアログ(ADR-0011のバナーの後継)。最前面(z-50)。 */}
      <ErrorDialog
        open={errorDialogMode !== null}
        mode={errorDialogMode ?? "current"}
        onClose={closeErrorDialog}
        onShowHistory={() => setErrorDialogMode("history")}
        current={viewer.gpuErrors}
        history={viewer.errorHistory}
        viewerError={viewer.error}
      />
    </div>
  );
}
