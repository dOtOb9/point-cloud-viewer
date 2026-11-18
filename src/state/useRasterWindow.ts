import { useRef, useState } from "react";
import type { RasterContext } from "../app/raster-window";
import type { PointCloudToolsContext } from "../app/point-cloud-tools";
import { CLOSED_RASTER_WINDOW, type RasterWindowState } from "./raster-window";
import { getDisplayUnit } from "./useDisplayUnit";

export interface RasterWindow {
  state: RasterWindowState;
  context: RasterContext;
}

export function useRasterWindow(tools: PointCloudToolsContext): RasterWindow {
  const [state, setState] = useState<RasterWindowState>(CLOSED_RASTER_WINDOW);
  const stateRef = useRef(state);
  const context: RasterContext = {
    tools,
    getState: () => stateRef.current,
    setState: (next) => {
      stateRef.current = next;
      setState(next);
    },
    getDisplayUnit,
  };
  return { state, context };
}
