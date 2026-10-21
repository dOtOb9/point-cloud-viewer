// L1-D: レイヤー一覧の状態計算。React にも renderer にも依存しない純粋関数だけを置く
// （一覧への追加・削除後の選択・表示切替・着色の更新）。`useCopcViewer.ts` はこれを呼んで
// 結果を state に入れ、同じ内容を renderer に伝える。単体テストは `layers.test.ts`。
// 純粋関数に分けた理由: フック本体は renderer / DataSource を起動する副作用が大きく、
// 「選択中を消したら先頭を選ぶ」のような規則を直接テストできないため。

import type { CloudInfo } from "../datasource/DataSource";
import { newHistory, type History } from "../app/section-math";
import type { SectionGroundLine, SectionLinePreset } from "../datasource/section-line";
import type { DtmInfo } from "../datasource/dtm"; // G1-T15
import { resolveColorMode, type ColorMode } from "../renderer/colormap";
import type { PointShape } from "../renderer/device-profile";
import { DEFAULT_POINT_SIZE_PX, sanitizePointSize } from "../renderer/layer-focus";
import { pointsBounds, type Measurement } from "./measure";

/** 変換で作ったレイヤーに付く、Web 版のダウンロード用 URL。 */
export interface LayerDownload {
  url: string;
  fileName: string;
}

// --- G2: cross-section view ---
/**
 * What the cross-section tool used to cut this layer (file coordinates). The section panel needs A, B and `up` to turn
 * the layer's points into `(s, z)`; later steps (G2-4 and after) keep the section line here too.
 */
export interface SectionInfo {
  a: [number, number, number];
  b: [number, number, number];
  /** Direction of "up" of the view that picked A and B. */
  up: [number, number, number];
  /** Thickness of the slab in file units (both sides together). */
  thickness: number;
  // --- G2: section line (G2-4) ---
  /** The layer the slab was cut from. The section line is computed from this layer, because a thin slab has no context. */
  sourceLayerId: string;
  /** The CSF preset picked in the dialog; `computeSectionLine` turns it into parameters in the file's unit. */
  linePreset: SectionLinePreset;
  /** The ground line. Absent until it has been computed, and when computing failed or was cancelled. */
  line?: SectionLineState;
}

/**
 * The ground line of a cross section. `original` is what the computation made and is never changed; `history.present`
 * is what the panel draws and what the tracing of G2-5 changes, so "reset" can go back to `original`.
 */
export interface SectionLineState {
  original: SectionGroundLine;
  /** The edit history of the line; `history.present` is what is drawn. Starts as `newHistory(original)`. */
  history: History<SectionGroundLine>;
}

/** 画面の「レイヤー」1件。ADR-0018 の「選んだレイヤーから新しいレイヤーを作る」の元になる単位。 */
export interface ViewerLayer {
  /** UI・renderer 共通のレイヤー id（`layer-1` のような通し番号。消しても再利用しない）。 */
  id: string;
  name: string;
  info: CloudInfo;
  nodeCount: number;
  visible: boolean;
  colorMode: ColorMode;
  /** 点の形・大きさ（直径px）。レイヤーごと（L2-B）。 */
  pointShape: PointShape;
  pointSize: number;
  /** DataSource 側のファイル番号。`close` と `readNode` に使う。 */
  cloudId: number;
  /** L2-F: the string that was passed to `DataSource.open()` for this layer (desktop: file path, Web: registered key).
   *  The point-cloud tools (select / section / merge) pass it to Rust. Absent on measurement layers. */
  sourcePath?: string;
  /** このレイヤーを変換で作ったときだけ入る（内訳テキスト・ダウンロード）。 */
  conversionBreakdownText: string | null;
  download: LayerDownload | null;
  /** L2-D: present only on measurement layers (kind "measurement"); point-cloud layers have none. Test with `isMeasureLayer`. */
  measurement?: Measurement;
  /** G2: present only on a layer made by the cross-section tool ("断面"). */
  section?: SectionInfo;
  /** G1-T15: present only on a layer made by the DTM tool ("地表"): the DTM grid and its files. */
  dtm?: DtmInfo;
}

/** 追加・削除の結果。一覧と選択中の id をひとまとめに返す（選択は常に一覧の中の id か null）。 */
export interface LayersState {
  layers: ViewerLayer[];
  selectedLayerId: string | null;
}

export const EMPTY_LAYERS: LayersState = { layers: [], selectedLayerId: null };

/** 新しいレイヤーの着色の初期値: 既定（RGB）を、RGB が無ければ標高に落とした値。 */
export function initialColorModeFor(info: CloudInfo): ColorMode {
  return resolveColorMode("rgb", info.hasColor);
}


