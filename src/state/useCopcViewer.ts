import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  TauriSource,
  cancelLasConversion,
  extractToCopc as tauriExtractToCopc,
  mergeCopcs as tauriMergeCopcs,
  onConversionDone,
  onConversionFailed,
  onConversionProgress,
  pickTempDirectory,
  reportToBackendConsole,
  startLasConversion,
  startMultiLasConversion,
  supportsCustomTempDir as fetchSupportsCustomTempDir,
} from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import { isCopcFile } from "../datasource/copc-header";
import {
  cleanupStaleScratchDirs,
  clearAllCachedConversions,
  describeInsufficientSpaceWeb,
  ensurePersistentStorage,
  estimateQuota,
  getConvertedFile,
  getOpfsUsageBreakdown,
  isPersisted,
  multiDisplayNameFor,
  removeCachedConversionEntry,
  removeScratchDirByName,
  type CachedConversionEntry,
  type OpfsUsageBreakdown,
} from "../datasource/opfs";
import { detectSourceFormatByName } from "../datasource/source-format";
import { isTauriEnvironment } from "../datasource/environment";
import type { DataSource } from "../datasource/DataSource";
import type { ConversionProgress } from "../datasource/conversion-dto";
import { formatConversionBreakdown, type ConversionBreakdownMeta } from "../datasource/conversion-breakdown";
import { PointCloudRenderer, type RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "../renderer/sky";
import { DEFAULT_GRID_ENABLED } from "../renderer/ground-grid";
import {
  applyMotionAttribute,
  readStoredAnimationEnabled,
  storeAnimationEnabled,
} from "./motion-setting";
import { GpuErrorLog, type GpuErrorEntry } from "../renderer/gpu-error-log";
import type { ColorMode } from "../renderer/colormap";
import { DEFAULT_POINT_SIZE_PX } from "../renderer/layer-focus";
import { defaultRenderSettings, readDeviceProfileInput, type PointShape } from "../renderer/device-profile";
import {
  EMPTY_LAYERS,
  addLayerToState,
  findLayer,
  initialColorModeFor,
  isMeasureLayer,
  makeMeasureLayer,
  removeLayerFromState,
  resolveLayerColorMode,
  selectLayerInState,
  setLayerColorModeInList,
  setLayerPointShapeInList,
  setLayerPointSizeInList,
  setLayerVisibleInList,
  type LayerDownload,
  type LayersState,
  type ViewerLayer,
} from "./layers";
import { DEFAULT_CENTER_PRIORITY_STRENGTH, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "../renderer/center-priority";
import { MEASURE_KIND_NAME, type Measurement } from "./measure";
import { effectiveSelectedIds, rangeSelectedIds, toggleSelectedId, toolSourceLayers } from "./layer-selection";
import { sectionYaw } from "./tool-math";
import { horizontalBasis } from "../renderer/up-axis";
import type { ExtractFilter, ToolOptions, ToolResult } from "../datasource/tools";

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

const TEMP_DIR_STORAGE_KEY = "pcv-conversion-temp-dir";

/** M4-12(`TaskSheets/M4-import-and-conversion.md`): `path`(Tauri版の
 *  `\`/`/`どちらも使える文字列パス)の最後の区切り以降をファイル名として
 *  返す(拡張子の判定・内訳テキストの表示用。実在のパスである必要は無い、
 *  `pcv_convert::output_path`と同じ割り切り)。 */
function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

/** ファイル名の拡張子(小文字、無ければ"(不明)")。内訳テキストの「形式」欄に使う。 */
function extensionOfFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "(不明)" : fileName.slice(dotIndex + 1).toLowerCase();
}

/**
 * 変換が終わってから、その結果を開いてレイヤーになるまでの間だけ持つ「保留中の変換結果」。
 *
 * 不具合修正(2026-10-08、「変換の内訳が出てこない」)の経緯: 変換完了ハンドラは内訳を設定した直後に
 * `openFile` を呼ぶが、`openFile` が冒頭で内訳を消していたため画面に出なかった。
 * L1-D では内訳・ダウンロードは「それを作ったレイヤー」に付ける。完了ハンドラはここに置き、
 * `openFile(…, true)`（変換から続けて開く）が成功したときだけレイヤーへ移す。
 * 利用者が自分で別のファイルを開いたとき（第2引数 false）は移さない（別のレイヤーに内訳が付かないように）。
 */
interface PendingConversionResult {
  /** レイヤー欄に出す名前（変換後の `.copc.laz` の名前）。 */
  name: string;
  breakdownText: string;
  download: LayerDownload | null;
}

/** M4-12: 内訳テキストに入れる端末情報。`navigator.deviceMemory`は
 *  Chrome系だけの実験的API(型定義に無いため`as`で読む)。取れなければ
 *  `undefined`のままにする(無いことを0などの値で埋めない)。 */
function currentDeviceMeta(): Pick<ConversionBreakdownMeta, "browser" | "hardwareConcurrency" | "deviceMemoryGiB"> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    browser: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGiB: nav.deviceMemory,
  };
}

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

/** localStorageが無い環境(vitestのnode等)ではundefined。 */
function getLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readStoredTempDir(): string | null {
  try {
    return localStorage.getItem(TEMP_DIR_STORAGE_KEY);
  } catch {
    return null;
  }
}

// M4-3: "converting"は生LAS/LAZの変換中(進捗・キャンセルUIを出す状態)。
// 変換を挟まない通常のCOPCを開く処理は従来どおり"opening"のまま
// (一瞬で終わるため専用の状態を設けない)。
export type ViewerStatus = "idle" | "opening" | "converting" | "ready" | "error";

