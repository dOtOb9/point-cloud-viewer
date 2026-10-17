// Display settings: point budget, background, grid, EDL, animation, render scale, point shape,
// center priority. Each setter updates the React state and tells the renderer.
// Also holds `stats` (the renderer's per-interval numbers) because the auto point budget changes
// `pointBudget` inside the renderer and the UI copies it back from the stats.
// Used by: useCopcViewer.ts. `deviceProfileDefaults` is also used by useFileOpen.ts (new layers' point shape).
// Entry: `useDisplaySettings(rendererRef)`.
import { useCallback, useEffect, useState, type RefObject } from "react";
import type { PointCloudRenderer, RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "../renderer/sky";
import { DEFAULT_GRID_ENABLED } from "../renderer/ground-grid";
import { DEFAULT_CENTER_PRIORITY_STRENGTH, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "../renderer/center-priority";
import { defaultRenderSettings, readDeviceProfileInput } from "../renderer/device-profile";
import { applyMotionAttribute, readStoredAnimationEnabled, storeAnimationEnabled } from "./motion-setting";

/** localStorage, or undefined where it does not exist (vitest in node) or access throws. */
export function getLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export interface DisplaySettings {
  /** Defaults decided from the device (mobile or not). Same call as the renderer's constructor makes, so both agree. */
  deviceProfileDefaults: ReturnType<typeof defaultRenderSettings>;
  stats: RenderStats | null;
  /** Pass to `renderer.onStatsUpdate`: stores the stats and copies the renderer-side point budget back. */
  onStats: (stats: RenderStats) => void;
  pointBudget: number;
  /** On/off of the automatic point budget adjustment (ADR-0009). The default matches the renderer's (on). */
  autoPointBudgetEnabled: boolean;
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  /**
   * On/off of EDL (Eye-Dome Lighting). The default matches the renderer's (on). It is not off by default because it
   * lets a cloud without RGB (sofi.copc.laz) show its shape. The strength has no UI; it is fixed by
   * `DEFAULT_EDL_STRENGTH` in `src/renderer/edl.ts`.
   */
  edlEnabled: boolean;
  /** On/off of animation (fade-in, inertia, camera moves). */
  animationEnabled: boolean;
  renderScale: number;
  /**
   * ADR-0010 addendum: how strongly the LOD priority is weighted by the distance from the screen center.
   * 0 means screen-space error only. Default `DEFAULT_CENTER_PRIORITY_STRENGTH` (an unverified initial value).
   * Changeable in the settings, applied to the renderer without a restart.
   */
  centerPriorityStrength: number;
  /**
   * Lower bound (0 to 1) of the center priority weight. Default `DEFAULT_MIN_CENTER_PRIORITY_WEIGHT` (0.2).
   * The closer to 0, the more nodes at the screen edge may be put off (`PointCloudRenderer.setMinCenterPriorityWeight()`).
   */
  minCenterPriorityWeight: number;
  setPointBudget: (budget: number) => void;
  setAutoPointBudgetEnabled: (enabled: boolean) => void;
  setBackgroundMode: (mode: BackgroundMode) => void;
  setGridEnabled: (enabled: boolean) => void;
  setEdlEnabled: (enabled: boolean) => void;
  setAnimationEnabled: (enabled: boolean) => void;
  setRenderScale: (scale: number) => void;
  setCenterPriorityStrength: (strength: number) => void;
  setMinCenterPriorityWeight: (minWeight: number) => void;
}

export function useDisplaySettings(rendererRef: RefObject<PointCloudRenderer | null>): DisplaySettings {
  // M3-8: the renderer's constructor calls the same pure function with the same input, so the initial
  // values agree without a handshake. Passed as an initializer so it is not recomputed on every render.
  const [deviceProfileDefaults] = useState(() => defaultRenderSettings(readDeviceProfileInput()));

  const [stats, setStats] = useState<RenderStats | null>(null);
  const [pointBudget, setPointBudgetState] = useState(deviceProfileDefaults.pointBudgetStart);
  // Same as the renderer's default (PointCloudRenderer: autoPointBudgetEnabled = true).
  const [autoPointBudgetEnabled, setAutoPointBudgetEnabledState] = useState(true);
  const [backgroundMode, setBackgroundModeState] = useState<BackgroundMode>(DEFAULT_BACKGROUND_MODE);
  const [gridEnabled, setGridEnabledState] = useState(DEFAULT_GRID_ENABLED);
  const [edlEnabled, setEdlEnabledState] = useState(deviceProfileDefaults.edlEnabled);
  const [animationEnabled, setAnimationEnabledState] = useState(() => readStoredAnimationEnabled(getLocalStorage()));
  const [renderScale, setRenderScaleState] = useState(deviceProfileDefaults.renderScale);
  const [centerPriorityStrength, setCenterPriorityStrengthState] = useState(DEFAULT_CENTER_PRIORITY_STRENGTH);
  const [minCenterPriorityWeight, setMinCenterPriorityWeightState] = useState(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT);

  const onStats = useCallback((s: RenderStats) => {
    setStats(s);
    // ADR-0009: the auto adjustment changes pointBudget inside the renderer (not through setPointBudget),
    // so the displayed value is synchronized from the stats, as it is after a manual change.
    setPointBudgetState(s.pointBudget);
    setAutoPointBudgetEnabledState(s.autoPointBudgetEnabled);
  }, []);

  const setPointBudget = useCallback(
    (budget: number) => {
      setPointBudgetState(budget);
      // ADR-0009: changing it by hand stops the auto adjustment. The renderer does that itself, but the
      // UI would only notice at the next stats update (up to 500 ms), which looks like a silent switch.
      setAutoPointBudgetEnabledState(false);
      rendererRef.current?.setPointBudget(budget);
    },
    [rendererRef],
  );

  const setAutoPointBudgetEnabled = useCallback(
    (enabled: boolean) => {
      setAutoPointBudgetEnabledState(enabled);
      rendererRef.current?.setAutoPointBudgetEnabled(enabled);
    },
    [rendererRef],
  );

  const setBackgroundMode = useCallback(
    (mode: BackgroundMode) => {
      setBackgroundModeState(mode);
      rendererRef.current?.setBackgroundMode(mode);
    },
    [rendererRef],
  );

  const setGridEnabled = useCallback(
    (enabled: boolean) => {
      setGridEnabledState(enabled);
      rendererRef.current?.setGridEnabled(enabled);
    },
    [rendererRef],
  );

  // The CSS animations of the UI (AN-3) stop with the same setting: <html data-motion="off"> (index.css).
  useEffect(() => {
    applyMotionAttribute(document.documentElement, animationEnabled);
  }, [animationEnabled]);

  const setAnimationEnabled = useCallback(
    (enabled: boolean) => {
      setAnimationEnabledState(enabled);
      rendererRef.current?.setAnimationEnabled(enabled);
      storeAnimationEnabled(getLocalStorage(), enabled);
    },
    [rendererRef],
  );

  const setEdlEnabled = useCallback(
    (enabled: boolean) => {
      setEdlEnabledState(enabled);
      rendererRef.current?.setEdlEnabled(enabled);
    },
    [rendererRef],
  );

  const setRenderScale = useCallback(
    (scale: number) => {
      setRenderScaleState(scale);
      rendererRef.current?.setRenderScale(scale);
    },
    [rendererRef],
  );

  const setCenterPriorityStrength = useCallback(
    (strength: number) => {
      setCenterPriorityStrengthState(strength);
      rendererRef.current?.setCenterPriorityStrength(strength);
    },
    [rendererRef],
  );

  const setMinCenterPriorityWeight = useCallback(
    (minWeight: number) => {
      setMinCenterPriorityWeightState(minWeight);
      rendererRef.current?.setMinCenterPriorityWeight(minWeight);
    },
    [rendererRef],
  );

  return {
    deviceProfileDefaults,
    stats,
    onStats,
    pointBudget,
    autoPointBudgetEnabled,
    backgroundMode,
    gridEnabled,
    edlEnabled,
    animationEnabled,
    renderScale,
    centerPriorityStrength,
    minCenterPriorityWeight,
    setPointBudget,
    setAutoPointBudgetEnabled,
    setBackgroundMode,
    setGridEnabled,
    setEdlEnabled,
    setAnimationEnabled,
    setRenderScale,
    setCenterPriorityStrength,
    setMinCenterPriorityWeight,
  };
}