/** 末尾に足し、足したレイヤーを選択にする。 */
export function addLayerToState(state: LayersState, layer: ViewerLayer): LayersState {
  return { layers: [...state.layers, layer], selectedLayerId: layer.id };
}

/**
 * 消す。選択中を消したら残りの先頭を選び、残りが無ければ null。
 * 選択中でないレイヤーを消したときは選択を変えない。存在しない id は何もしない。
 */
export function removeLayerFromState(state: LayersState, id: string): LayersState {
  if (!state.layers.some((l) => l.id === id)) return state;
  const layers = state.layers.filter((l) => l.id !== id);
  const selectedLayerId = state.selectedLayerId === id ? (layers[0]?.id ?? null) : state.selectedLayerId;
  return { layers, selectedLayerId };
}

/** 一覧にある id だけを選択にする（無い id は無視）。 */
export function selectLayerInState(state: LayersState, id: string): LayersState {
  if (!state.layers.some((l) => l.id === id)) return state;
  return { ...state, selectedLayerId: id };
}

export function setLayerVisibleInList(layers: ViewerLayer[], id: string, visible: boolean): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, visible } : l));
}

// --- G2: section line ---
/** Store the computed section line on a cross-section layer (as `original` and as the start of a new history). Other layers are left as they are. */
export function setLayerSectionLineInList(layers: ViewerLayer[], id: string, line: SectionGroundLine): ViewerLayer[] {
  return layers.map((l) =>
    l.id === id && l.section ? { ...l, section: { ...l.section, line: { original: line, history: newHistory(line) } } } : l,
  );
}

/** G2-5: replace the edit history of the section line of a layer. Layers without a line (and other layers) are left as they are. */
export function setLayerSectionLineHistoryInList(
  layers: ViewerLayer[],
  id: string,
  history: History<SectionGroundLine>,
): ViewerLayer[] {
  return layers.map((l) =>
    l.id === id && l.section?.line ? { ...l, section: { ...l.section, line: { ...l.section.line, history } } } : l,
  );
}

// --- G1-T15: DTM ---
/** Store the DTM grid and its files on the layer the DTM tool made. Other layers are left as they are. */
export function setLayerDtmInList(layers: ViewerLayer[], id: string, dtm: DtmInfo): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, dtm } : l));
}

/** 選んだ着色をそのレイヤーに当てはめたときの実際の値（RGB が無ければ標高）。無いレイヤーは null。 */
export function resolveLayerColorMode(layers: ViewerLayer[], id: string, mode: ColorMode): ColorMode | null {
  const layer = layers.find((l) => l.id === id);
  return layer ? resolveColorMode(mode, layer.info.hasColor) : null;
}

/** レイヤーの着色を更新する。RGB を持たないレイヤーで "rgb" を選んだら標高に落とす。 */
export function setLayerColorModeInList(layers: ViewerLayer[], id: string, mode: ColorMode): ViewerLayer[] {
  // Measurement layers have no coloring (a point-cloud-only operation), so leave them unchanged.
  return layers.map((l) => (l.id === id && !isMeasureLayer(l) ? { ...l, colorMode: resolveColorMode(mode, l.info.hasColor) } : l));
}

/** レイヤーの点の形を更新する（L2-B）。 */
export function setLayerPointShapeInList(layers: ViewerLayer[], id: string, shape: PointShape): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, pointShape: shape } : l));
}

/** レイヤーの点の大きさを更新する。範囲外・NaN は丸める（renderer と同じ`sanitizePointSize`）。 */
export function setLayerPointSizeInList(layers: ViewerLayer[], id: string, px: number): ViewerLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, pointSize: sanitizePointSize(px) } : l));
}

export function findLayer(layers: ViewerLayer[], id: string | null): ViewerLayer | null {
  if (id === null) return null;
  return layers.find((l) => l.id === id) ?? null;
}

// ---- L2-D: measurement layers ----

/** Whether this is a measurement layer (distinct from point-cloud layers; point-cloud-only operations such as coloring and appearance are disabled). */
export function isMeasureLayer(layer: ViewerLayer): boolean {
  return layer.measurement !== undefined;
}

/**
 * Make a measurement layer. `ViewerLayer` needs an `info`, so inherit the coordinate system
 * (CRS, scale, offset) of the source point-cloud layer, with point count 0 and the extent set to
 * the bounding box of the measured points. The CRS is inherited for the unit note (m / ft).
 * With no source the CRS is "none".
 */
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
    // Point shape and size are point-cloud-only. Unused for measurement layers (defaults just satisfy the type).
    pointShape: "round",
    pointSize: DEFAULT_POINT_SIZE_PX,
    // No DataSource file (marker for "do not close").
    cloudId: -1,
    conversionBreakdownText: null,
    download: null,
    measurement,
  };
}
