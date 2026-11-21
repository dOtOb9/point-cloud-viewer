import type { CopcViewerState } from "../../state/useCopcViewer";
import type { MeasureToolState } from "../../state/useMeasureTool";
import type { LayerToolState } from "../../state/useLayerTool";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import type { PluginHostCore } from "../../core/plugin-host";
import { glassSurfaceClass } from "../common/glass";
import { PluginRibbonItems } from "../plugins/PluginRibbonItems";
import { FilterButton } from "./buttons/FilterButton";
import { ThinButton } from "./buttons/ThinButton";
import { DtmButton } from "./buttons/DtmButton";
import { MeasureButton } from "./buttons/MeasureButton";
import { MergeLayersButton } from "./buttons/MergeLayersButton";
import { OpenFileButton } from "./buttons/OpenFileButton";
import { RasterizeButton } from "./buttons/RasterizeButton";
import { SectionButton } from "./buttons/SectionButton";
import { SelectPointsButton } from "./buttons/SelectPointsButton";
import { SettingsButton } from "./buttons/SettingsButton";
import { ToolbarSeparator } from "./ToolbarSeparator";
import { useToolbarDragScroll } from "./useToolbarDragScroll";

interface Props {
  viewer: CopcViewerState;
  glassEnabled: boolean;
  onOpenSettings: () => void;
  measure: MeasureToolState;
  layerTool: LayerToolState;
  onOpenRaster: () => void;
  onOpenThin: () => void;
  onOpenFilter: () => void;
  onOpenDtm: () => void;
  pluginHost: PluginHostCore;
}

export function Toolbar({ viewer, glassEnabled, onOpenSettings, measure, layerTool, onOpenRaster, onOpenThin, onOpenFilter, onOpenDtm, pluginHost }: Props) {
  const narrow = useNarrowViewport();
  const { ref, onClickCapture } = useToolbarDragScroll();
  const placement = narrow ? "inset-x-0 top-0" : "inset-x-3 top-3 rounded-2xl";

  return (
    <div
      ref={ref}
      onClickCapture={onClickCapture}
      data-testid="ribbon"
      className={`pointer-events-auto absolute ${placement} z-20 flex flex-nowrap items-stretch gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain border-t-[3px] border-t-primary px-3 py-2 shadow-lg select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${glassSurfaceClass(glassEnabled)}`}
    >
      <OpenFileButton viewer={viewer} />
      <ToolbarSeparator />
      <PluginRibbonItems host={pluginHost} group="view" />
      <ToolbarSeparator />
      <MeasureButton kind="distance" viewer={viewer} measure={measure} />
      <MeasureButton kind="height" viewer={viewer} measure={measure} />
      <MeasureButton kind="area" viewer={viewer} measure={measure} />
      <SelectPointsButton viewer={viewer} layerTool={layerTool} />
      <SectionButton viewer={viewer} layerTool={layerTool} />
      <MergeLayersButton viewer={viewer} />
      <RasterizeButton viewer={viewer} onOpen={onOpenRaster} />
      <ThinButton viewer={viewer} onOpen={onOpenThin} />
      <FilterButton viewer={viewer} onOpen={onOpenFilter} />
      <DtmButton viewer={viewer} onOpen={onOpenDtm} />
      <ToolbarSeparator />
      <SettingsButton onOpenSettings={onOpenSettings} />
    </div>
  );
}
