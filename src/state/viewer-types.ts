// The public shape of the viewer state: `CopcViewerState` (what `useCopcViewer()` returns to the UI) and the
// small types it is made of. Types only, no code.
// Used by: src/ui (through the re-exports in useCopcViewer.ts), useLayerTool.ts, useMeasureTool.ts.
// Each field is declared (and documented) once, in the interface of the hook that makes it; F12 on `viewer.xxx` goes there.
// The hooks that fill each group of fields are listed in useCopcViewer.ts.
import type { OpenFilesContext } from "../app/open-files";
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { ViewerStatus } from "./viewer-status";
import type { OpfsUsageBreakdown } from "../datasource/opfs";
import type { BackgroundMode } from "../renderer/sky";
import type { GpuErrorEntry } from "../renderer/gpu-error-log";
import type { ColorMode } from "../renderer/colormap";
import type { PointShape } from "../renderer/device-profile";
import type { ViewerLayer } from "./layers";
import type { DisplaySettings } from "./useDisplaySettings";
import type { ErrorLog } from "./useErrorLog";
import type { Layers } from "./useLayers";
import type { OpfsStorage } from "./useOpfsStorage";
import type { PointCloudTools } from "./usePointCloudTools";
import type { TempDirSetting } from "./useTempDir";

/** Progress of the running point-cloud tool (L2-F). `totalPoints` is 0 until the first progress arrives. */
export interface ToolProgressState {
  title: string;
  pointsRead: number;
  totalPoints: number;
}

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// PointShapeもここから再エクスポートする（M3-8）。
export type { PointShape };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// GpuErrorEntryもここから再エクスポートする。
export type { GpuErrorEntry };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// BackgroundModeもここから再エクスポートする。
export type { BackgroundMode };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// ColorModeもここから再エクスポートする（M2-2）。
export type { ColorMode };

// L1-D: レイヤー1件の型も同じ理由で再エクスポートする。
export type { ViewerLayer };

// UI(src/ui)はdatasourceを直接触らずstate経由にする規約（規約2の裏返し。
// tauri.tsをimportしてよいのはこのファイルだけ）のため、
// ConversionProgressもここから再エクスポートする（M4-3）。
export type { ConversionProgress };

/**
 * M4-6追記: Web版のOPFS使用量(内訳)と永続化の状態をまとめた、設定画面
 * (SettingsModal「ブラウザの保存領域」節)向けの表示用の値。`quotaBytes`/
 * `usageBytes`は`estimateQuota()`、`persisted`は`isPersisted()`、
 * `breakdown`は`getOpfsUsageBreakdown()`の結果をそのまま持つ
 * (`refreshOpfsStorageInfo`がまとめて取得する)。
 */
export interface OpfsStorageInfo {
  quotaBytes: number;
  usageBytes: number;
  persisted: boolean;
  breakdown: OpfsUsageBreakdown;
}

// canvasRef is deliberately not part of CopcViewerState. Mixing a ref (canvasRef) and state in one object makes
// `react-hooks/refs` of eslint-plugin-react-hooks think "a property of this object may be a ref", and it reports
// false positives on reads of the state during render. So the caller gets them as separate values.
//
// The field names and types come from the hooks' own interfaces (Pick). To read or change a field, go to its interface.
// Fields left out on purpose are the hooks' internal ones (`layersStateRef`, `commitLayers`, `reportConversionProgress`, ...).
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
  Pick<PointCloudTools, "toolProgress" | "cancelTool" | "extractFromLayer" | "mergeSelectedLayers"> &
  Pick<
    OpfsStorage,
    | "opfsStorageInfo"
    | "refreshOpfsStorageInfo"
    | "requestOpfsPersistentStorage"
    | "removeOpfsCachedConversion"
    | "clearOpfsCachedConversions"
    | "removeOpfsScratchDir"
    | "clearOpfsScratchDirs"
  > &
  Pick<TempDirSetting, "tempDir" | "supportsCustomTempDir" | "pickAndSetTempDir" | "clearTempDir"> & {
    // Only what useCopcViewer makes itself is declared here.
    /** Open / convert status, including the error message (`viewer-status.ts`). Read it through its helpers. */
    status: ViewerStatus;
    /**
     * What the open functions in src/app/open-files.ts (`openFiles`, `cancelConversion`) are called with.
     * The UI imports those functions and passes this in, so F12 on `openFiles` lands on the implementation.
     */
    fileOpenContext: OpenFilesContext;
    /** Progress of a running conversion, or null (`setConversionProgress` in `OpenFilesContext`, src/app/open-files.ts). */
    conversionProgress: ConversionProgress | null;
    /** Name of the file converted last, for the conversion dialog; null before any conversion. */
    convertingFileName: string | null;
    /** Copy the breakdown text of the selected layer to the clipboard. True if it succeeded (a failure is only logged). */
    copyConversionBreakdownText: () => Promise<boolean>;
    /** True in the browser build. Used by the settings pages and the download link. */
    isBrowser: boolean;
    /** 3D coordinates of a screen point (canvas CSS pixels); null where there is no point. The renderer's `pickPoint`. */
    pickPoint: (cssX: number, cssY: number) => Promise<{ point: [number, number, number]; refined: boolean } | null>;
    /** Latest-frame viewProj and up axis (for overlaying measurement lines). */
    getViewSnapshot: () => { viewProj: number[]; up: readonly [number, number, number] } | null;
  };