// canvasRefは意図的にCopcViewerStateに含めない。ref(canvasRef)とstate(下記)を
// 同じオブジェクトに混ぜると、eslint-plugin-react-hooksの`react-hooks/refs`が
// 「このオブジェクトのプロパティはrefかもしれない」と見なし、stateの参照にまで
// render中アクセス禁止の誤検知を起こすため、呼び出し側には別々の値として返す。
export interface CopcViewerState {
  status: ViewerStatus;
  error: string | null;
  /**
   * L1-D: 開いているレイヤーの一覧（足した順）。「開く」は常に末尾へ足す（置き換えない）。
   * 名前・点群情報・点数・着色・表示/非表示・変換の内訳・ダウンロードはレイヤーごとに持つ。
   */
  layers: ViewerLayer[];
  /** 選択中のレイヤーの id。レイヤーが無ければ null。足したレイヤーは自動で選択になる。 */
  selectedLayerId: string | null;
  /** `layers` の中の選択中の1件（無ければ null）。レイヤー情報・着色ダイアログ・CRS 表示が引く。 */
  selectedLayer: ViewerLayer | null;
  selectLayer: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  /** そのレイヤーの着色を変える。RGB を持たないレイヤーで "rgb" を選んだら標高に落ちる。 */
  setLayerColorMode: (id: string, mode: ColorMode) => void;
  /** L2-B: そのレイヤーの点の形（丸/四角）。 */
  setLayerPointShape: (id: string, shape: PointShape) => void;
  /** L2-B: そのレイヤーの点の大きさ（直径px、1〜32に丸める）。 */
  setLayerPointSize: (id: string, px: number) => void;
  /** L2-B: そのレイヤーへカメラを移す（アニメーション無効なら即時）。 */
  focusLayer: (id: string, orientation?: { yaw: number; pitch: number }) => void;
  /** L2-F: ids selected together (Ctrl/Shift click). Includes `selectedLayerId` (the last chosen; the action buttons act on it). */
  selectedLayerIds: string[];
  /** L2-F: Ctrl/Cmd click: add to / remove from the selection. */
  toggleLayerSelection: (id: string) => void;
  /** L2-F: Shift click: select the rows between `selectedLayerId` and this one. */
  selectLayerRange: (id: string) => void;
  /** L2-F: progress of the running point-cloud tool, or null. */
  toolProgress: ToolProgressState | null;
  cancelTool: () => void;
  /** L2-F: make a new layer from the points of `layerId` that match `filter` (ADR-0018). Failures go to the error log. */
  extractFromLayer: (
    layerId: string,
    filter: ExtractFilter,
    label: "選択" | "断面",
    viewNormal?: readonly [number, number, number],
  ) => Promise<void>;
  /** L2-F: merge the selected point-cloud layers into one new layer. */
  mergeSelectedLayers: () => Promise<void>;
  /** レイヤーを消す（renderer から外し、DataSource のファイルも閉じる）。 */
  removeLayer: (id: string) => void;
  /** L2-D: 3D coordinates of a screen point (canvas CSS pixels); null where there is no point. The renderer's `pickPoint`. */
  pickPoint: (cssX: number, cssY: number) => Promise<{ point: [number, number, number]; refined: boolean } | null>;
  /** L2-D: latest-frame viewProj and up axis (for overlaying measurement lines). */
  getViewSnapshot: () => { viewProj: number[]; up: readonly [number, number, number] } | null;
  /** L2-D: add a finished measurement as a new "measurement" layer (it becomes the selection). */
  addMeasurement: (measurement: Measurement) => void;
  pointBudget: number;
  /** タスクB(ADR-0009)の自動調整のオン/オフ。既定値はrendererの既定(true)に合わせている。 */
  autoPointBudgetEnabled: boolean;
  stats: RenderStats | null;
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  /** M2-1: EDL(Eye-Dome Lighting)のオン/オフ。既定はrendererの既定(オン)に
   *  合わせている。RGBを持たない点群(sofi.copc.laz)でも形状を読めるようにする
   *  必須機能なので、既定でオフにはしていない（TaskSheets/M2-shading-and-ui.md
   *  M2-1参照）。強さはUIから調整する手段を置かず、`src/renderer/edl.ts`の
   *  `DEFAULT_EDL_STRENGTH`で固定している（値と経緯はそちらのコメント参照）。 */
  edlEnabled: boolean;
  /** AN: アニメーション（フェードイン・慣性・視点移動）のオン/オフ。UIのトグルは未実装（UIの作り直し後）。 */
  animationEnabled: boolean;
  renderScale: number;
  pointShape: PointShape;
  /** ADR-0010追記: LOD優先度に画面中央からの距離で掛ける重みの強さ。0で
   *  今までどおり（画面空間誤差のみ）。既定値は`center-priority.ts`の
   *  `DEFAULT_CENTER_PRIORITY_STRENGTH`（未検証の初期値）。設定画面から
   *  変更でき、再起動なしでrendererへ反映される。 */
  centerPriorityStrength: number;
  /** 2026-10-08追記: 中央優先度の重みの下限（0〜1）。既定は
   *  `DEFAULT_MIN_CENTER_PRIORITY_WEIGHT`（0.2）。0に近いほど画面端の
   *  ノードを後回しにしてよい度合いが大きくなる。設定画面のスライダーから
   *  変更でき、再起動なしでrendererへ反映される
   *  （`PointCloudRenderer.setMinCenterPriorityWeight()`参照）。 */
  minCenterPriorityWeight: number;
  /** WebGPUのエラー（ADR-0011）。`device.onuncapturederror`・デバイス消失・初期化時の
   *  バリデーションエラーがここに蓄積される。M3(ADR-0013)以降は`pcv://`の
   *  ノード読み出し失敗（Rust側のpanicから復旧したものを含む）も同じ配列に
   *  混ざる（`GpuErrorEntry.source`で区別する）。蓄積・重複抑制のロジック自体は
   *  `GpuErrorLog`（renderer/gpu-error-log.ts、GPUに依存しない純粋なクラス）に
   *  切り出してあり、ここではそのスナップショットを保持するだけ。表示は
   *  `src/ui/shell/GpuErrorBanner.tsx`が担当する（規約3）。 */
  gpuErrors: GpuErrorEntry[];
  /**
   * UIシェル再構築(ADR-0017)で追加: このセッション中に報告された全エラーの
   * 履歴（`dismissGpuError`で消しても消えない）。`gpuErrors`は バナーが表示する
   * 「現在出ている」エラーで、閉じると配列から消える。エラーログダイアログ
   * （`ErrorLogDialog.tsx`）はこちらを表示することで、閉じたエラーも含めて
   * 「このセッションで何が起きたか」をあとから確認できるようにする。
   * 追記・countの更新だけを行い、エントリを削除することは無い
   * （`recordErrorHistory`参照）。
   */
  errorHistory: GpuErrorEntry[];
  /** 変換ダイアログ(ConversionDialog.tsx)に出す、変換中の元ファイル名。まだ変換していなければnull。 */
  convertingFileName: string | null;
  /** Tauri版はパス文字列、Web版はURL文字列か、ドラッグ&ドロップ/選択した`File`を渡す。 */
  openFile: (pathOrFile: string | File) => Promise<void>;
  /**
   * M4-14: ファイル選択で複数(2件以上)選ばれたときに呼ぶ。LAS/LAZを1つの
   * COPCへマージして開く(`src-tauri`の`start_multi_las_conversion`/Web版の
   * `WebSource.startMultiConversion`)。1件だけ渡された場合は`openFile`と
   * 同じ挙動になる(受け入れ条件「単一ファイルは今までと同じ挙動」)。
   * PLY/PCD/E57が混じっていた場合は、変換を試みる前に明確なエラーを出す
   * (受け入れ条件。LAS/LAZの混在はOK)。
   */
  openFiles: (pathsOrFiles: string[] | File[]) => Promise<void>;
  /** LayerPanelがTauri用のパス入力とWeb用のファイル選択/URL入力を切り替えるための判定。 */
  isBrowser: boolean;
  /**
   * M4-3: 生LAS/LAZの変換中(`status === "converting"`)の進捗。読み込み段階は
   * `{phase: "reading", pointsRead, totalPoints, elapsedSecs}`で正確な割合が
   * 分かり、その後(octree構築・書き出し)は`{phase: "postProcessing",
   * elapsedSecs}`に切り替わる(割合は出せない。理由は
   * `src-tauri/src/conversion.rs`のドキュメント参照)。変換していないときは`null`。
   */
  conversionProgress: ConversionProgress | null;
  /** 変換中にキャンセルボタンから呼ぶ。 */
  cancelConversion: () => void;
  /**
   * 選択中のレイヤーの変換の内訳を、クリップボードへコピーする。
   * コピーに成功したら`true`を返す(失敗は握りつぶしてログだけ残す)。
   * 内訳・ダウンロード（Web版）は変換で作ったレイヤーの `ViewerLayer` に付く。
   */
  copyConversionBreakdownText: () => Promise<boolean>;
  /**
   * M4-6追記: Web版のOPFS使用量(キャッシュ・一時ファイルの内訳)と永続化の
   * 状態。取得前・Tauri版では`null`(`viewer.isBrowser`で先に弾く想定。
   * `SettingsModal`参照)。`refreshOpfsStorageInfo`で更新する。
   */
  opfsStorageInfo: OpfsStorageInfo | null;
  /** `opfsStorageInfo`を取得・再計算する(設定画面を開いたとき、消した後など)。 */
  refreshOpfsStorageInfo: () => Promise<void>;
  /** まだ永続化されていなければ`persist()`を求め、結果に関わらず
   *  `opfsStorageInfo`を更新する(設定画面の「許可を求める」ボタン用)。 */
  requestOpfsPersistentStorage: () => Promise<void>;
  /** 変換済みキャッシュを1件消し、`opfsStorageInfo`を更新する。 */
  removeOpfsCachedConversion: (entry: CachedConversionEntry) => Promise<void>;
  /** 変換済みキャッシュを全て消し、`opfsStorageInfo`を更新する。 */
  clearOpfsCachedConversions: () => Promise<void>;
  /** 残っている一時ディレクトリを1件消し、`opfsStorageInfo`を更新する。 */
  removeOpfsScratchDir: (name: string) => Promise<void>;
  /** 残っている一時ディレクトリを全て消し、`opfsStorageInfo`を更新する。 */
  clearOpfsScratchDirs: () => Promise<void>;
  /** 一時ファイルの置き場所の設定(未設定なら`null`=プラットフォームの既定)。
   *  Tauriのみ意味を持つ(Web版は変換自体をしない)。 */
  tempDir: string | null;
  /** デスクトップだけ`true`(Androidはアプリのキャッシュへ自動で誘導されるため、
   *  手動選択のUIを出さない。`src-tauri/src/conversion.rs`の
   *  `supports_custom_temp_dir`参照)。Web版では常に`false`。 */
  supportsCustomTempDir: boolean;
  /** OSのフォルダ選択ダイアログを出し、選んだ場所を`tempDir`に設定する。 */
  pickAndSetTempDir: () => Promise<void>;
  /** `tempDir`を明示的にクリアする(既定値に戻す)。 */
  clearTempDir: () => void;
  setPointBudget: (budget: number) => void;
  setAutoPointBudgetEnabled: (enabled: boolean) => void;
  setBackgroundMode: (mode: BackgroundMode) => void;
  setGridEnabled: (enabled: boolean) => void;
  setEdlEnabled: (enabled: boolean) => void;
  setAnimationEnabled: (enabled: boolean) => void;
  /** AN-2: 「全体を表示」。アニメーションで初期の位置・向きに戻る。 */
  resetView: () => void;
  setRenderScale: (scale: number) => void;
  setPointShape: (shape: PointShape) => void;
  setCenterPriorityStrength: (strength: number) => void;
  setMinCenterPriorityWeight: (minWeight: number) => void;
  /** バナーの「閉じる」ボタンから呼ぶ。指定したエラーだけを消す。 */
  dismissGpuError: (id: number) => void;
}

/**
 * M1-4: COPCビューアの状態。src/renderer と src/datasource を束ね、UI(src/ui)へは
 * このフックだけを見せる（規約3: UIはrendererを直接触らずstateを経由する）。
 * octree全体のhierarchyをrendererに渡し、画面空間誤差でのLOD選択に任せる。
 */
