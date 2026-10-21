import { useState } from "react";
import { openFiles } from "../../app/open-files";
import { useCopcViewer } from "../../state/useCopcViewer";
import { useTheme } from "../../state/useTheme";
import { useFileDrop } from "../../state/useFileDrop";
import { useUpdateCheck } from "../../state/useUpdateCheck";
import { useWebGpuSupport } from "../../state/useWebGpuSupport";
import { defaultRenderSettings, readDeviceProfileInput } from "../../renderer/device-profile";
import { useMeasureTool } from "../../state/useMeasureTool";
import { useLayerTool } from "../../state/useLayerTool";
import { MeasureHud } from "../tools/MeasureHud";
import { MeasureOverlay } from "../tools/MeasureOverlay";
import { SectionLineOverlay } from "../section/SectionLineOverlay";
import { LayerToolOverlay } from "../tools/LayerToolOverlay";
import { SectionDialog } from "../tools/SectionDialog";
import { SectionPanel } from "../section/SectionPanel";
import { RasterWindow } from "../tools/RasterWindow";
import { ThinDialog } from "../tools/ThinDialog"; // G3
import { FilterDialog } from "../tools/FilterDialog"; // G3
import { DtmDialog } from "../tools/DtmDialog"; // G1-T15
import { openRasterWindow } from "../../app/raster-window";
import { useRasterWindow } from "../../state/useRasterWindow";
import { selectedPointCloudLayer } from "../toolbar/toolbar-state";
import { ToolProgressDialog } from "../tools/ToolProgressDialog";
import { ViewerPanel } from "./ViewerPanel";
import { ConversionDialog } from "../dialogs/ConversionDialog";
import { ErrorDialog } from "../dialogs/ErrorDialog";
import { glassSurfaceClass } from "../common/glass";
import { LayerPanel } from "../layers/LayerPanel";
import { Toolbar } from "../toolbar/Toolbar";
import { SettingsModal } from "../settings/SettingsModal";
import { StatusBar } from "../status/StatusBar";
import { UnsupportedDeviceScreen } from "./UnsupportedDeviceScreen";
import { UpdateNotice } from "../status/UpdateNotice";

