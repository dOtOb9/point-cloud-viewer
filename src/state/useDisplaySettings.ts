import { useCallback, useEffect, useState, type RefObject } from "react";
import type { PointCloudRenderer, RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "../renderer/sky";
import { DEFAULT_GRID_ENABLED } from "../renderer/ground-grid";
import { DEFAULT_CENTER_PRIORITY_STRENGTH, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "../renderer/center-priority";
import { defaultRenderSettings, readDeviceProfileInput } from "../renderer/device-profile";
import { applyMotionAttribute, readStoredAnimationEnabled, storeAnimationEnabled } from "./motion-setting";

export function getLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export interface DisplaySettings {
  deviceProfileDefaults: ReturnType<typeof defaultRenderSettings>;
  stats: RenderStats | null;
  onStats: (stats: RenderStats) => void;
  pointBudget: number;
  autoPointBudgetEnabled: boolean;
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  edlEnabled: boolean;
  animationEnabled: boolean;
  renderScale: number;
  centerPriorityStrength: number;
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
  const [deviceProfileDefaults] = useState(() => defaultRenderSettings(readDeviceProfileInput()));

  const [stats, setStats] = useState<RenderStats | null>(null);
  const [pointBudget, setPointBudgetState] = useState(deviceProfileDefaults.pointBudgetStart);
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
    setPointBudgetState(s.pointBudget);
    setAutoPointBudgetEnabledState(s.autoPointBudgetEnabled);
  }, []);

  const setPointBudget = useCallback(
    (budget: number) => {
      setPointBudgetState(budget);
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
