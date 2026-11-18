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
import { ThinDialog } from "../tools/ThinDialog";
import { FilterDialog } from "../tools/FilterDialog";
import { DtmDialog } from "../tools/DtmDialog";
import { ViewDialog } from "../tools/ViewDialog";
import { useViewShortcuts } from "../toolbar/useViewShortcuts";
import { viewContext } from "../../app/view";
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

function layerPanelStartsOpenExceptOnANarrowScreenWhereTheDrawerWouldCoverThePoints(): boolean {
  return !(typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches);
}

export function AppShell() {
  const [canvasRef, viewer] = useCopcViewer();
  const theme = useTheme();
  const webGpuSupport = useWebGpuSupport();
  const update = useUpdateCheck();
  const measureRaw = useMeasureTool(viewer, canvasRef);
  const layerToolRaw = useLayerTool(viewer, canvasRef);
  const measure = { ...measureRaw, toggle: (kind: Parameters<typeof measureRaw.toggle>[0]) => { layerToolRaw.stop(); measureRaw.toggle(kind); } };
  const layerTool = { ...layerToolRaw, toggle: (mode: Parameters<typeof layerToolRaw.toggle>[0]) => { measureRaw.stop(); layerToolRaw.toggle(mode); } };

  const [layerOpen, setLayerOpen] = useState(layerPanelStartsOpenExceptOnANarrowScreenWhereTheDrawerWouldCoverThePoints);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [thinFilterDialog, setThinFilterDialog] = useState<"thin" | "filter" | null>(null);
  const [dtmDialogOpen, setDtmDialogOpen] = useState(false);
  useViewShortcuts(viewContext, viewer.layers);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const raster = useRasterWindow(viewer.toolContext);
  const dragging = useFileDrop((items) => openFiles(viewer.fileOpenContext, items));
  const [conversionDialogOpen, setConversionDialogOpen] = useState(false);
  const [toolDialogOpen, setToolDialogOpen] = useState(true);
  const toolRunning = viewer.toolProgress !== null;
  const [prevToolRunning, setPrevToolRunning] = useState(toolRunning);
  if (prevToolRunning !== toolRunning) {
    setPrevToolRunning(toolRunning);
    if (toolRunning) setToolDialogOpen(true);
  }
  const [errorDialogMode, setErrorDialogMode] = useState<"current" | "history" | null>(null);

  const viewerError = viewer.status.kind === "error" ? viewer.status.message : null;
  const [prev, setPrev] = useState({ statusKind: viewer.status.kind, errorCount: viewer.gpuErrors.length, error: viewerError });
  if (prev.statusKind !== viewer.status.kind || prev.errorCount !== viewer.gpuErrors.length || prev.error !== viewerError) {
    setPrev({ statusKind: viewer.status.kind, errorCount: viewer.gpuErrors.length, error: viewerError });
    if (viewer.status.kind === "converting" && prev.statusKind !== "converting") setConversionDialogOpen(true);
    if (viewer.gpuErrors.length > prev.errorCount || (viewerError !== null && viewerError !== prev.error)) {
      setErrorDialogMode("current");
    }
  }

  const [glassEnabled] = useState(() => defaultRenderSettings(readDeviceProfileInput()).glassEnabled);

  if (webGpuSupport.status === "done" && !webGpuSupport.result.supported) {
    return <UnsupportedDeviceScreen reason={webGpuSupport.result.reason} />;
  }

  const openRunningOrDone = viewer.status.kind !== "error" && viewer.status.kind !== "idle";
  const conversionFinished = viewer.selectedLayer?.conversionBreakdownText != null && openRunningOrDone;
  const conversionDialogVisible = conversionDialogOpen && (viewer.status.kind === "converting" || conversionFinished);

  const closeErrorDialog = () => {
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
        onOpenView={() => setViewDialogOpen(true)}
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
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/40">
          <p className={`rounded-2xl ${glassSurfaceClass(glassEnabled)} px-6 py-4 text-lg font-semibold shadow-2xl`}>
            ここにドロップして開く
          </p>
        </div>
      )}

      <SectionDialog viewer={viewer} tool={layerTool} />
      <SectionPanel viewer={viewer} glassEnabled={glassEnabled} />
      <RasterWindow viewer={viewer} holder={raster} />
      {thinFilterDialog === "thin" && <ThinDialog viewer={viewer} onClose={() => setThinFilterDialog(null)} />}
      {thinFilterDialog === "filter" && <FilterDialog viewer={viewer} onClose={() => setThinFilterDialog(null)} />}
      {dtmDialogOpen && <DtmDialog viewer={viewer} onClose={() => setDtmDialogOpen(false)} />}
      {viewDialogOpen && <ViewDialog viewer={viewer} onClose={() => setViewDialogOpen(false)} />}
      <ToolProgressDialog viewer={viewer} open={toolDialogOpen} onCollapse={() => setToolDialogOpen(false)} />

      <ConversionDialog viewer={viewer} open={conversionDialogVisible} onClose={() => setConversionDialogOpen(false)} />

      <UpdateNotice update={update} glassEnabled={glassEnabled} />

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