export function useCopcViewer(): [RefObject<HTMLCanvasElement | null>, CopcViewerState] {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  // TauriのwebviewかブラウザかでTauriSource/WebSourceを選ぶ（Web版はこの1箇所だけの
  // 分岐で切り替わる。TaskSheets/ADR-0012-web-worker-sync-io.md参照）。
  const sourceRef = useRef<DataSource | null>(null);
  // L1-D: レイヤー一覧と選択中の id。state（再描画用）と ref（コールバックから最新を読む用）の
  // 両方に同じ値を入れる（`commitLayers` だけが書く）。renderer / DataSource への反映は
  // 呼び出し側（openFile・removeLayer など）が行う。
  const [layersState, setLayersState] = useState<LayersState>(EMPTY_LAYERS);
  const layersStateRef = useRef<LayersState>(EMPTY_LAYERS);
  const commitLayers = useCallback((next: LayersState) => {
    layersStateRef.current = next;
    setLayersState(next);
  }, []);
  // L2-F: ids selected together with Ctrl/Shift click (see layer-selection.ts; trusted only while it contains the primary).
  const [extraSelectedIds, setExtraSelectedIds] = useState<string[]>([]);
  // L2-F: true while a point-cloud tool runs. The desktop tools reuse the `conversion-progress` event, and the
  // conversion listener below must not treat that as a conversion.
  const toolRunningRef = useRef(false);
  const [toolProgress, setToolProgress] = useState<ToolProgressState | null>(null);
  // レイヤー id の通し番号。消しても再利用しない（renderer 側のキー衝突を避ける）。
  const nextLayerNumberRef = useRef(1);
  // 変換が終わってから、その結果のレイヤーが開くまでの保留中の結果（`PendingConversionResult`）。
  const pendingConversionRef = useRef<PendingConversionResult | null>(null);
  const setPendingConversion = useCallback((next: PendingConversionResult | null) => {
    // 開かれないまま残った前回のダウンロード URL は、ここで手放す。
    const previous = pendingConversionRef.current;
    if (previous?.download) URL.revokeObjectURL(previous.download.url);
    pendingConversionRef.current = next;
  }, []);
  // GpuErrorLog自体はReactのstateではない（GPUに依存しない蓄積・重複抑制ロジックの
  // 実体、renderer/gpu-error-log.ts参照）。useRefで1個だけ持ち、reportのたびに
  // list()のスナップショットをgpuErrors stateへコピーしてReactに再描画させる。
  const gpuErrorLogRef = useRef(new GpuErrorLog());

  // M3-8: モバイル判定と各手段の既定値を、`PointCloudRenderer`のコンストラクタが
  // 呼ぶのと同じ`defaultRenderSettings(readDeviceProfileInput())`で決める。
  // 同じ入力(実行中のブラウザの状態は変わらない)に対して同じ純粋関数を呼ぶだけ
  // なので、rendererとこのフックの初期値はハンドシェイクなしで一致する
  // （point-cloud-renderer.tsのコンストラクタのコメント参照）。`useState`の
  // 初期化関数として渡し、レンダー毎に呼び直されないようにする。
  const [deviceProfileDefaults] = useState(() => defaultRenderSettings(readDeviceProfileInput()));

  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pointBudget, setPointBudgetState] = useState(deviceProfileDefaults.pointBudgetStart);
  // rendererの既定(PointCloudRenderer内 private autoPointBudgetEnabled = true)と合わせる。
  const [autoPointBudgetEnabled, setAutoPointBudgetEnabledState] = useState(true);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const [backgroundMode, setBackgroundModeState] = useState<BackgroundMode>(DEFAULT_BACKGROUND_MODE);
  const [gridEnabled, setGridEnabledState] = useState(DEFAULT_GRID_ENABLED);
  const [edlEnabled, setEdlEnabledState] = useState(deviceProfileDefaults.edlEnabled);
  const [animationEnabled, setAnimationEnabledState] = useState(() => readStoredAnimationEnabled(getLocalStorage()));
  const [renderScale, setRenderScaleState] = useState(deviceProfileDefaults.renderScale);
  const [pointShape, setPointShapeState] = useState<PointShape>(deviceProfileDefaults.pointShape);
  const [centerPriorityStrength, setCenterPriorityStrengthState] = useState(DEFAULT_CENTER_PRIORITY_STRENGTH);
  const [minCenterPriorityWeight, setMinCenterPriorityWeightState] = useState(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT);
  const [gpuErrors, setGpuErrors] = useState<GpuErrorEntry[]>([]);
  // UIシェル再構築(ADR-0017)で追加: dismissで消えないエラー履歴。
  // `setGpuErrors`の直後に呼ぶ`recordErrorHistory`だけが更新する
  // （`dismissGpuError`からは呼ばない。消えないことがこの履歴の存在理由）。
  const [errorHistory, setErrorHistory] = useState<GpuErrorEntry[]>([]);
  const recordErrorHistory = (current: GpuErrorEntry[]) => {
    setErrorHistory((prev) => {
      const byId = new Map(prev.map((entry) => [entry.id, entry] as const));
      for (const entry of current) byId.set(entry.id, entry);
      return Array.from(byId.values()).sort((a, b) => a.firstAt - b.firstAt);
    });
  };
  // 変換ダイアログに出す「いま変換している元ファイル名」(複数選択のときは表示名)。
  const [convertingFileName, setConvertingFileName] = useState<string | null>(null);
  // M4-3: 変換中の進捗。変換していないときはnull。
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  // 変換を開始する直前に元ファイル名を覚えておく(`openFile`が設定し、
  // マウント時に1度だけ張る`onConversionDone`/`onConvertDone`のハンドラが
  // 変換完了時にこれを読む。両ハンドラはクロージャ生成時点のファイル名を
  // 知らないため、refで渡す。「effectは一度だけ、でも中身は最新でありたい」
  // という`openFileRef`と同じ理由)。
  const convertingSourceNameRef = useRef<string | null>(null);

  // M4-12: 選択中のレイヤーの内訳テキストをクリップボードへコピーする。
  // `navigator.clipboard`が無い環境(非HTTPS等)でも画面を壊さないよう、失敗はログに残すだけにする。
  const selectedBreakdownText = findLayer(layersState.layers, layersState.selectedLayerId)?.conversionBreakdownText ?? null;
  const copyConversionBreakdownText = useCallback(async (): Promise<boolean> => {
    if (selectedBreakdownText === null) return false;
    try {
      await navigator.clipboard.writeText(selectedBreakdownText);
      return true;
    } catch (e: unknown) {
      console.error("copyConversionBreakdownText failed", e);
      return false;
    }
  }, [selectedBreakdownText]);

  // M4-6追記: Web版のOPFS使用量・永続化の状態(設定画面「ブラウザの保存領域」節)。
  const [opfsStorageInfo, setOpfsStorageInfo] = useState<OpfsStorageInfo | null>(null);

  const refreshOpfsStorageInfo = useCallback(async () => {
    if (isTauriEnvironment()) return;
    try {
      const [estimate, breakdown, persisted] = await Promise.all([
        estimateQuota(),
        getOpfsUsageBreakdown(),
        isPersisted(),
      ]);
      setOpfsStorageInfo({ quotaBytes: estimate.quota, usageBytes: estimate.usage, persisted, breakdown });
    } catch (e: unknown) {
      // 取得できなくても画面が壊れないよう、ログに残す程度に留める
      // (設定画面側は`opfsStorageInfo`が更新されず「読み込み中…」のままになるだけ)。
      console.error("refreshOpfsStorageInfo failed", e);
    }
  }, []);

  const requestOpfsPersistentStorage = useCallback(async () => {
    if (!isTauriEnvironment()) {
      try {
        await ensurePersistentStorage(navigator.storage);
      } catch (e: unknown) {
        console.error("ensurePersistentStorage failed", e);
      }
    }
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);

  const removeOpfsCachedConversion = useCallback(
    async (entry: CachedConversionEntry) => {
      await removeCachedConversionEntry(entry);
      await refreshOpfsStorageInfo();
    },
    [refreshOpfsStorageInfo],
  );

  const clearOpfsCachedConversions = useCallback(async () => {
    await clearAllCachedConversions();
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);

  const removeOpfsScratchDir = useCallback(
    async (name: string) => {
      await removeScratchDirByName(name);
      await refreshOpfsStorageInfo();
    },
    [refreshOpfsStorageInfo],
  );

  const clearOpfsScratchDirs = useCallback(async () => {
    await cleanupStaleScratchDirs();
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);
  const [tempDir, setTempDirState] = useState<string | null>(() => readStoredTempDir());
  // Androidかどうかはフロントから直接判定できないため、起動時に一度だけ
  // Rust側へ問い合わせる(既定はtrue=デスクトップ相当。Web版はisBrowserが
  // 別途trueになるので、この値がtrueのままでもUI側でisBrowserを優先して隠す)。
  const [supportsCustomTempDirState, setSupportsCustomTempDirState] = useState(true);

  // `openFile`は`tempDir`等に依存して再生成される(下のuseCallback参照)。
  // マウント時に1度だけ張るイベント購読(下のuseEffect)から常に最新の
  // `openFile`を呼べるよう、refに常に最新の関数を入れておく
  // (「effectは一度だけ、でも中身は最新でありたい」という定番の対処)。
  const openFileRef = useRef<(pathOrFile: string | File, isConversionContinuation?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new PointCloudRenderer(canvas);
    const source: DataSource = isTauriEnvironment() ? new TauriSource() : new WebSource();
    rendererRef.current = renderer;
    // 保存済みのアニメーション設定をrendererへ反映する(未保存ならオン)。
    renderer.setAnimationEnabled(readStoredAnimationEnabled(getLocalStorage()));
    // 実ブラウザでの計測・確認用（AN-1/AN-2）。URLに?pcvDebugが付いたときだけ、
    // rendererを window.__pcvRenderer に出す。付けなければ何も起きない。
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has("pcvDebug")) {
      (window as unknown as { __pcvRenderer?: unknown }).__pcvRenderer = renderer;
    }
    sourceRef.current = source;

    // M4-3/M4-6b: 変換の進捗・完了・失敗イベントの購読。Tauri版は
    // `src/datasource/tauri.ts`のイベント(Rustのbackendから`listen`)、Web版は
    // `WebSource`自身のリスナー登録(WorkerからのpostMessageを内部で仲介する。
    // `src/datasource/web.ts`参照)と、経路が全く違うためここで分岐する
    // (Web版はそもそもTauriのイベント配信の裏付けが無い)。
    let unlistenProgress = () => {};
    let unlistenDone = () => {};
    let unlistenFailed = () => {};

    const reportConversionFailure = (message: string, cancelled: boolean) => {
      setConversionProgress(null);
      setStatus(cancelled ? "idle" : "error");
      setError(cancelled ? null : message);
      // 受け入れ条件: 変換の失敗・キャンセルは画面に出す(ADR-0011/ADR-0013の
      // エラーバナー)。キャンセルも「何が起きたか」が分かるようにバナーへ出す
      // (バナーが無いと、進捗が消えるだけで所有者には何も起きなかったように見える)。
      gpuErrorLogRef.current.report(
        cancelled ? "変換をキャンセルしました" : `変換に失敗しました: ${message}`,
        undefined,
        "conversion",
      );
      setGpuErrors(gpuErrorLogRef.current.list());
      recordErrorHistory(gpuErrorLogRef.current.list());
    };

    if (source instanceof WebSource) {
      unlistenProgress = source.onConvertProgress((progress) => setConversionProgress(progress));
      unlistenDone = source.onConvertDone((outputName, suggestedFileName, _pointCount, stageTimings) => {
        setConversionProgress(null);
        // M4-12: 内訳テキストを組み立てる。元ファイル名は`openFile`が変換開始前に
        // 覚えておいた値(`convertingSourceNameRef`)を使う(`suggestedFileName`は
        // 既に".copc.laz"へ拡張子が変わっているため、元の形式が分からない)。
        const sourceName = convertingSourceNameRef.current ?? suggestedFileName;
        const breakdownText = formatConversionBreakdown(stageTimings, {
            platform: "web",
            // M4-14: 複数ファイルのときは表示名に拡張子が無い(「<名前> ほかNファイル」)
            // ので、デスクトップ版(src-tauriが返す文字列)と同じ表記にする。
            format:
              stageTimings.inputFileCount > 1
                ? "las/laz(複数ファイル)"
                : extensionOfFileName(sourceName),
            fileName: sourceName,
            ...currentDeviceMeta(),
          });
        void (async () => {
          // OPFSに書いた出力を`File`として取り出し、通常のローカルファイル選択と
          // 同じ経路(`registerFile`→`open`)で開く。ダウンロード用のURLも
          // ここで作る(OPFSの中身はアプリの外から直接取り出せないため。
          // 受け入れ条件「変換したCOPCをダウンロードできるようにする」)。
          const file = await getConvertedFile(outputName);
          if (!file) {
            setStatus("error");
            setError("変換結果をOPFSから読み出せませんでした");
            return;
          }
          // L1-D: 内訳・ダウンロードは保留しておき、続けて開くレイヤーに付ける（PendingConversionResult参照）。
          setPendingConversion({
            name: suggestedFileName,
            breakdownText,
            download: { url: URL.createObjectURL(file), fileName: suggestedFileName },
          });
          const key = source.registerFile(file);
          // 「変換結果を続けて開く」ことを示す第2引数trueを渡す（保留中の結果をレイヤーに移すため）。
          void openFileRef.current(key, true);
        })();
      });
      unlistenFailed = source.onConvertFailed(reportConversionFailure);
    } else {
      void onConversionProgress((progress) => {
        // A point-cloud tool also emits this event (L2-C). Its progress goes to the tool dialog, not the conversion UI.
        if (!toolRunningRef.current) setConversionProgress(progress);
      }).then((fn) => {
        unlistenProgress = fn;
      });
      void onConversionDone((outputPath, sourceFormat, stageTimings) => {
        // 変換が終わった出力(既にCOPC)をそのまま開き直す。もう一度
        // start_las_conversionを経由するが、既にCOPCと判定されて即座に開く
        // 経路に入るだけなので実害は無い(往復コストはヘッダー1回分)。
        setConversionProgress(null);
        setPendingConversion({
          name: basenameOfPath(outputPath),
          breakdownText: formatConversionBreakdown(stageTimings, {
            platform: "desktop",
            format: sourceFormat,
            fileName: convertingSourceNameRef.current ?? basenameOfPath(outputPath),
            ...currentDeviceMeta(),
          }),
          download: null,
        });
        // Web版と同じ理由(上のコメント参照)で、第2引数trueを渡す。
        void openFileRef.current(outputPath, true);
      }).then((fn) => {
        unlistenDone = fn;
      });
      void onConversionFailed(reportConversionFailure).then((fn) => {
        unlistenFailed = fn;
      });
    }

    if (isTauriEnvironment()) {
      fetchSupportsCustomTempDir()
        .then(setSupportsCustomTempDirState)
        .catch((e: unknown) => console.error("supportsCustomTempDir failed", e));
    }

    renderer.onStatsUpdate((s) => {
      setStats(s);
      // タスクB(ADR-0009)の自動調整は`PointCloudRenderer`の内部でpointBudgetを
      // 直接書き換える(setPointBudget()を経由しない)ので、UI側の表示値は
      // 手動設定時と同じくstatsから同期する。これで「自動調整中は数値が自分で
      // 動く」ことがLayerPanelの点予算欄にそのまま表れる(最大STATS_INTERVAL_MSの
      // 遅延はあるが、手動設定の直後はsetPointBudget側で即時反映するので体感の
      // ずれはない)。
      setPointBudgetState(s.pointBudget);
      setAutoPointBudgetEnabledState(s.autoPointBudgetEnabled);
      // GUIを目視できない環境でも`npm run tauri dev`のRust側stdoutから
      // 描画点数・ロード中ノード数・fpsを追えるようにする（M1-4の必須要件）。
      const fmt3 = (v: readonly [number, number, number]) => `[${v.map((x) => x.toFixed(2)).join(",")}]`;
      const summary =
        `[M1] drawnPoints=${s.drawnPoints} drawnNodes=${s.drawnNodes} ` +
        `loadingNodes=${s.loadingNodes} queuedNodes=${s.queuedNodes} ` +
        `cachedNodes=${s.cachedNodes} fps=${s.fps.toFixed(1)} pointBudget=${s.pointBudget} ` +
        // タスクB(ADR-0009):「現在値を画面に出す」の一環。自動調整中かどうかを
        // stdoutだけでも確認できるようにする。
        `autoPointBudget=${s.autoPointBudgetEnabled} ` +
        // M2-0c: 空/グリッドの有無でfpsを比較できるよう、一緒に出す。
        `backgroundMode=${s.backgroundMode} gridEnabled=${s.gridEnabled} ` +
        // M2-1: EDLのオン/オフ・強さの切り替えがrendererまで届いているかを、
        // 陰影の見た目を目視する前にstdoutだけでも確認できるようにする。
        `edlEnabled=${s.edlEnabled} edlStrength=${s.edlStrength.toFixed(2)} ` +
        // 複数レイヤー(L1-C): 着色はレイヤーごとになったので、統計にはレイヤー数を出す。
        `layers=${s.visibleLayerCount}/${s.layerCount} ` +
        // M3-8: モバイル最適化の各手段の現在値。所有者が実機で1つずつ切り替えて
        // 効果を確かめる際、GUIの設定画面と同じ値をstdout(logcat経由も含む)からも
        // 確認できるようにする。
        `renderScale=${s.renderScale} pointShape=${s.pointShape} isMobile=${s.isMobile} pointBudgetMax=${s.pointBudgetMax} ` +
        // ADR-0010追記: 中央優先度の強さがUIからrendererまで届いているかを、
        // 画面の目視確認の前にstdoutだけでも確認できるようにする。
        `centerPriorityStrength=${s.centerPriorityStrength.toFixed(2)} ` +
        // 2026-10-08追記: 下限もスライダーで変えられるようにしたので、同様に
        // stdoutで確認できるようにする。
        `minCenterPriorityWeight=${s.minCenterPriorityWeight.toFixed(2)} ` +
        // M2-0b: GUIを目視できなくても、pitch=0が水平になっているか等をstdoutだけで
        // 機械的に確認できるようにカメラの向きも出す。
        `pitch=${s.cameraPitch.toFixed(3)} yaw=${s.cameraYaw.toFixed(3)} ` +
        `upAxis=${fmt3(s.cameraUpAxis)} eye=${fmt3(s.cameraEye)}`;
      reportToBackendConsole(summary).catch((e) => console.error("reportToBackendConsole failed", e));
    });

    // WebGPUのエラーを画面に出す仕組み（ADR-0011）。EDL(M2-1)の事故で「テスト・CIは
    // すべて緑なのに画面は真っ黒になった」という反省から、rendererが拾った
    // エラーを蓄積・重複抑制した上でUI(GpuErrorBanner)へ渡す。実際の蓄積ロジックは
    // GpuErrorLogに任せ、ここではlist()のスナップショットをstateにコピーするだけ。
    renderer.onGpuErrorReported((message) => {
      gpuErrorLogRef.current.report(message);
      setGpuErrors(gpuErrorLogRef.current.list());
      recordErrorHistory(gpuErrorLogRef.current.list());
      // GUIを目視できない環境でも、devtoolsを開かなくてもRust側stdoutから
      // WebGPUのエラーを追えるようにする（onStatsUpdateのstdout連携と同じ狙い）。
      reportToBackendConsole(`[gpu-error] ${message}`).catch((e) =>
        console.error("reportToBackendConsole failed", e),
      );
    });

    // M3(ADR-0013): pcv://のノード読み出し失敗も同じGpuErrorLog/バナーに乗せる。
    // 所有者の実機で「複数ノードを扱うと落ちる」報告があり、原因がRust側の
    // panicだった場合はcatch_unwindで捕まえてHTTP 500+メッセージを返すように
    // なった（src-tauri/src/copc_state.rs）。上のGPUエラーと同じ形でsourceだけ
    // "node-read"にする（gpu-error-log.tsのreport()第3引数）。
    renderer.onNodeLoadErrorReported((message) => {
      gpuErrorLogRef.current.report(message, undefined, "node-read");
      setGpuErrors(gpuErrorLogRef.current.list());
      recordErrorHistory(gpuErrorLogRef.current.list());
      reportToBackendConsole(`[node-load-error] ${message}`).catch((e) =>
        console.error("reportToBackendConsole failed", e),
      );
    });

    let cancelled = false;
    renderer
      .init()
      .then(() => {
        if (cancelled) return;
        renderer.start();
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });

    const onResize = () => {
      renderer.resize(canvas.clientWidth, canvas.clientHeight);
    };
    window.addEventListener("resize", onResize);
    onResize();

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      unlistenProgress();
      unlistenDone();
      unlistenFailed();
    };
    // setPendingConversionは依存配列を空にしたuseCallbackで作った安定参照
    // なので、ここに加えてもこのeffectの「マウント時に1度だけ」という性質は
    // 変わらない(react-hooks/exhaustive-deps対応)。
  }, [setPendingConversion]);

  /**
   * Open `path` with the DataSource and add it to the renderer and the list as a new layer (the new layer
   * becomes the selection). Shared by `openFile` and by the tool results (L2-F). Returns the layer id.
   * `isConversionContinuation`: attach the pending conversion result (name, breakdown, download) to this layer.
   */
  const addOpenedLayer = useCallback(
    async (
      path: string,
      fallbackName: string,
      isConversionContinuation: boolean,
    ): Promise<{ layerId: string; pointCount: number; nodeCount: number }> => {
      const renderer = rendererRef.current;
      const source = sourceRef.current;
      if (!renderer || !source) throw new Error("ビューアが初期化されていません");
      const opened = await source.open(path);
      // L1-D: 開いたものは常に新しいレイヤーとして足す（置き換えない）。足したレイヤーは選択になる。
      // 着色の初期値はRGBがあれば"rgb"、無ければ標高（colormap.tsの`resolveColorMode`/
      // `FALLBACK_COLOR_MODE_WITHOUT_RGB`参照）。rendererは`resolveColorMode`を知らず、
      // 渡された値をそのまま使うだけの設計。
      // renderer は cloudId を知らない。レイヤーごとに cloudId を閉じ込めた readNode を渡す。
      // 標高の範囲はCloudInfo.min/max（実データ範囲）を渡す
      // （ノードのbounds=立方体ではない。renderer側の`addLayer`のコメント参照）。
      const layerId = `layer-${nextLayerNumberRef.current++}`;
      const colorMode = initialColorModeFor(opened.info);
      // 変換から続けて開いたときだけ、保留中の内訳・ダウンロードをこのレイヤーに付ける。
      const pending = isConversionContinuation ? pendingConversionRef.current : null;
      if (pending) pendingConversionRef.current = null;
      renderer.addLayer(layerId, {
        hierarchy: opened.nodes,
        readNode: (key) => source.readNode(opened.cloudId, key),
        boundsMin: opened.info.min,
        boundsMax: opened.info.max,
        colorMode,
        visible: true,
        pointShape: deviceProfileDefaults.pointShape,
        pointSizePx: DEFAULT_POINT_SIZE_PX,
      });
      commitLayers(
        addLayerToState(layersStateRef.current, {
          id: layerId,
          name: pending?.name ?? fallbackName,
          info: opened.info,
          nodeCount: opened.nodes.length,
          visible: true,
          colorMode,
          pointShape: deviceProfileDefaults.pointShape,
          pointSize: DEFAULT_POINT_SIZE_PX,
          cloudId: opened.cloudId,
          sourcePath: path,
          conversionBreakdownText: pending?.breakdownText ?? null,
          download: pending?.download ?? null,
        }),
      );
      // CRSの読み取り失敗はファイルを開くことを止めない(ADR-0015)。本文はエラーログへ。
      if (opened.info.crs.error) {
        gpuErrorLogRef.current.report(`座標系(CRS)を読み取れませんでした: ${opened.info.crs.error}`, undefined, "crs");
        setGpuErrors(gpuErrorLogRef.current.list());
        recordErrorHistory(gpuErrorLogRef.current.list());
      }
      return { layerId, pointCount: opened.info.pointCount, nodeCount: opened.nodes.length };
    },
    [commitLayers, deviceProfileDefaults.pointShape],
  );

  const openFile = useCallback(async (pathOrFile: string | File, isConversionContinuation = false) => {
    const renderer = rendererRef.current;
    const source = sourceRef.current;
    if (!renderer || !source) return;

    setStatus("opening");
    setError(null);
    setConversionProgress(null);
    try {
      // Web版のローカルファイル選択は`File`を受け取る。`DataSource.open()`は
      // 文字列しか取らないので、先に`WebSource.registerFile()`でキーへ変換する
      // （TauriSourceにはFileを渡す経路が無い。ファイル選択UIはWeb版でしか
      // 出さないので、ここに来る時点でsourceは必ずWebSourceのはず）。
      let path: string;
      if (typeof pathOrFile === "string") {
        path = pathOrFile;
      } else if (source instanceof WebSource) {
        // M4-6b: 拡張子ではなくヘッダーで判定し(`copc-header.ts`、Rust側の
        // `copc_detect.rs`と同じ考え方)、既にCOPCならそのまま開く。生の
        // LAS/LAZならWeb版でも変換する(OPFS上、`WebSource.startConversion`)。
        if (await isCopcFile(pathOrFile)) {
          path = source.registerFile(pathOrFile);
        } else {
          // M4-9追記: 形式を先に判定してから変換経路を選ぶ(実機不具合の修正:
          // 以前はCOPCでないファイルを全てLAS/LAZ変換の経路に回しており、
          // PCD(非圧縮・f64座標)がLAS/LAZ向けの容量見積もりで誤って
          // 「空き容量不足」と判定されていた)。PLY/E57はこのセッションでは
          // Web版の変換経路をまだ用意していない(`TaskSheets/
          // M4-import-and-conversion.md`のM4-9/M4-6参照。pcd-rs・e57クレート
          // 自体はwasm32でビルドできることを確認済みだが、実装は見送った)ため、
          // 誤解を招く容量チェックを試みず、ここで案内を出して終える。
          const format = detectSourceFormatByName(pathOrFile.name);
          if (format === "ply" || format === "e57") {
            setStatus("error");
            setError(
              `このファイル形式(${format.toUpperCase()})はWeb版ではまだ変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。`,
            );
            return;
          }
          // M4-12: 内訳テキストに入れる元ファイル名を、変換完了時のハンドラが
          // 読めるように覚えておく(マウント時に1度だけ張る`onConvertDone`の
          // クロージャはこの呼び出しのスコープを知らないため)。
          convertingSourceNameRef.current = pathOrFile.name;
          setConvertingFileName(pathOrFile.name);
          const outcome =
            format === "pcd"
              ? await source.startPcdConversion(pathOrFile, deviceProfileDefaults.isMobile)
              : await source.startConversion(pathOrFile, deviceProfileDefaults.isMobile);
          switch (outcome.kind) {
            case "alreadyCopc":
              // startConversion自身はこの値を返さない設計(呼び出し前に
              // isCopcFileで判定済みのため)だが、型の網羅性のために残す。
              path = outcome.path;
              break;
            case "cached":
              path = outcome.outputPath;
              break;
            case "opfsUnavailable":
              setStatus("error");
              setError(
                "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。",
              );
              return;
            case "insufficientSpace":
              // `ConversionOutcome`はTauri版と共有の型だが、`WebSource`の
              // `startConversion`/`startPcdConversion`はこの形(デスクトップ版、
              // `availableBytes`がOSの実際の空きディスク)を返さず、常に下の
              // "insufficientSpaceWeb"を返す(`web.ts`の`checkInsufficientSpace`
              // 参照)。型の網羅性のためだけに置く、到達しないはずの分岐。
              setStatus("error");
              setError("空き容量が足りません");
              return;
            // M4-6追記: Web版は(デスクトップ版と中身の違う)"insufficientSpaceWeb"を返す。
            case "insufficientSpaceWeb": {
              const message = describeInsufficientSpaceWeb({
                requiredBytes: outcome.requiredBytes,
                quotaBytes: outcome.quotaBytes,
                usageBytes: outcome.usageBytes,
                persisted: outcome.persisted,
                reclaimableBytes: outcome.reclaimableBytes,
              });
              gpuErrorLogRef.current.report(message, undefined, "conversion");
              setGpuErrors(gpuErrorLogRef.current.list());
              recordErrorHistory(gpuErrorLogRef.current.list());
              setStatus("error");
              setError("空き容量が足りません");
              // 消す・永続化を許可する等の導線(設定画面)を出す前に、現在の
              // 使用量を反映しておく(受け入れ条件「消したあと見積もりが更新される」
              // の前提として、まず現在値を持たせる)。
              void refreshOpfsStorageInfo();
              return;
            }
            case "converting":
              // 実際に開く処理はonConvertDoneのイベントハンドラが続きを行う
              // (マウント時のuseEffect参照)。
              setStatus("converting");
              return;
          }
        }
      } else {
        throw new Error("ローカルファイルの選択はWeb版でのみサポートしています");
      }

      // M4-3: Tauri版(デスクトップ・Android)は、開く前に必ず
      // start_las_conversionを経由する。既にCOPCならヘッダーを読むだけの
      // 軽い処理で即座に`alreadyCopc`が返る(受け入れ条件「既にCOPCのファイルは
      // 即座に開く」)。生LAS/LAZなら変換済みキャッシュがあるか確認し
      // (`cached`)、無ければ空き容量を確かめてから変換を開始する
      // (`converting`。この場合はここで一旦return し、実際に開く処理は
      // マウント時に張った`onConversionDone`が`openFileRef`経由で続きを行う)。
      if (source instanceof TauriSource) {
        // M4-12: Web版と同じ理由(直前のコメント参照)。
        convertingSourceNameRef.current = basenameOfPath(path);
        setConvertingFileName(basenameOfPath(path));
        const outcome = await startLasConversion(path, tempDir);
        switch (outcome.kind) {
          case "alreadyCopc":
            path = outcome.path;
            break;
          case "cached":
            path = outcome.outputPath;
            break;
          case "insufficientSpace": {
            const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
            gpuErrorLogRef.current.report(
              `空き容量が足りません(必要: 約${toGiB(outcome.requiredBytes)}GiB、空き: 約${toGiB(outcome.availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`,
              undefined,
              "conversion",
            );
            setGpuErrors(gpuErrorLogRef.current.list());
            recordErrorHistory(gpuErrorLogRef.current.list());
            setStatus("error");
            setError("空き容量が足りません");
            return;
          }
          case "converting":
            // 実際に開く処理はonConversionDoneのイベントハンドラが続きを行う。
            setStatus("converting");
            return;
        }
      }

      // レイヤー欄に出す名前: 変換結果ならその名前（addOpenedLayerが保留中の結果から取る）、
      // Tauri版のパス・Web版のURLは最後の区切り以降、選択したFileはそのままname。
      const opened = await addOpenedLayer(path, typeof pathOrFile === "string" ? basenameOfPath(pathOrFile) : pathOrFile.name, isConversionContinuation);
      setStatus("ready");

      const label = typeof pathOrFile === "string" ? pathOrFile : pathOrFile.name;
      const summary = `[M1] opened ${label}: points=${opened.pointCount} nodes=${opened.nodeCount}`;
      console.log(summary);
      await reportToBackendConsole(summary);
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }, [tempDir, addOpenedLayer, deviceProfileDefaults.isMobile, refreshOpfsStorageInfo]);

  /**
   * M4-14: 複数ファイル選択時の入口。`openFile`とほぼ同じ判断
   * (キャッシュ・容量不足・変換開始)を行うが、対象が常にLAS/LAZ(複数)に
   * 絞られる分だけ単純になる(既にCOPCかどうかの判定・PCD/E57等の経路分岐は
   * 単一ファイル専用の`openFile`にしか無い)。
   */
  const openFiles = useCallback(async (pathsOrFiles: string[] | File[]) => {
    if (pathsOrFiles.length === 0) return;
    if (pathsOrFiles.length === 1) {
      await openFileRef.current(pathsOrFiles[0]);
      return;
    }

    const renderer = rendererRef.current;
    const source = sourceRef.current;
    if (!renderer || !source) return;

    setStatus("opening");
    setError(null);
    setConversionProgress(null);

    const isFileArray = typeof pathsOrFiles[0] !== "string";
    const names = isFileArray
      ? (pathsOrFiles as File[]).map((f) => f.name)
      : (pathsOrFiles as string[]).map(basenameOfPath);

    // 受け入れ条件: LAS/LAZの混在はOK、PLY/PCD/E57が混じっていたら変換を
    // 試みる前に明確なエラーを出す(ファイル名を挙げる)。
    const nonLasNames = names.filter((n) => detectSourceFormatByName(n) !== "lasLaz");
    if (nonLasNames.length > 0) {
      setStatus("error");
      setError(
        `複数ファイルの選択はLAS/LAZのみ対応しています。次のファイルは対象外です: ${nonLasNames.join("、")}`,
      );
      return;
    }

    // M4-12と同じ理由(`openFile`参照): 内訳テキストの「ファイル」欄に使う
    // 表示名を、変換開始前に覚えておく。選択順に依存しない表示にするため
    // 昇順ソートしてから組み立てる(要件の表示例「09LD2626 ほか54ファイル」)。
    convertingSourceNameRef.current = multiDisplayNameFor([...names].sort());
    setConvertingFileName(convertingSourceNameRef.current);

    try {
      const outcome =
        isFileArray && source instanceof WebSource
          ? await source.startMultiConversion(pathsOrFiles as File[], deviceProfileDefaults.isMobile)
          : !isFileArray && source instanceof TauriSource
            ? await startMultiLasConversion(pathsOrFiles as string[], tempDir)
            : null;
      if (outcome === null) {
        throw new Error("複数ファイルの選択はこの環境では対応していません");
      }

      switch (outcome.kind) {
        case "cached":
          void openFileRef.current(outcome.outputPath, true);
          return;
        case "converting":
          setStatus("converting");
          return;
        case "opfsUnavailable":
          setStatus("error");
          setError(
            "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でまとめてCOPC(.copc.laz)に変換してから開いてください。",
          );
          return;
        case "insufficientSpace": {
          const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
          gpuErrorLogRef.current.report(
            `空き容量が足りません(必要: 約${toGiB(outcome.requiredBytes)}GiB、空き: 約${toGiB(outcome.availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`,
            undefined,
            "conversion",
          );
          setGpuErrors(gpuErrorLogRef.current.list());
          recordErrorHistory(gpuErrorLogRef.current.list());
          setStatus("error");
          setError("空き容量が足りません");
          return;
        }
        case "insufficientSpaceWeb": {
          const message = describeInsufficientSpaceWeb({
            requiredBytes: outcome.requiredBytes,
            quotaBytes: outcome.quotaBytes,
            usageBytes: outcome.usageBytes,
            persisted: outcome.persisted,
            reclaimableBytes: outcome.reclaimableBytes,
          });
          gpuErrorLogRef.current.report(message, undefined, "conversion");
          setGpuErrors(gpuErrorLogRef.current.list());
          recordErrorHistory(gpuErrorLogRef.current.list());
          setStatus("error");
          setError("空き容量が足りません");
          void refreshOpfsStorageInfo();
          return;
        }
        case "alreadyCopc":
          // 複数ファイルのマージ経路では、呼び出し側(Rust/wasm)がこの値を
          // 返すことは無い(常に新しいCOPCを作る)。型の網羅性のためだけに
          // 置く、到達しないはずの分岐(`openFile`の同種のコメント参照)。
          void openFileRef.current(outcome.path, true);
          return;
      }
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }, [tempDir, deviceProfileDefaults.isMobile, refreshOpfsStorageInfo]);

  // `openFileRef`を毎レンダー最新化する。マウント時に一度だけ張るイベント
  // 購読(上のuseEffect、deps=[])から常に最新の`openFile`(最新の
  // tempDirを閉じ込めたもの)を呼べるようにするための、定番の対処。
  useEffect(() => {
    openFileRef.current = openFile;
  });

  const setPointBudget = useCallback((budget: number) => {
    setPointBudgetState(budget);
    // ADR-0009:「手で変えたら自動調整は止まる」。renderer.setPointBudget()自体が
    // 内部でautoPointBudgetEnabledをfalseにするが、その反映は次のstats更新
    // (最大STATS_INTERVAL_MS=500ms後)まで待つと「黙って切り替わった」ように
    // 見えてしまう。ここで同期的にfalseへ倒し、LayerPanelのチェックボックスが
    // 即座に外れるようにする。
    setAutoPointBudgetEnabledState(false);
    rendererRef.current?.setPointBudget(budget);
  }, []);

  const setAutoPointBudgetEnabled = useCallback((enabled: boolean) => {
    setAutoPointBudgetEnabledState(enabled);
    rendererRef.current?.setAutoPointBudgetEnabled(enabled);
  }, []);

  const setBackgroundMode = useCallback((mode: BackgroundMode) => {
    setBackgroundModeState(mode);
    rendererRef.current?.setBackgroundMode(mode);
  }, []);

  const setGridEnabled = useCallback((enabled: boolean) => {
    setGridEnabledState(enabled);
    rendererRef.current?.setGridEnabled(enabled);
  }, []);

  // UIのCSSアニメーション(AN-3)も同じ設定で止める: <html data-motion="off">(index.css)。
  useEffect(() => {
    applyMotionAttribute(document.documentElement, animationEnabled);
  }, [animationEnabled]);

  const setAnimationEnabled = useCallback((enabled: boolean) => {
    setAnimationEnabledState(enabled);
    rendererRef.current?.setAnimationEnabled(enabled);
    storeAnimationEnabled(getLocalStorage(), enabled);
  }, []);

  // 選択中のレイヤーへ戻る（別々の場所のファイルでは、全レイヤーの合併は意味を成さないため。renderer の resetView 参照）。
  const resetView = useCallback(() => {
    rendererRef.current?.resetView(layersStateRef.current.selectedLayerId ?? undefined);
  }, []);

  const setEdlEnabled = useCallback((enabled: boolean) => {
    setEdlEnabledState(enabled);
    rendererRef.current?.setEdlEnabled(enabled);
  }, []);

  const setRenderScale = useCallback((scale: number) => {
    setRenderScaleState(scale);
    rendererRef.current?.setRenderScale(scale);
  }, []);

  const setPointShape = useCallback((shape: PointShape) => {
    setPointShapeState(shape);
    rendererRef.current?.setPointShape(shape);
  }, []);

  const setCenterPriorityStrength = useCallback((strength: number) => {
    setCenterPriorityStrengthState(strength);
    rendererRef.current?.setCenterPriorityStrength(strength);
  }, []);

  const setMinCenterPriorityWeight = useCallback((minWeight: number) => {
    setMinCenterPriorityWeightState(minWeight);
    rendererRef.current?.setMinCenterPriorityWeight(minWeight);
  }, []);

  // L1-D: レイヤー操作。renderer に伝え、同じ内容を一覧（state）にも入れる。
  const selectLayer = useCallback(
    (id: string) => {
      setExtraSelectedIds([]);
      commitLayers(selectLayerInState(layersStateRef.current, id));
    },
    [commitLayers],
  );

  const setLayerVisible = useCallback(
    (id: string, visible: boolean) => {
      const current = layersStateRef.current;
      if (!findLayer(current.layers, id)) return;
      rendererRef.current?.setLayerVisible(id, visible);
      commitLayers({ ...current, layers: setLayerVisibleInList(current.layers, id, visible) });
    },
    [commitLayers],
  );

  const setLayerColorMode = useCallback(
    (id: string, mode: ColorMode) => {
      const current = layersStateRef.current;
      // そのレイヤーがRGBを持たない場合は、"rgb"を選ぼうとしても標高へ落とす
      // （受け入れ条件「RGBを持たない点群ではRGBが選べないか、選んだときに分かる形で別モードに
      // 落ちる」）。着色ダイアログでも"rgb"の選択肢自体をdisabledにしているため、通常はここに
      // 到達しないが、二重の安全策として関数側でも解決する（理由はcolormap.tsのコメント参照）。
      const resolved = resolveLayerColorMode(current.layers, id, mode);
      const target = findLayer(current.layers, id);
      if (resolved === null || !target || isMeasureLayer(target)) return; // measurement layers have no coloring
      rendererRef.current?.setLayerColorMode(id, resolved);
      commitLayers({ ...current, layers: setLayerColorModeInList(current.layers, id, mode) });
    },
    [commitLayers],
  );

  const setLayerPointShape = useCallback(
    (id: string, shape: PointShape) => {
      const current = layersStateRef.current;
      if (!findLayer(current.layers, id)) return;
      rendererRef.current?.setLayerPointShape(id, shape);
      commitLayers({ ...current, layers: setLayerPointShapeInList(current.layers, id, shape) });
    },
    [commitLayers],
  );

  const setLayerPointSize = useCallback(
    (id: string, px: number) => {
      const current = layersStateRef.current;
      if (!findLayer(current.layers, id)) return;
      rendererRef.current?.setLayerPointSize(id, px);
      commitLayers({ ...current, layers: setLayerPointSizeInList(current.layers, id, px) });
    },
    [commitLayers],
  );

  const focusLayer = useCallback((id: string, orientation?: { yaw: number; pitch: number }) => {
    const layer = findLayer(layersStateRef.current.layers, id);
    if (layer?.measurement) {
      // A measurement layer is not in the renderer: move to the box around its points (L2-F).
      rendererRef.current?.focusBox(layer.info.min, layer.info.max);
      return;
    }
    rendererRef.current?.focusLayer(id, orientation);
  }, []);

  // ===== L2-F: selecting several layers =====
  const selectedLayerIds = effectiveSelectedIds(layersState.layers, layersState.selectedLayerId, extraSelectedIds);

  const toggleLayerSelection = useCallback(
    (id: string) => {
      const current = layersStateRef.current;
      const next = toggleSelectedId(current.layers, current.selectedLayerId, extraSelectedIds, id);
      setExtraSelectedIds(next.ids);
      commitLayers({ ...current, selectedLayerId: next.primaryId });
    },
    [commitLayers, extraSelectedIds],
  );

  const selectLayerRange = useCallback(
    (id: string) => {
      const current = layersStateRef.current;
      setExtraSelectedIds(rangeSelectedIds(current.layers, current.selectedLayerId, id));
      // The primary stays the anchor, unless nothing was selected yet.
      commitLayers(selectLayerInState(current, current.selectedLayerId ?? id));
    },
    [commitLayers],
  );

  const removeLayer = useCallback(
    (id: string) => {
      const current = layersStateRef.current;
      const layer = findLayer(current.layers, id);
      if (!layer) return;
      // renderer から外す（GPUバッファの解放）→ 一覧から消す → DataSource のファイルを閉じる。
      rendererRef.current?.removeLayer(id);
      if (layer.download) URL.revokeObjectURL(layer.download.url);
      const next = removeLayerFromState(current, id);
      commitLayers(next);
      if (next.layers.length === 0) {
        setStatus((prev) => (prev === "ready" ? "idle" : prev));
      }
      // Measurement layers have no DataSource file.
      if (isMeasureLayer(layer)) return;
      sourceRef.current?.close(layer.cloudId).catch((e: unknown) => {
        gpuErrorLogRef.current.report(`ファイルを閉じられませんでした: ${String(e)}`, undefined, "node-read");
        setGpuErrors(gpuErrorLogRef.current.list());
        recordErrorHistory(gpuErrorLogRef.current.list());
      });
    },
    [commitLayers],
  );

  // ===== L2-F: point-cloud tools (select by polygon, cross section, merge) =====
  // ADR-0018: each tool reads the chosen layers' files and writes a NEW COPC, which is opened as a new layer.
  // The source layers are never changed. Rust does the work (desktop: Tauri command, Web: Worker + OPFS).

  /** Show a tool failure or warning in the existing error display (ADR-0011), with the text as it is. */
  const reportToolMessage = useCallback((message: string) => {
    gpuErrorLogRef.current.report(message, undefined, "tool");
    setGpuErrors(gpuErrorLogRef.current.list());
    recordErrorHistory(gpuErrorLogRef.current.list());
  }, []);

  /**
   * Run one tool: show progress, open the result as a new layer, send warnings and failures to the error log.
   * `viewNormal` (cross section only): after opening, look at the result from that horizontal direction.
   */
  const runTool = useCallback(
    async (
      title: string,
      resultName: string,
      run: (source: DataSource, options: ToolOptions) => Promise<ToolResult>,
      viewNormal?: readonly [number, number, number],
    ) => {
      const source = sourceRef.current;
      if (!source) return;
      if (toolRunningRef.current) {
        reportToolMessage("別の点群ツールを実行中です。終わってからやり直してください");
        return;
      }
      toolRunningRef.current = true;
      setToolProgress({ title, pointsRead: 0, totalPoints: 0 });
      try {
        const result = await run(source, {
          tempDir,
          onProgress: (p) => setToolProgress({ title, pointsRead: p.pointsRead, totalPoints: p.totalPoints }),
        });
        for (const warning of result.warnings) reportToolMessage(warning);
        const { layerId } = await addOpenedLayer(result.outputPath, resultName, false);
        setStatus("ready");
        if (viewNormal) {
          const up = rendererRef.current?.getViewSnapshot()?.up ?? [0, 0, 1];
          const { right, forward } = horizontalBasis(up);
          focusLayer(layerId, { yaw: sectionYaw(viewNormal, right, forward), pitch: 0 });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        reportToolMessage(message.includes("キャンセル") ? `${title}をキャンセルしました` : message);
      } finally {
        toolRunningRef.current = false;
        setToolProgress(null);
      }
    },
    [tempDir, addOpenedLayer, focusLayer, reportToolMessage],
  );

  const extractFromLayer = useCallback(
    async (layerId: string, filter: ExtractFilter, label: "選択" | "断面", viewNormal?: readonly [number, number, number]) => {
      const layer = findLayer(layersStateRef.current.layers, layerId);
      if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
        reportToolMessage("点群のレイヤーを選んでください");
        return;
      }
      const path = layer.sourcePath;
      await runTool(
        `${label}（${layer.name}）`,
        `${label} - ${layer.name}`,
        (source, options) => (source instanceof WebSource ? source.extractToCopc(path, filter, options) : tauriExtractToCopc(path, filter, options)),
        viewNormal,
      );
    },
    [runTool, reportToolMessage],
  );

  const mergeSelectedLayers = useCallback(async () => {
    const current = layersStateRef.current;
    const sources = toolSourceLayers(current.layers, effectiveSelectedIds(current.layers, current.selectedLayerId, extraSelectedIds));
    if (sources.length < 2) {
      reportToolMessage("結合するには点群のレイヤーを2つ以上選んでください（Ctrl か Shift を押しながらクリック）");
      return;
    }
    const paths = sources.map((l) => l.sourcePath as string);
    const isMobile = deviceProfileDefaults.isMobile;
    await runTool(
      `結合（${sources.length}レイヤー）`,
      `結合 (${sources.length})`,
      (source, options) => (source instanceof WebSource ? source.mergeCopcs(paths, { ...options, isMobile }) : tauriMergeCopcs(paths, options)),
    );
  }, [runTool, reportToolMessage, extraSelectedIds, deviceProfileDefaults.isMobile]);

  const cancelTool = useCallback(() => {
    const source = sourceRef.current;
    if (source instanceof WebSource) {
      source.cancelConversion();
      return;
    }
    cancelLasConversion().catch((e: unknown) => console.error("cancelLasConversion failed", e));
  }, []);

  // ===== L2-D: measurement =====
  // Picking and fetching the view pass straight through to the renderer. The measurement operation
  // (collecting points, finishing) is in useMeasureTool.ts; a finished one is added as a new layer by addMeasurement.

  const pickPoint = useCallback(async (cssX: number, cssY: number) => {
    try {
      return (await rendererRef.current?.pickPoint(cssX, cssY)) ?? null;
    } catch (e) {
      // If reading the depth back fails, send the message as-is to the existing error display (ADR-0011). Never swallow it.
      gpuErrorLogRef.current.report(`計測の点を取れませんでした: ${String(e)}`);
      setGpuErrors(gpuErrorLogRef.current.list());
      recordErrorHistory(gpuErrorLogRef.current.list());
      return null;
    }
  }, []);

  const getViewSnapshot = useCallback(() => rendererRef.current?.getViewSnapshot() ?? null, []);

  const measureCountersRef = useRef({ distance: 0, height: 0, area: 0 });

  const addMeasurement = useCallback(
    (measurement: Measurement) => {
      const current = layersStateRef.current;
      // Source point-cloud layer (ADR-0018: made from the chosen layer): the selection if it is a point cloud,
      // otherwise the first point-cloud layer. Used only to inherit the coordinate system (unit).
      const selected = findLayer(current.layers, current.selectedLayerId);
      const source = selected && !isMeasureLayer(selected) ? selected : (current.layers.find((l) => !isMeasureLayer(l)) ?? null);
      const counters = measureCountersRef.current;
      counters[measurement.kind] += 1;
      const layerId = `layer-${nextLayerNumberRef.current++}`;
      const name = `${MEASURE_KIND_NAME[measurement.kind]} ${counters[measurement.kind]}`;
      commitLayers(addLayerToState(current, makeMeasureLayer(layerId, name, measurement, source)));
    },
    [commitLayers],
  );

  const dismissGpuError = useCallback((id: number) => {
    gpuErrorLogRef.current.dismiss(id);
    setGpuErrors(gpuErrorLogRef.current.list());
  }, []);

  const cancelConversion = useCallback(() => {
    const source = sourceRef.current;
    if (source instanceof WebSource) {
      // M4-6b: fire-and-forgetのメッセージ(`web-protocol.ts`のConvertCancelRequest)。
      // 読み込みバッチの合間で反映される(`crates/pcv-wasm/src/convert.rs`の
      // ドキュメント参照。後処理段階には割り込めない)。
      source.cancelConversion();
      return;
    }
    cancelLasConversion().catch((e: unknown) => {
      // 変換が既に終わっていた等、キャンセルが間に合わなかっただけなので
      // ログに残す程度でよい(ユーザーに新たなエラーとして見せる必要は無い)。
      console.error("cancelLasConversion failed", e);
    });
  }, []);

  const setTempDir = useCallback((dir: string | null) => {
    setTempDirState(dir);
    try {
      if (dir === null) {
        localStorage.removeItem(TEMP_DIR_STORAGE_KEY);
      } else {
        localStorage.setItem(TEMP_DIR_STORAGE_KEY, dir);
      }
    } catch {
      // 保存できなくても動作に支障はない(次回起動時に既定値へ戻るだけ)。
    }
  }, []);

  const pickAndSetTempDir = useCallback(async () => {
    const picked = await pickTempDirectory();
    if (picked) setTempDir(picked);
  }, [setTempDir]);

  const clearTempDir = useCallback(() => setTempDir(null), [setTempDir]);

  const state: CopcViewerState = {
    status,
    error,
    layers: layersState.layers,
    selectedLayerId: layersState.selectedLayerId,
    selectedLayer: findLayer(layersState.layers, layersState.selectedLayerId),
    selectLayer,
    setLayerVisible,
    setLayerColorMode,
    setLayerPointShape,
    setLayerPointSize,
    focusLayer,
    selectedLayerIds,
    toggleLayerSelection,
    selectLayerRange,
    toolProgress,
    cancelTool,
    extractFromLayer,
    mergeSelectedLayers,
    removeLayer,
    pickPoint,
    getViewSnapshot,
    addMeasurement,
    pointBudget,
    autoPointBudgetEnabled,
    stats,
    backgroundMode,
    gridEnabled,
    edlEnabled,
    animationEnabled,
    renderScale,
    pointShape,
    centerPriorityStrength,
    minCenterPriorityWeight,
    gpuErrors,
    errorHistory,
    convertingFileName,
    openFile,
    openFiles,
    isBrowser: !isTauriEnvironment(),
    conversionProgress,
    cancelConversion,
    copyConversionBreakdownText,
    opfsStorageInfo,
    refreshOpfsStorageInfo,
    requestOpfsPersistentStorage,
    removeOpfsCachedConversion,
    clearOpfsCachedConversions,
    removeOpfsScratchDir,
    clearOpfsScratchDirs,
    tempDir,
    supportsCustomTempDir: supportsCustomTempDirState,
    pickAndSetTempDir,
    clearTempDir,
    setPointBudget,
    setAutoPointBudgetEnabled,
    setBackgroundMode,
    setGridEnabled,
    setEdlEnabled,
    setAnimationEnabled,
    resetView,
    setRenderScale,
    setPointShape,
    setCenterPriorityStrength,
    setMinCenterPriorityWeight,
    dismissGpuError,
  };
  return [canvasRef, state];
}
