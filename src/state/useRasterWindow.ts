// Holds the state of the Rasterize window (G1-R3). React only holds it; the steps (open, change a setting, export, close)
// are plain functions in src/app/raster-window.ts, which change the state through the setter of the context built here
// (TaskSheets/ADR-0021-thin-react.md). The shape of the state is in ./raster-window.ts.
import { useRef, useState } from "react";
import type { RasterContext } from "../app/raster-window";
import type { PointCloudToolsContext } from "../app/point-cloud-tools";
import { CLOSED_RASTER_WINDOW, type RasterWindowState } from "./raster-window";
import { getDisplayUnit } from "./useDisplayUnit";

export interface RasterWindow {
  state: RasterWindowState;
  /** Pass this to the functions of src/app/raster-window.ts. */
  context: RasterContext;
}

export function useRasterWindow(tools: PointCloudToolsContext): RasterWindow {
  const [state, setState] = useState<RasterWindowState>(CLOSED_RASTER_WINDOW);
  // The functions read the newest state after an await (to drop a stale answer), so keep it in a ref too.
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
