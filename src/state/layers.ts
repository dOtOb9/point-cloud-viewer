import type { CloudInfo } from "../datasource/DataSource";
import { newHistory, type History } from "../app/section-math";
import type { SectionGroundLine, SectionLinePreset } from "../datasource/section-line";
import type { DtmInfo } from "../datasource/dtm";
import { resolveColorMode, type ColorMode } from "../renderer/colormap";
import type { PointShape } from "../renderer/device-profile";
import { DEFAULT_POINT_SIZE_PX, sanitizePointSize } from "../renderer/layer-focus";
import { pointsBounds, type Measurement } from "./measure";

export interface LayerDownload {
  url: string;
  fileName: string;
}

export interface SectionInfo {
  a: [number, number, number];
  b: [number, number, number];
  up: [number, number, number];
  thickness: number;
  sourceLayerId: string;
  linePreset: SectionLinePreset;
  line?: SectionLineState;
}

export interface SectionLineState {
  original: SectionGroundLine;
  history: History<SectionGroundLine>;
}

export interface ViewerLayer {
  id: string;
  name: string;
  info: CloudInfo;
  nodeCount: number;
  visible: boolean;
  colorMode: ColorMode;
  pointShape: PointShape;
  pointSize: number;
  cloudId: number;
  sourcePath?: string;
  conversionBreakdownText: string | null;
  download: LayerDownload | null;
  measurement?: Measurement;
  section?: SectionInfo;
  dtm?: DtmInfo;
}

export interface LayersState {
  layers: ViewerLayer[];
  selectedLayerId: string | null;
}

export const EMPTY_LAYERS: LayersState = { layers: [], selectedLayerId: null };

export function initialColorModeFor(info: CloudInfo): ColorMode {
  return resolveColorMode("rgb", info.hasColor);
}


export function addLayerToState(state: LayersState, layer: ViewerLayer): LayersState {
  return { layers: [...state.layers, layer], selectedLayerId: layer.id };
}

export function removeLayerFromState(state: LayersState, id: string): LayersState {
  if (!state.layers.some((l) => l.id === id)) return state;
  const layers = state.layers.filter((l) => l.id !== id);
  const selectedLayerId = state.selectedLayerId === id ? (layers[0]?.id ?? null) : state.selectedLayerId;
  return { layers, selectedLayerId };
}

export function selectLayerInState(state: LayersState, id: string): LayersState {
  if (!state.layers.some((l) => l.id === id)) return state;
  return { ...state, selectedLayerId: id };
}

export function setLayerVisibleInList(layers: ViewerLayer[], id: string, visible: boolean): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, visible } : l));
}

export function setLayerSectionLineInList(layers: ViewerLayer[], id: string, line: SectionGroundLine): ViewerLayer[] {
  return layers.map((l) =>
    l.id === id && l.section ? { ...l, section: { ...l.section, line: { original: line, history: newHistory(line) } } } : l,
  );
}

export function setLayerSectionLineHistoryInList(
  layers: ViewerLayer[],
  id: string,
  history: History<SectionGroundLine>,
): ViewerLayer[] {
  return layers.map((l) =>
    l.id === id && l.section?.line ? { ...l, section: { ...l.section, line: { ...l.section.line, history } } } : l,
  );
}

export function setLayerDtmInList(layers: ViewerLayer[], id: string, dtm: DtmInfo): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, dtm } : l));
}

export function resolveLayerColorMode(layers: ViewerLayer[], id: string, mode: ColorMode): ColorMode | null {
  const layer = layers.find((l) => l.id === id);
  return layer ? resolveColorMode(mode, layer.info.hasColor) : null;
}

export function setLayerColorModeInList(layers: ViewerLayer[], id: string, mode: ColorMode): ViewerLayer[] {
  return layers.map((l) => (l.id === id && !isMeasureLayer(l) ? { ...l, colorMode: resolveColorMode(mode, l.info.hasColor) } : l));
}

export function setLayerPointShapeInList(layers: ViewerLayer[], id: string, shape: PointShape): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, pointShape: shape } : l));
}

export function setLayerPointSizeInList(layers: ViewerLayer[], id: string, px: number): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, pointSize: sanitizePointSize(px) } : l));
}

export function findLayer(layers: ViewerLayer[], id: string | null): ViewerLayer | null {
  if (id === null) return null;
  return layers.find((l) => l.id === id) ?? null;
}

export function isMeasureLayer(layer: ViewerLayer): boolean {
  return layer.measurement !== undefined;
}

export function makeMeasureLayer(id: string, name: string, measurement: Measurement, source: ViewerLayer | null): ViewerLayer {
  const { min, max } = pointsBounds(measurement.points);
  const info: CloudInfo = {
    pointCount: 0,
    min,
    max,
    scale: source?.info.scale ?? [1, 1, 1],
    offset: source?.info.offset ?? [0, 0, 0],
    hasColor: false,
    crs: source?.info.crs ?? { name: "", kind: "none" },
  };
  return {
    id,
    name,
    info,
    nodeCount: 0,
    visible: true,
    colorMode: "elevation",
    pointShape: "round",
    pointSize: DEFAULT_POINT_SIZE_PX,
    cloudId: -1,
    conversionBreakdownText: null,
    download: null,
    measurement,
  };
}
