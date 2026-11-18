import type { HierarchyNodeInfo } from "../datasource/DataSource";
import { computeIntensityRange, type ParsedNode } from "../datasource/node-format";
import { StaleNodeRequestError } from "../datasource/stale-node-error";
import { attachOrbitControls, OrbitCamera } from "./orbit-camera";
import { flyToGoal, pickFlyToPoint } from "./fly-to";
import { cameraBasis, multiply, type Mat4 } from "./mat4";
import {
  buildProjection,
  DEFAULT_PROJECTION_MODE,
  eyeDistanceFromDepth,
  fitDistance,
  orthoCursorZoomDirection,
  refinedProjection,
  type Projection,
  type ProjectionMode,
} from "./projection";
import { matchViewPreset, viewPresetAngles, type ViewPresetId } from "./view-presets";
import { frustumPlanes } from "./frustum";
import {
  CACHE_BUDGET_MULTIPLIER,
  evaluatePointBudget,
  updateRefreshIntervalEstimate,
  DEFAULT_POINT_BUDGET_TUNING,
  type RefreshIntervalEstimate,
} from "./point-budget";
import {
  cameraPoseChanged,
  INITIAL_IDLE_BOOST_STATE,
  stepIdleBoost,
  type CameraPose,
  type IdleBoostState,
} from "./idle-boost";
import { screenPointToWorldRay } from "./raycast";
import {
  COARSE_HALF,
  REFINE_HALF,
  nearestHit,
  unprojectWindowSample,
  windowViewProj,
} from "./pick-math";
import { NodeCache, type CachedNode } from "./node-cache";
import { NodeLoader } from "./node-loader";
import { layerKeyPrefix, parseLayerNodeKey } from "./layer-key";
import { formatNodeLoadErrorMessage } from "./node-load-error";
import { selectNodesForLayers, type SelectionLayer } from "./node-selection";
import { DEFAULT_CENTER_PRIORITY_STRENGTH, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "./center-priority";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "./sky";
import { DEFAULT_GRID_ENABLED, gridFadeDistance, niceGridCellSize } from "./ground-grid";
import { DEFAULT_EDL_RADIUS_PX, DEFAULT_EDL_STRENGTH } from "./edl";
import { GpuResources, type DrawFrameOptions, type NodePointStyle } from "./gpu-resources";
import { DEFAULT_POINT_SIZE_PX, focusGoalFor, type FocusGoal, layerFocusBounds, sanitizePointSize } from "./layer-focus";
import { extendRange, type ColorMode, type ValueRange } from "./colormap";
import {
  computeSceneBounds,
  elevationRangeFromCloudBounds,
  mergeSceneBounds,
  type SceneBounds,
} from "./scene-bounds";
import { defaultRenderSettings, readDeviceProfileInput, type PointShape } from "./device-profile";
import { computeCanvasBackingSize } from "./render-scale";
import { prefersReducedMotion, resolveMotionEnabled } from "./animation";

const AUTO_POINT_BUDGET_MIN = 200_000;

const AUTO_POINT_BUDGET_FRAME_HISTORY = 20;
const FALLBACK_REFRESH_INTERVAL_MS = 1000 / 60;
const STATS_INTERVAL_MS = 500;
const AUTO_POINT_BUDGET_INTERVAL_MS = STATS_INTERVAL_MS;

export interface RenderStats {
  drawnPoints: number;
  drawnNodes: number;
  loadingNodes: number;
  queuedNodes: number;
  cachedNodes: number;
  fps: number;
  pointBudget: number;
  autoPointBudgetEnabled: boolean;
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  cameraPitch: number;
  cameraYaw: number;
  cameraUpAxis: [number, number, number];
  cameraEye: [number, number, number];
  viewPreset: ViewPresetId | null;
  cameraAnimating: boolean;
  idleBoosting: boolean;
  edlEnabled: boolean;
  edlStrength: number;
  layerCount: number;
  visibleLayerCount: number;
  renderScale: number;
  pointShape: PointShape;
  isMobile: boolean;
  pointBudgetMax: number;
  centerPriorityStrength: number;
  minCenterPriorityWeight: number;
}

export interface LayerInput {
  hierarchy: HierarchyNodeInfo[];
  readNode: (key: string) => Promise<ArrayBuffer>;
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
  colorMode: ColorMode;
  visible: boolean;
  pointShape?: PointShape;
  pointSizePx?: number;
}

interface Layer {
  id: string;
  serial: number;
  keyPrefix: string;
  hierarchy: HierarchyNodeInfo[];
  hierarchyByKey: Map<string, HierarchyNodeInfo>;
  readNode: (key: string) => Promise<ArrayBuffer>;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  sceneBounds: SceneBounds | null;
  elevationRange: ValueRange;
  intensityRange: ValueRange | null;
  colorMode: ColorMode;
  visible: boolean;
  style: NodePointStyle;
  colorBuffer: GPUBuffer | null;
}

export class PointCloudRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: OrbitCamera;
  private detachControls: () => void = () => {};

  private readonly gpu: GpuResources;

  private readonly layers = new Map<string, Layer>();
  private readonly layersBySerial = new Map<number, Layer>();
  private nextLayerSerial = 1;
  private focusedLayerId: string | null = null;
  private cache: NodeCache;
  private loader: NodeLoader | null = null;
  private lastViewProj: Mat4 | null = null;
  private lastDrawn: CachedNode[] = [];

  private pointBudget: number;
  private autoPointBudgetEnabled = true;
  private readonly autoPointBudgetMax: number;
  private recentFrameDeltasMs: number[] = [];
  private previousFrameTime: number | null = null;
  private lastAutoBudgetAdjustAt = 0;
  private autoPointBudgetConsecutiveHits = 0;
  private refreshIntervalEstimate: RefreshIntervalEstimate | null = null;
  private idleBoost: IdleBoostState = INITIAL_IDLE_BOOST_STATE;
  private previousCameraPose: CameraPose | null = null;
  private rafHandle = 0;
  private disposed = false;
  private previousCameraTime: number | null = null;

  private animationEnabled = true;

  private onStats: ((stats: RenderStats) => void) | null = null;
  private lastStatsEmitAt = 0;
  private frameTimestamps: number[] = [];

  private onGpuError: ((message: string) => void) | null = null;

  private onNodeLoadError: ((message: string) => void) | null = null;

  private backgroundMode: BackgroundMode = DEFAULT_BACKGROUND_MODE;

  private projectionMode: ProjectionMode = DEFAULT_PROJECTION_MODE;
  private lastProjection: Projection | null = null;

  private gridEnabled = DEFAULT_GRID_ENABLED;
  private gridCellSize = 1;
  private gridFadeDistance = 100;
  private gridGroundHeight = 0;

  private edlEnabled: boolean;
  private readonly edlStrength = DEFAULT_EDL_STRENGTH;
  private readonly edlRadiusPx = DEFAULT_EDL_RADIUS_PX;

  private centerPriorityStrength = DEFAULT_CENTER_PRIORITY_STRENGTH;
  private minCenterPriorityWeight = DEFAULT_MIN_CENTER_PRIORITY_WEIGHT;

  private renderScale: number;
  private readonly pointShape: PointShape;
  private readonly isMobileProfile: boolean;
  private lastDisplayWidthCss = 1;
  private lastDisplayHeightCss = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new OrbitCamera([0, 0, 0], 100);

    const deviceProfile = defaultRenderSettings(readDeviceProfileInput());
    this.isMobileProfile = deviceProfile.isMobile;
    this.renderScale = deviceProfile.renderScale;
    this.pointShape = deviceProfile.pointShape;
    this.edlEnabled = deviceProfile.edlEnabled;
    this.autoPointBudgetMax = deviceProfile.pointBudgetMax;
    this.pointBudget = deviceProfile.pointBudgetStart;

    this.cache = new NodeCache(this.pointBudget * CACHE_BUDGET_MULTIPLIER);
    this.loader = new NodeLoader(
      { readNode: (key) => this.readLayerNode(key) },
      (key, node) => this.handleNodeLoaded(key, node),
      (key, error) => this.reportNodeLoadError(key, error),
    );
    this.gpu = new GpuResources(
      (message) => this.reportGpuError(message),
      () => this.handleDeviceRecovered(),
    );
  }

  async init(): Promise<void> {
    await this.gpu.init(this.canvas);

    this.resize(this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height);
    this.detachControls = attachOrbitControls(this.canvas, this.camera, {
      getCursorDirection: (screenX, screenY) => this.getCursorDirection(screenX, screenY),
      onFlyTo: (screenX, screenY) => this.flyToScreenPoint(screenX, screenY),
    });
  }

  private getCursorDirection(screenX: number, screenY: number): [number, number, number] | null {
    if (!this.lastViewProj) return null;
    const ray = screenPointToWorldRay(this.lastViewProj, screenX, screenY, this.canvas.width, this.canvas.height);
    if (!ray) return null;
    const projection = this.lastProjection;
    if (projection?.mode !== "orthographic") return ray.direction;
    const ndcX = (screenX / this.canvas.width) * 2 - 1;
    const ndcY = 1 - (screenY / this.canvas.height) * 2;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const { right, up } = cameraBasis(this.camera.eye(), this.camera.target, this.camera.getUpAxis());
    return orthoCursorZoomDirection(right, up, ndcX, ndcY, aspect, projection.halfHeight, this.camera.distance);
  }

  private flyToScreenPoint(screenX: number, screenY: number): void {
    if (!this.lastViewProj) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = (screenX / Math.max(rect.width, 1)) * this.canvas.width;
    const py = (screenY / Math.max(rect.height, 1)) * this.canvas.height;
    const ray = screenPointToWorldRay(this.lastViewProj, px, py, this.canvas.width, this.canvas.height);
    if (!ray) return;
    const boxes: HierarchyNodeInfo[] = [];
    for (const node of this.lastDrawn) {
      const parsed = parseLayerNodeKey(node.key);
      const info = parsed ? this.layersBySerial.get(parsed.serial)?.hierarchyByKey.get(parsed.nodeKey) : undefined;
      if (info) boxes.push(info);
    }
    const hit = pickFlyToPoint(ray, boxes, this.visibleCloudBounds() ?? undefined);
    if (!hit) return;
    const goal = flyToGoal(hit, this.camera.distance);
    this.camera.animateTo(goal);
  }

  private lastView: Mat4 | null = null;
  private lastDrawOptions: DrawFrameOptions | null = null;

  getViewSnapshot(): { viewProj: Mat4; up: readonly [number, number, number] } | null {
    if (!this.lastViewProj) return null;
    return { viewProj: this.lastViewProj, up: this.camera.getUpAxis() };
  }

  async pickPoint(cssX: number, cssY: number): Promise<{ point: [number, number, number]; refined: boolean } | null> {
    const viewProj = this.lastViewProj;
    const view = this.lastView;
    const options = this.lastDrawOptions;
    if (!viewProj || !view || !options) return null;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const rect = this.canvas.getBoundingClientRect();
    const px = Math.floor((cssX / Math.max(rect.width, 1)) * width);
    const py = Math.floor((cssY / Math.max(rect.height, 1)) * height);

    const coarseSize = 2 * COARSE_HALF + 1;
    const coarse = await this.gpu.readDepthWindow(px - COARSE_HALF, py - COARSE_HALF, coarseSize, options.edlEnabled);
    if (!coarse) return null;
    const hit = nearestHit(coarse, coarseSize);
    if (!hit) return null;
    const coarseVP = windowViewProj(viewProj, px, py, coarseSize, width, height);
    const coarsePoint = unprojectWindowSample(coarseVP, hit.ix, hit.iy, coarseSize, hit.depth);

    const hx = px - COARSE_HALF + hit.ix;
    const hy = py - COARSE_HALF + hit.iy;
    const projection = this.lastProjection;
    if (!projection) return null;
    const refined = refinedProjection(projection, width / Math.max(height, 1), eyeDistanceFromDepth(projection, hit.depth));
    const refineSize = 2 * REFINE_HALF + 1;
    const refineVP = windowViewProj(multiply(refined.matrix, view), hx, hy, refineSize, width, height);
    const fine = await this.gpu.renderDepthWindow(refineVP, refineSize, this.lastDrawn, options);
    const fineHit = fine ? nearestHit(fine, refineSize) : null;
    if (fineHit) {
      const point = unprojectWindowSample(refineVP, fineHit.ix, fineHit.iy, refineSize, fineHit.depth);
      if (point) return { point, refined: true };
    }
    return coarsePoint ? { point: coarsePoint, refined: false } : null;
  }

  addLayer(layerId: string, input: LayerInput): void {
    if (this.layers.has(layerId)) this.removeLayer(layerId);
    const serial = this.nextLayerSerial++;
    const layer: Layer = {
      id: layerId,
      serial,
      keyPrefix: layerKeyPrefix(serial),
      hierarchy: input.hierarchy,
      hierarchyByKey: new Map(input.hierarchy.map((n) => [n.key, n])),
      readNode: input.readNode,
      boundsMin: [input.boundsMin[0], input.boundsMin[1], input.boundsMin[2]],
      boundsMax: [input.boundsMax[0], input.boundsMax[1], input.boundsMax[2]],
      sceneBounds: computeSceneBounds(input.hierarchy),
      elevationRange: elevationRangeFromCloudBounds(input.boundsMin, input.boundsMax),
      intensityRange: null,
      colorMode: input.colorMode,
      visible: input.visible,
      style: { shape: input.pointShape ?? this.pointShape, sizePx: sanitizePointSize(input.pointSizePx) },
      colorBuffer: this.gpu.createColorSettingsBuffer(),
    };
    const hadVisibleLayer = this.visibleLayers().length > 0;
    this.layers.set(layerId, layer);
    this.layersBySerial.set(serial, layer);

    if (layer.visible) this.moveCameraToLayer(layer, !hadVisibleLayer);
  }

  removeLayer(layerId: string): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    this.layers.delete(layerId);
    this.layersBySerial.delete(layer.serial);
    this.cache.removeByPrefix(layer.keyPrefix);
    layer.colorBuffer?.destroy();
    layer.colorBuffer = null;
    if (this.focusedLayerId === layerId) this.focusedLayerId = null;
    this.updateGridFromVisibleLayers();
  }

  setLayerVisible(layerId: string, visible: boolean): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    layer.visible = visible;
    this.updateGridFromVisibleLayers();
  }

  setLayerColorMode(layerId: string, mode: ColorMode): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.colorMode = mode;
  }

  setLayerPointShape(layerId: string, shape: PointShape): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.style = { ...layer.style, shape };
  }

  setLayerPointSize(layerId: string, px: number): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.style = { ...layer.style, sizePx: sanitizePointSize(px) };
  }

  private nodeStyleOf(node: CachedNode): NodePointStyle {
    const parsed = parseLayerNodeKey(node.key);
    return (parsed && this.layersBySerial.get(parsed.serial)?.style) || this.defaultNodeStyle();
  }

  private defaultNodeStyle(): NodePointStyle {
    return { shape: this.pointShape, sizePx: DEFAULT_POINT_SIZE_PX };
  }

  focusLayer(layerId: string, orientation?: { yaw: number; pitch: number }): boolean {
    const layer = this.layers.get(layerId);
    if (!layer) return false;
    this.moveCameraToLayer(layer, false, orientation);
    return true;
  }

  focusBox(min: readonly [number, number, number], max: readonly [number, number, number]): void {
    const bounds = layerFocusBounds(null, min, max);
    this.camera.setSceneScale(bounds.diagonal);
    this.camera.animateTo(this.focusGoal(bounds));
  }

  private focusGoal(bounds: SceneBounds, orientation?: { yaw: number; pitch: number }): FocusGoal {
    const goal = focusGoalFor(bounds, orientation);
    return this.projectionMode === "orthographic" ? { ...goal, distance: this.fitDistanceFor(bounds) } : goal;
  }

  private focusedLayer(): Layer | undefined {
    return this.focusedLayerId !== null ? this.layers.get(this.focusedLayerId) : undefined;
  }

  private moveCameraToLayer(layer: Layer, immediate: boolean, orientation?: { yaw: number; pitch: number }): void {
    const bounds = layerFocusBounds(layer.sceneBounds, layer.boundsMin, layer.boundsMax);
    this.focusedLayerId = layer.id;
    this.camera.setSceneScale(bounds.diagonal);
    this.applyGridBounds(bounds);
    const goal = this.focusGoal(bounds, orientation);
    if (immediate) {
      this.camera.cancelMotion();
      this.camera.target = goal.target;
      this.camera.distance = goal.distance;
      if (goal.yaw !== undefined) this.camera.yaw = goal.yaw;
      if (goal.pitch !== undefined) this.camera.pitch = goal.pitch;
    } else {
      this.camera.animateTo(goal);
    }
  }

  private visibleLayers(): Layer[] {
    const result: Layer[] = [];
    for (const layer of this.layers.values()) if (layer.visible) result.push(layer);
    return result;
  }

  private visibleSceneBounds(): SceneBounds | null {
    const list: SceneBounds[] = [];
    for (const layer of this.layers.values()) {
      if (layer.visible && layer.sceneBounds) list.push(layer.sceneBounds);
    }
    return mergeSceneBounds(list);
  }

  private visibleCloudBounds(): { boundsMin: [number, number, number]; boundsMax: [number, number, number] } | null {
    const visible = this.visibleLayers();
    if (visible.length === 0) return null;
    const boundsMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const boundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const layer of visible) {
      for (let axis = 0; axis < 3; axis++) {
        boundsMin[axis] = Math.min(boundsMin[axis], layer.boundsMin[axis]);
        boundsMax[axis] = Math.max(boundsMax[axis], layer.boundsMax[axis]);
      }
    }
    return { boundsMin, boundsMax };
  }

  private updateGridFromVisibleLayers(): void {
    const focused = this.focusedLayer();
    const bounds =
      focused && focused.visible
        ? layerFocusBounds(focused.sceneBounds, focused.boundsMin, focused.boundsMax)
        : this.visibleSceneBounds();
    if (bounds) this.applyGridBounds(bounds);
  }

  private applyGridBounds(bounds: SceneBounds): void {
    const upAxis = this.camera.getUpAxis();
    this.gridGroundHeight = bounds.min[0] * upAxis[0] + bounds.min[1] * upAxis[1] + bounds.min[2] * upAxis[2];
    this.gridCellSize = niceGridCellSize(bounds.diagonal);
    this.gridFadeDistance = gridFadeDistance(bounds.diagonal);
  }

  private readLayerNode(key: string): Promise<ArrayBuffer> {
    const parsed = parseLayerNodeKey(key);
    const layer = parsed ? this.layersBySerial.get(parsed.serial) : undefined;
    if (!parsed || !layer) return Promise.reject(new StaleNodeRequestError(key));
    return layer.readNode(parsed.nodeKey);
  }

  setPointBudget(budget: number): void {
    this.autoPointBudgetEnabled = false;
    this.pointBudget = Math.max(1, Math.floor(budget));
    this.cache.maxPoints = this.pointBudget * CACHE_BUDGET_MULTIPLIER;
  }

  getPointBudget(): number {
    return this.pointBudget;
  }

  setAutoPointBudgetEnabled(enabled: boolean): void {
    this.autoPointBudgetEnabled = enabled;
  }

  getAutoPointBudgetEnabled(): boolean {
    return this.autoPointBudgetEnabled;
  }

  setAnimationEnabled(enabled: boolean): void {
    this.animationEnabled = enabled;
  }

  private motionEnabled(): boolean {
    return resolveMotionEnabled(this.animationEnabled, prefersReducedMotion());
  }

  setBackgroundMode(mode: BackgroundMode): void {
    this.backgroundMode = mode;
  }

  setProjectionMode(mode: ProjectionMode): void {
    this.projectionMode = mode;
  }

  getProjectionMode(): ProjectionMode {
    return this.projectionMode;
  }

  setViewPreset(id: ViewPresetId): boolean {
    const bounds = this.visibleFitBounds();
    if (!bounds) return false;
    const angles = viewPresetAngles(id, this.camera.getUpAxis());
    this.camera.setSceneScale(bounds.diagonal);
    this.camera.animateTo({ target: bounds.center, distance: this.fitDistanceFor(bounds), ...angles });
    return true;
  }

  fitAll(): boolean {
    const bounds = this.visibleFitBounds();
    if (!bounds) return false;
    this.camera.setSceneScale(bounds.diagonal);
    this.camera.animateTo({ target: bounds.center, distance: this.fitDistanceFor(bounds) });
    return true;
  }

  private visibleFitBounds(): SceneBounds | null {
    const cloud = this.visibleCloudBounds();
    return cloud ? layerFocusBounds(null, cloud.boundsMin, cloud.boundsMax) : null;
  }

  private fitDistanceFor(bounds: SceneBounds): number {
    return fitDistance(this.projectionMode, bounds.diagonal, this.canvas.width / Math.max(this.canvas.height, 1));
  }

  setGridEnabled(enabled: boolean): void {
    this.gridEnabled = enabled;
  }

  setEdlEnabled(enabled: boolean): void {
    this.edlEnabled = enabled;
  }

  getEdlEnabled(): boolean {
    return this.edlEnabled;
  }

  setCenterPriorityStrength(strength: number): void {
    this.centerPriorityStrength = Math.max(0, strength);
  }

  setMinCenterPriorityWeight(minWeight: number): void {
    this.minCenterPriorityWeight = Math.min(1, Math.max(0, minWeight));
  }

  setRenderScale(scale: number): void {
    this.renderScale = Math.max(0.05, scale);
    this.applyCanvasSize();
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  getPointShape(): PointShape {
    return this.pointShape;
  }

  getIsMobile(): boolean {
    return this.isMobileProfile;
  }

  getAutoPointBudgetMax(): number {
    return this.autoPointBudgetMax;
  }

  onStatsUpdate(callback: (stats: RenderStats) => void): void {
    this.onStats = callback;
  }

  onGpuErrorReported(callback: (message: string) => void): void {
    this.onGpuError = callback;
  }

  private reportGpuError(message: string): void {
    console.error(`[renderer] WebGPU error: ${message}`);
    this.onGpuError?.(message);
  }

  private handleDeviceRecovered(): void {
    this.cache.dispose();
    for (const layer of this.layers.values()) layer.colorBuffer = null;
  }

  private ensureColorBuffer(layer: Layer): GPUBuffer | null {
    if (!layer.colorBuffer) layer.colorBuffer = this.gpu.createColorSettingsBuffer();
    return layer.colorBuffer;
  }

  onNodeLoadErrorReported(callback: (message: string) => void): void {
    this.onNodeLoadError = callback;
  }

  private reportNodeLoadError(key: string, error: unknown): void {
    const parsed = parseLayerNodeKey(key);
    const layerId = parsed ? this.layersBySerial.get(parsed.serial)?.id : undefined;
    if (parsed && layerId === undefined) return;
    const label = parsed && layerId !== undefined ? `${layerId}/${parsed.nodeKey}` : key;
    const message = formatNodeLoadErrorMessage(label, error);
    console.error(`[renderer] ${message}`);
    this.onNodeLoadError?.(message);
  }

  resize(displayWidthCss: number, displayHeightCss: number): void {
    this.lastDisplayWidthCss = Math.max(1, displayWidthCss);
    this.lastDisplayHeightCss = Math.max(1, displayHeightCss);
    this.applyCanvasSize();
  }

  private applyCanvasSize(): void {
    const { width, height } = computeCanvasBackingSize(
      this.lastDisplayWidthCss,
      this.lastDisplayHeightCss,
      this.renderScale,
    );
    this.canvas.width = width;
    this.canvas.height = height;
    this.gpu.resize(width, height);
  }

  start(): void {
    if (this.rafHandle !== 0) return;
    const frame = (time: number) => {
      if (this.disposed) return;
      this.renderOnce(time);
      this.rafHandle = requestAnimationFrame(frame);
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.detachControls();
    this.loader?.dispose();
    this.cache.dispose();
    this.gpu.dispose();
  }

  private handleNodeLoaded(key: string, node: ParsedNode): void {
    if (this.disposed) return;
    const parsed = parseLayerNodeKey(key);
    const layer = parsed ? this.layersBySerial.get(parsed.serial) : undefined;
    if (!layer) return;
    const colorBuffer = this.ensureColorBuffer(layer);
    if (!colorBuffer) return;
    const cached = this.gpu.createCachedNode(key, node, colorBuffer);
    if (!cached) return;
    this.cache.set(cached);

    const nodeIntensityRange = computeIntensityRange(node);
    if (nodeIntensityRange) {
      layer.intensityRange = extendRange(layer.intensityRange, nodeIntensityRange.min);
      layer.intensityRange = extendRange(layer.intensityRange, nodeIntensityRange.max);
    }
  }

  private renderOnce(time: number): void {
    if (!this.gpu.isReady()) return;

    this.frameTimestamps.push(time);
    while (this.frameTimestamps.length > 0 && time - this.frameTimestamps[0] > 1000) {
      this.frameTimestamps.shift();
    }

    this.recordFrameDelta(time);

    const motionEnabled = this.motionEnabled();
    if (!motionEnabled && this.camera.motionEnabled) this.camera.cancelMotion();
    this.camera.motionEnabled = motionEnabled;
    if (this.previousCameraTime !== null) this.camera.update(time - this.previousCameraTime);
    this.previousCameraTime = time;

    const aimdPaused = this.updateIdleBoost(time);
    if (!aimdPaused) this.autoAdjustPointBudget(time);

    const width = this.canvas.width;
    const height = this.canvas.height;
    const aspect = width / Math.max(height, 1);
    const fitBounds = this.visibleFitBounds();
    const sceneDiagonal = fitBounds?.diagonal ?? 0;
    const target = this.camera.target;
    const targetToSceneCenter = fitBounds
      ? Math.hypot(target[0] - fitBounds.center[0], target[1] - fitBounds.center[1], target[2] - fitBounds.center[2])
      : 0;
    const projection = buildProjection(this.projectionMode, aspect, this.camera.distance, sceneDiagonal, targetToSceneCenter);
    this.lastProjection = projection;
    const view = this.camera.viewMatrix();
    const viewProj = multiply(projection.matrix, view);
    this.lastViewProj = viewProj;
    const planes = frustumPlanes(viewProj);

    const visibleLayers = this.visibleLayers();
    const selectionLayers: SelectionLayer[] = visibleLayers.map((l) => ({
      keyPrefix: l.keyPrefix,
      hierarchy: l.hierarchy,
    }));
    const selection = selectNodesForLayers(
      selectionLayers,
      planes,
      viewProj,
      width,
      height,
      this.pointBudget,
      this.cache,
      this.centerPriorityStrength,
      this.minCenterPriorityWeight,
    );

    if (this.loader) {
      this.loader.setWanted(selection.wanted, (key) => this.cache.has(key));
    }

    this.lastDrawn = selection.toDraw;

    for (const node of selection.toDraw) {
      if (node.firstDrawnAtMs === null) node.firstDrawnAtMs = time;
    }

    for (const layer of visibleLayers) {
      const elevationRange = layer.elevationRange;
      const buffer = this.ensureColorBuffer(layer);
      if (!buffer) continue;
      this.gpu.writeColorSettings(
        buffer,
        layer.colorMode,
        elevationRange,
        layer.intensityRange ?? { min: 0, max: 0 },
      );
    }

    const drawOptions: DrawFrameOptions = {
      nowMs: time,
      fadeEnabled: this.motionEnabled(),
      backgroundMode: this.backgroundMode,
      gridEnabled: this.gridEnabled,
      gridCellSize: this.gridCellSize,
      gridFadeDistance: this.gridFadeDistance,
      gridGroundHeight: this.gridGroundHeight,
      edlEnabled: this.edlEnabled,
      edlStrength: this.edlStrength,
      edlRadiusPx: this.edlRadiusPx,
      renderScale: this.renderScale,
      nodeStyle: (node) => this.nodeStyleOf(node),
      cameraEye: this.camera.eye(),
      cameraTarget: this.camera.target,
      upAxis: this.camera.getUpAxis(),
      projection,
    };
    this.lastView = view;
    this.lastDrawOptions = drawOptions;
    this.gpu.drawFrame(viewProj, width, height, selection.toDraw, drawOptions);

    this.updateStats(selection.toDraw, time, visibleLayers.length);
  }

  private updateStats(drawn: CachedNode[], time: number, visibleLayerCount: number): void {
    if (!this.onStats) return;
    if (time - this.lastStatsEmitAt < STATS_INTERVAL_MS) return;
    this.lastStatsEmitAt = time;

    const drawnPoints = drawn.reduce((sum, n) => sum + n.pointCount, 0);
    const fps =
      this.frameTimestamps.length > 1
        ? (this.frameTimestamps.length - 1) / ((time - this.frameTimestamps[0]) / 1000 || 1)
        : 0;

    this.onStats({
      drawnPoints,
      drawnNodes: drawn.length,
      loadingNodes: this.loader?.loadingCount ?? 0,
      queuedNodes: this.loader?.queuedCount ?? 0,
      cachedNodes: this.cache.size,
      fps,
      pointBudget: this.pointBudget,
      backgroundMode: this.backgroundMode,
      gridEnabled: this.gridEnabled,
      cameraPitch: this.camera.pitch,
      cameraYaw: this.camera.yaw,
      cameraUpAxis: [...this.camera.getUpAxis()],
      cameraEye: this.camera.eye(),
      viewPreset: matchViewPreset(this.camera.yaw, this.camera.pitch, this.camera.getUpAxis()),
      cameraAnimating: this.camera.isAnimating(),
      idleBoosting: this.idleBoost.boosting,
      autoPointBudgetEnabled: this.autoPointBudgetEnabled,
      edlEnabled: this.edlEnabled,
      edlStrength: this.edlStrength,
      layerCount: this.layers.size,
      visibleLayerCount,
      renderScale: this.renderScale,
      pointShape: this.pointShape,
      isMobile: this.isMobileProfile,
      pointBudgetMax: this.autoPointBudgetMax,
      centerPriorityStrength: this.centerPriorityStrength,
      minCenterPriorityWeight: this.minCenterPriorityWeight,
    });
  }

  private recordFrameDelta(time: number): void {
    if (this.previousFrameTime !== null) {
      const deltaMs = time - this.previousFrameTime;
      this.recentFrameDeltasMs.push(deltaMs);
      if (this.recentFrameDeltasMs.length > AUTO_POINT_BUDGET_FRAME_HISTORY) {
        this.recentFrameDeltasMs.shift();
      }
      this.refreshIntervalEstimate = updateRefreshIntervalEstimate(this.refreshIntervalEstimate, deltaMs, time);
    }
    this.previousFrameTime = time;
  }

  private updateIdleBoost(time: number): boolean {
    const pose: CameraPose = { eye: this.camera.eye(), target: [...this.camera.target] };
    const cameraActive = this.camera.isAnimating() || cameraPoseChanged(this.previousCameraPose, pose);
    this.previousCameraPose = pose;

    const result = stepIdleBoost(this.idleBoost, {
      nowMs: time,
      cameraActive,
      autoEnabled: this.autoPointBudgetEnabled,
      currentBudget: this.pointBudget,
      maxBudget: this.autoPointBudgetMax,
    });
    this.idleBoost = result.state;

    if (result.action.kind !== "none") {
      this.pointBudget = result.action.budget;
      this.cache.maxPoints = this.pointBudget * CACHE_BUDGET_MULTIPLIER;
    }
    if (result.action.kind === "restore") {
      this.recentFrameDeltasMs = [];
      this.autoPointBudgetConsecutiveHits = 0;
      this.lastAutoBudgetAdjustAt = time;
    }
    return result.aimdPaused;
  }

  private autoAdjustPointBudget(time: number): void {
    if (!this.autoPointBudgetEnabled) return;
    if (time - this.lastAutoBudgetAdjustAt < AUTO_POINT_BUDGET_INTERVAL_MS) return;
    if (this.recentFrameDeltasMs.length === 0) return;
    this.lastAutoBudgetAdjustAt = time;

    const refreshIntervalMs = this.refreshIntervalEstimate?.intervalMs ?? FALLBACK_REFRESH_INTERVAL_MS;

    const result = evaluatePointBudget(
      { budget: this.pointBudget, consecutiveHits: this.autoPointBudgetConsecutiveHits },
      this.recentFrameDeltasMs,
      refreshIntervalMs,
      {
        ...DEFAULT_POINT_BUDGET_TUNING,
        limits: { min: AUTO_POINT_BUDGET_MIN, max: this.autoPointBudgetMax },
      },
    );
    this.autoPointBudgetConsecutiveHits = result.consecutiveHits;

    if (result.budget !== this.pointBudget) {
      this.pointBudget = result.budget;
      this.cache.maxPoints = this.pointBudget * CACHE_BUDGET_MULTIPLIER;
    }
  }
}
