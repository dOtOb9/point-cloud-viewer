import type { CopcViewerState } from "../../state/useCopcViewer";
import type { MeasureToolState } from "../../state/useMeasureTool";
import type { LayerToolState } from "../../state/useLayerTool";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "../common/glass";
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
  /** L2-D: state of the measurement tool (used by the measure buttons). */
  measure: MeasureToolState;
  /** L2-F: state of the point selection / cross section tools. */
  layerTool: LayerToolState;
  /** G1: opens the rasterize window. */
  onOpenRaster: () => void;
}

/**
 * ADR-0017 (UI shell rebuild): the toolbar at the top of the screen (one corner of the usual
 * desktop point-cloud/GIS layout: top toolbar + left layer tree + bottom status bar).
 *
 * R3: one flat row with no group headings. This file only lists the buttons in order; each
 * button is its own component under `buttons/` and decides by itself when it is enabled.
 * Separators sit where the old group borders were:
 *   open | distance, height, area, select points, section, merge layers | settings
 * A button is icon on top, label below (`ToolbarButton.tsx`).
 *
 * L2-A (2026-10-14): the "view" group was removed (coloring and appearance moved to the layer
 * list's action buttons, load priority to the settings).
 *
 * L1-A (2026-10-14): always one row regardless of the screen width. If it does not fit, it
 * scrolls horizontally (scrollbar hidden). The mouse drags with the left button held or scrolls
 * with the vertical wheel (`useToolbarDragScroll.ts`); touch uses plain horizontal scrolling.
 * Below 768px (`useNarrowViewport`) it only stretches to the edges and drops the rounded
 * corners. Touch targets are 44px or more (buttons are `min-h-14` = 56px).
 */
export function Toolbar({ viewer, glassEnabled, onOpenSettings, measure, layerTool, onOpenRaster }: Props) {
  const narrow = useNarrowViewport();
  const { ref, onClickCapture } = useToolbarDragScroll();
  // Narrow screens: stretched to the edges, no rounded corners. Wide: floats a little, rounded.
  // The difference is only the position and the corners.
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
      <MeasureButton kind="distance" viewer={viewer} measure={measure} />
      <MeasureButton kind="height" viewer={viewer} measure={measure} />
      <MeasureButton kind="area" viewer={viewer} measure={measure} />
      <SelectPointsButton viewer={viewer} layerTool={layerTool} />
      <SectionButton viewer={viewer} layerTool={layerTool} />
      <MergeLayersButton viewer={viewer} />
      <RasterizeButton viewer={viewer} onOpen={onOpenRaster} />
      <ToolbarSeparator />
      <SettingsButton onOpenSettings={onOpenSettings} />
    </div>
  );
}