/**
 * ADR-0017 (UIシェル再構築): UIシェルの組み立て役。
 *
 * レイアウトは「上部ツールバー + 左レイヤーツリー + 下部ステータスバー」。
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
  const measureRaw = useMeasureTool(viewer, canvasRef);
  const layerToolRaw = useLayerTool(viewer, canvasRef);
  // Only one tool that clicks on the 3D view can be on at a time (measurement, point selection, cross section):
  // starting one stops the others.
  const measure = { ...measureRaw, toggle: (kind: Parameters<typeof measureRaw.toggle>[0]) => { layerToolRaw.stop(); measureRaw.toggle(kind); } };
  const layerTool = { ...layerToolRaw, toggle: (mode: Parameters<typeof layerToolRaw.toggle>[0]) => { measureRaw.stop(); layerToolRaw.toggle(mode); } };

  // 狭幅(<768px)ではドロワーが画面を覆うため、最初は閉じて点群が見えるようにする。
  // 広い画面では従来どおり開いておく(E2Eが変換の内訳の表示を待つため、
  // デスクトップ幅では開いていることが必要)。
  const [layerOpen, setLayerOpen] = useState(() => !(typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches));
  const [settingsOpen, setSettingsOpen] = useState(false);
  // G3: which of the thinning / filter dialogs is open.
  const [thinFilterDialog, setThinFilterDialog] = useState<"thin" | "filter" | null>(null);
  // G1-T15: whether the DTM dialog is open.
  const [dtmDialogOpen, setDtmDialogOpen] = useState(false);
  // G1: the Rasterize window (state in the hook, steps in src/app/raster-window.ts).
  const raster = useRasterWindow(viewer.toolContext);
  // ファイルのドラッグ&ドロップで開く(ADR-0017)。ドラッグ中は案内を重ねて出す。
  const dragging = useFileDrop((items) => openFiles(viewer.fileOpenContext, items));
  const [conversionDialogOpen, setConversionDialogOpen] = useState(false);
  // The tool progress dialog: collapsed by an outside click / Esc (the tool keeps running), reopened from the status bar.
  // A new tool run opens it again (detected by comparing with the previous render, like the conversion dialog below).
  const [toolDialogOpen, setToolDialogOpen] = useState(true);
  const toolRunning = viewer.toolProgress !== null;
  const [prevToolRunning, setPrevToolRunning] = useState(toolRunning);
  if (prevToolRunning !== toolRunning) {
    setPrevToolRunning(toolRunning);
    if (toolRunning) setToolDialogOpen(true);
  }
  // エラーダイアログ: null=閉じている / "current"=いま出ているエラー / "history"=全履歴。
  const [errorDialogMode, setErrorDialogMode] = useState<"current" | "history" | null>(null);

  // 「変換が始まった」「新しいエラーが出た」を検出して、対応するダイアログを自動で開く。
  // useEffectでsetStateする代わりに、前回の値をstateに持って描画中に比較する
  // (Reactが推奨する「propsの変化に応じてstateを調整する」書き方。lintの
  // react-hooks/set-state-in-effectも避けられる)。
  const viewerError = viewer.status.kind === "error" ? viewer.status.message : null;
  const [prev, setPrev] = useState({ statusKind: viewer.status.kind, errorCount: viewer.gpuErrors.length, error: viewerError });
  if (prev.statusKind !== viewer.status.kind || prev.errorCount !== viewer.gpuErrors.length || prev.error !== viewerError) {
    setPrev({ statusKind: viewer.status.kind, errorCount: viewer.gpuErrors.length, error: viewerError });
    if (viewer.status.kind === "converting" && prev.statusKind !== "converting") setConversionDialogOpen(true);
    if (viewer.gpuErrors.length > prev.errorCount || (viewerError !== null && viewerError !== prev.error)) {
      setErrorDialogMode("current");
    }
  }

  // ガラス表現(backdrop-blur)は固定(ADR-0017: 所有者の決定でユーザー設定は廃止)。
  // ただしモバイル端末では`device-profile.ts`の端末プロファイル(M3-8: GPU負荷の
  // 軽減)が自動でぼかしを切り、不透明のtintにする。これは性能プロファイルであって
  // ユーザーが切り替える設定ではない。子のToolbar/LayerPanel/StatusBar/UpdateNoticeへ
  // propsで配る(ダイアログ類は意図的にガラスを使わない)。
  const [glassEnabled] = useState(() => defaultRenderSettings(readDeviceProfileInput()).glassEnabled);

  // M3-5: WebGPUが確定して「非対応」だった場合はここで打ち切り、専用画面に差し替える。
  if (webGpuSupport.status === "done" && !webGpuSupport.result.supported) {
    return <UnsupportedDeviceScreen reason={webGpuSupport.result.reason} />;
  }

  // 変換ダイアログを出す条件: 変換中、または変換が終わって結果を出している間。
  // 失敗・キャンセル(status.kind が "error"/"idle")のときは出さない(エラーダイアログが出る)。
  // A failure or a cancel leaves the status "error" / "idle"; any other kind means the open is running or done.
  const openRunningOrDone = viewer.status.kind !== "error" && viewer.status.kind !== "idle";
  const conversionFinished = viewer.selectedLayer?.conversionBreakdownText != null && openRunningOrDone;
  const conversionDialogVisible = conversionDialogOpen && (viewer.status.kind === "converting" || conversionFinished);

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
      <MeasureOverlay viewer={viewer} measure={measure} canvasRef={canvasRef} />
      <SectionLineOverlay viewer={viewer} canvasRef={canvasRef} />
      <MeasureHud measure={measure} glassEnabled={glassEnabled} />
      <LayerToolOverlay viewer={viewer} tool={layerTool} canvasRef={canvasRef} glassEnabled={glassEnabled} />

      <Toolbar
        viewer={viewer}
        glassEnabled={glassEnabled}
        onOpenSettings={() => setSettingsOpen(true)}
        measure={measure}
        layerTool={layerTool}
        onOpenRaster={() => {
          const layer = selectedPointCloudLayer(viewer);
          if (layer) void openRasterWindow(raster.context, layer.id);
        }}
        onOpenThin={() => setThinFilterDialog("thin")}
        onOpenFilter={() => setThinFilterDialog("filter")}
        onOpenDtm={() => setDtmDialogOpen(true)}
      />

      <LayerPanel viewer={viewer} open={layerOpen} onToggleOpen={() => setLayerOpen((v) => !v)} glassEnabled={glassEnabled} />

      <StatusBar
        viewer={viewer}
        glassEnabled={glassEnabled}
        onOpenErrorLog={() => setErrorDialogMode("history")}
        onOpenConversion={() => setConversionDialogOpen(true)}
        toolDialogCollapsed={!toolDialogOpen}
        onOpenToolProgress={() => setToolDialogOpen(true)}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        update={update}
        viewer={viewer}
      />

      {dragging && (
        // ファイルをドラッグしている間だけ出す案内(操作は受けない。ドロップはuseFileDrop.tsが受ける)。
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/40">
          <p className={`rounded-2xl ${glassSurfaceClass(glassEnabled)} px-6 py-4 text-lg font-semibold shadow-2xl`}>
            ここにドロップして開く
          </p>
        </div>
      )}

      {/* L2-F: cross-section thickness / height range, and the progress of a running point-cloud tool. */}
      <SectionDialog viewer={viewer} tool={layerTool} />
      {/* G2: the 2D cross-section panel, opened when a cross section has been made. */}
      <SectionPanel viewer={viewer} glassEnabled={glassEnabled} />
      {/* G1: the Rasterize window (opened from the toolbar button). */}
      <RasterWindow viewer={viewer} holder={raster} />
      {/* G3: the thinning / filter dialogs (mounted only while open, so the fields start from the presets). */}
      {thinFilterDialog === "thin" && <ThinDialog viewer={viewer} onClose={() => setThinFilterDialog(null)} />}
      {thinFilterDialog === "filter" && <FilterDialog viewer={viewer} onClose={() => setThinFilterDialog(null)} />}
      {/* G1-T15: the DTM dialog. */}
      {dtmDialogOpen && <DtmDialog viewer={viewer} onClose={() => setDtmDialogOpen(false)} />}
      <ToolProgressDialog viewer={viewer} open={toolDialogOpen} onCollapse={() => setToolDialogOpen(false)} />

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
        viewerError={viewerError}
      />
    </div>
  );
}
