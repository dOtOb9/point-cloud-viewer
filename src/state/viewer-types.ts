import type { OpenFilesContext } from "../app/open-files";
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { ViewerStatus } from "./viewer-status";
import type { DisplaySettings } from "./useDisplaySettings";
import type { ErrorLog } from "./useErrorLog";
import type { Layers } from "./useLayers";
import type { OpfsStorage } from "./useOpfsStorage";
import type { PointCloudTools } from "./usePointCloudTools";
import type { SectionViewHook } from "./useSectionView";
import type { TempDirSetting } from "./useTempDir";

export type CopcViewerState = Pick<
  Layers,
  | "layers"
  | "selectedLayerId"
  | "selectedLayer"
  | "selectedLayerIds"
  | "selectLayer"
  | "toggleLayerSelection"
  | "selectLayerRange"
  | "setLayerVisible"
  | "setLayerColorMode"
  | "setLayerPointShape"
  | "setLayerPointSize"
  | "focusLayer"
  | "removeLayer"
  | "addMeasurement"
> &
  Pick<
    DisplaySettings,
    | "pointBudget"
    | "autoPointBudgetEnabled"
    | "stats"
    | "backgroundMode"
    | "gridEnabled"
    | "edlEnabled"
    | "animationEnabled"
    | "renderScale"
    | "centerPriorityStrength"
    | "minCenterPriorityWeight"
    | "setPointBudget"
    | "setAutoPointBudgetEnabled"
    | "setBackgroundMode"
    | "setGridEnabled"
    | "setEdlEnabled"
    | "setAnimationEnabled"
    | "setRenderScale"
    | "setCenterPriorityStrength"
    | "setMinCenterPriorityWeight"
  > &
  Pick<ErrorLog, "gpuErrors" | "errorHistory" | "reportError" | "dismissGpuError"> &
  Pick<PointCloudTools, "toolProgress" | "toolContext"> &
  Pick<SectionViewHook, "sectionView" | "sectionContext"> &
  Pick<
    OpfsStorage,
    | "opfsStorageInfo"
    | "refreshOpfsStorageInfo"
    | "requestOpfsPersistentStorage"
    | "removeOpfsCachedConversion"
    | "clearOpfsCachedConversions"
    | "scratchCleanupContext"
  > &
  Pick<TempDirSetting, "tempDir" | "supportsCustomTempDir" | "pickAndSetTempDir" | "clearTempDir"> & {
    status: ViewerStatus;
    fileOpenContext: OpenFilesContext;
    conversionProgress: ConversionProgress | null;
    convertingFileName: string | null;
    copyConversionBreakdownText: () => Promise<boolean>;
    isBrowser: boolean;
    pickPoint: (cssX: number, cssY: number) => Promise<{ point: [number, number, number]; refined: boolean } | null>;
    getViewSnapshot: () => { viewProj: number[]; up: readonly [number, number, number] } | null;
  };
