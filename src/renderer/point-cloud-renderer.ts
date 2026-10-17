// 点群レンダラのフレームループとオーケストレーション。rAF・カメラ・統計・
// 点予算の自動調整の呼び出し、ローダー（`node-loader.ts`）との接続、そして
// 外部公開API（`PointCloudRenderer`クラス）を持つ。
//
// WebGPUのAPIを直接叩く処理（デバイス・パイプライン・テクスチャ・drawFrame）は
// `gpu-resources.ts`（`GpuResources`クラス）に、「このフレームでどのノードを
// 描くか」の判定は`node-selection.ts`（純粋関数`selectNodesForFrame`）に
// 分離してある。3ファイルへの分割の経緯・責務分担は`TaskSheets/ARCHITECTURE.md`
// を参照。このファイルはそれらを呼び出して束ねるだけで、WebGPUの型を直接
// 扱わない。
//
// 規約3（ARCHITECTURE.md）: このファイルはReactを知らない。canvasと`DataSource`だけを
// 受け取る。UIから触るときは `src/state/` を経由すること。

import type { HierarchyNodeInfo } from "../datasource/DataSource";
import { computeIntensityRange, type ParsedNode } from "../datasource/node-format";
import { StaleNodeRequestError } from "../datasource/stale-node-error";
import { attachOrbitControls, OrbitCamera } from "./orbit-camera";
import { flyToGoal, pickFlyToPoint } from "./fly-to";
import { multiply, perspective, type Mat4 } from "./mat4";
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
  depthToEyeDistance,
  nearestHit,
  refineDepthRange,
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
import { FAR, FOV_Y_RADIANS, GpuResources, NEAR, type DrawFrameOptions, type NodePointStyle } from "./gpu-resources";
import { DEFAULT_POINT_SIZE_PX, focusGoalFor, layerFocusBounds, sanitizePointSize } from "./layer-focus";
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

// WebGPUのエラーを画面に出す仕組み(ADR-0011)。蓄積・重複抑制のロジック自体は
// GPUに依存しないgpu-error-log.tsに切り出してあり、このファイルはWebGPUの
// APIから文字列を取り出して渡すだけにする(詳しい経緯はTaskSheets/
// ADR-0011-gpu-error-visibility.md参照)。
//
// M3(ADR-0013): pcv://のノード読み出し失敗も同じ仕組み(GpuErrorLog)に乗せる。
// NodeLoaderのonFailedをreportNodeLoadError()で受け、reportGpuErrorと同じ形の
// コールバック(onNodeLoadErrorReported)で外へ渡す。メッセージの組み立ては
// node-load-error.tsの純粋関数に任せる(詳しくはTaskSheets/ADR-0013参照)。

/**
 * タスクB（ADR-0009）: 自動調整（`evaluatePointBudget`）が動かせる下限。
 * 「これより粗いと点群として意味が無い」という経験的な最低ラインで、
 * 実測ではない。デスクトップ・モバイルで共通の絶対的な下限として扱う
 * （上限は端末ごとに変わるが、下限は変えていない）。
 *
 * 上限（`autoPointBudgetMax`、インスタンスフィールド）は、M3-8で
 * `device-profile.ts`の`defaultRenderSettings()`が返す値を使うように変わった。
 * 以前はここでモジュール定数として1GiBから直接計算していたが、モバイルでは
 * `navigator.deviceMemory`から算出した別の予算を使う必要があるため、
 * 「デスクトップかどうか」を知っている`defaultRenderSettings()`に計算を
 * 一本化した（コンストラクタ参照。デスクトップの計算式・値そのものは
 * device-profile.tsのコメントに書いた通り、以前とまったく同じ）。
 */
const AUTO_POINT_BUDGET_MIN = 200_000;

/** 自動調整の判断に使う直近フレームの本数。ADR-0009:「判断は数フレームの中央値で
 *  行う。単発の重いフレーム（ノード到着時など）に反応しない」。 */
const AUTO_POINT_BUDGET_FRAME_HISTORY = 20;
/** まだ1フレームも記録していない起動直後だけ使うフォールバック値。
 *  `updateRefreshIntervalEstimate`で実際の値が1回でも記録されればすぐに
 *  上書きされる（60Hz相当を仮の初期値にしているだけで、決め打ちの目標では
 *  ない）。 */
const FALLBACK_REFRESH_INTERVAL_MS = 1000 / 60;
/** 統計をコールバックへ流す間隔(ms)。毎フレームだと呼び出し側(React state更新やRust
 *  stdoutへのinvoke)が重くなるため間引く。 */
const STATS_INTERVAL_MS = 500;
/** 自動点予算調整（タスクB）を実際に評価する間隔(ms)。毎フレーム評価すると
 *  変化が細かすぎて読みにくくなるため、統計更新と同じ間隔に間引く。 */
const AUTO_POINT_BUDGET_INTERVAL_MS = STATS_INTERVAL_MS;

/** M1-4: 描画点数・ロード中ノード数・fpsなど。GUIを目視できなくても
 *  `npm run tauri dev` のRust側stdoutから挙動を追えるようにするための統計。 */
export interface RenderStats {
  drawnPoints: number;
  drawnNodes: number;
  loadingNodes: number;
  queuedNodes: number;
  cachedNodes: number;
  fps: number;
  pointBudget: number;
  /** タスクB（ADR-0009）:「現在値を画面に出す。勝手に変わる仕組みは、何が
   *  起きているか見えないと不信になる」。点予算が自動調整中かどうかを含める。 */
  autoPointBudgetEnabled: boolean;
  /** M2-0c: 空の有無でfpsを比較できるよう、現在の背景モードを統計に含める。 */
  backgroundMode: BackgroundMode;
  /** M2-0c補強B: グリッドの有無でfpsを比較できるよう、現在のオン/オフを統計に含める。 */
  gridEnabled: boolean;
  /** M2-0b: GUIを目視できなくても`pitch=0`が水平になっているかを`npm run tauri dev`の
   *  stdoutだけで機械的に確認できるように、カメラの向きも統計に含める。 */
  cameraPitch: number;
  cameraYaw: number;
  cameraUpAxis: [number, number, number];
  cameraEye: [number, number, number];
  /** AN-2: カメラが慣性・ズーム・視点移動で動いている間true。 */
  cameraAnimating: boolean;
  /** HQ-2: カメラが止まったので、点予算を上限まで上げて読み込み・描画している最中。 */
  idleBoosting: boolean;
  /** M2-1: EDLのオン/オフと強さ。GUIを目視できなくても、UIの操作がrendererまで
   *  届いているかをstdoutで確認できるようにする（陰影が実際に効いているかどうか
   *  自体は目視でしか確認できないが、状態が正しく伝わっているかは機械的に見える）。 */
  edlEnabled: boolean;
  edlStrength: number;
  /** 複数レイヤー（L1-C）: 持っているレイヤーの数。着色はレイヤーごとになったので、
   *  以前ここにあった画面全体の`colorMode`はやめた（`getLayerColorMode`で個別に読める）。 */
  layerCount: number;
  /** 複数レイヤー（L1-C）: そのうち見えているレイヤーの数。 */
  visibleLayerCount: number;
  /** M3-8: モバイル最適化の各手段の現在値。GUIを目視できなくても
   *  `npm run tauri dev`のstdoutから確認できるようにする(既存のedlEnabled等と
   *  同じ狙い)。`isMobile`/`pointBudgetMax`は端末プロファイルから決まる値で、
   *  セッション中は変わらない(手動で変更する手段は今回設けていない)。 */
  renderScale: number;
  pointShape: PointShape;
  isMobile: boolean;
  pointBudgetMax: number;
  /** ADR-0010追記: 中央優先度の強さ。0なら今までどおり（画面空間誤差のみ）。 */
  centerPriorityStrength: number;
  /** 2026-10-08追記: 中央優先度の重みの下限。0なら下限無し（飢餓防止が効かない）。 */
  minCenterPriorityWeight: number;
}

/** `addLayer`に渡すもの。renderer は DataSource を知らない（呼び出し側が cloudId などを閉じ込めた `readNode` を渡す）。 */
export interface LayerInput {
  hierarchy: HierarchyNodeInfo[];
  readNode: (key: string) => Promise<ArrayBuffer>;
  /** CloudInfo.min / max（標高の範囲と、ダブルクリックで寄る先の切り取りに使う）。 */
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
  colorMode: ColorMode;
  visible: boolean;
  /** 点の形・大きさ（直径px）。省くと、形は`setPointShape`の既定値、大きさは`DEFAULT_POINT_SIZE_PX`。 */
  pointShape?: PointShape;
  pointSizePx?: number;
}

/** レイヤー1つ分の状態。外には出さない。 */
interface Layer {
  /** 呼び出し側が付けた id。 */
  id: string;
  /** 内部の通し番号。キャッシュ・ローダーのキーの前置きに使う（layer-key.ts）。 */
  serial: number;
  keyPrefix: string;
  hierarchy: HierarchyNodeInfo[];
  hierarchyByKey: Map<string, HierarchyNodeInfo>;
  readNode: (key: string) => Promise<ArrayBuffer>;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  /** ノードの bounds（octree セル）の和集合。カメラ・グリッド用（標高には使わない）。 */
  sceneBounds: SceneBounds | null;
  /** 標高の範囲（LAS ヘッダーの実データ範囲から）。 */
  elevationRange: ValueRange;
  /** 強度の範囲。ノードが届くたびに広げる。レイヤーごと（計測機が違うと幅が違うため）。 */
  intensityRange: ValueRange | null;
  colorMode: ColorMode;
  visible: boolean;
  /** 点の形・大きさ。レイヤーごと（L2-B）。描画のとき`nodeStyleOf`がノードのキーから引く。 */
  style: NodePointStyle;
  /** このレイヤーの着色設定の uniform。デバイス復帰で作り直すため、無いときは null。 */
  colorBuffer: GPUBuffer | null;
}

export class PointCloudRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: OrbitCamera;
  private detachControls: () => void = () => {};

  /** WebGPUのデバイス・パイプライン・テクスチャ・drawFrameの実体。
   *  WebGPUのAPIを直接叩くのはgpu-resources.tsだけにする（ARCHITECTURE.md）。 */
  private readonly gpu: GpuResources;

  /** 複数レイヤー（L1-C）: id → レイヤー。Map は挿入順を保つので、これが「レイヤーの並び順」。 */
  private readonly layers = new Map<string, Layer>();
  /** 通し番号 → レイヤー。読み込み結果が届いたとき、キーの前置きからレイヤーを引く。 */
  private readonly layersBySerial = new Map<number, Layer>();
  private nextLayerSerial = 1;
  /** 最後に`focusLayer`（足したときを含む）で移動したレイヤーの id。グリッドの高さ・大きさはこのレイヤーに合わせる。 */
  private focusedLayerId: string | null = null;
  private cache: NodeCache;
  private loader: NodeLoader | null = null;
  /** 直近フレームのviewProj。ホイールイベント（フレームの外で起きる）でカーソル位置の
   *  レイを作るために、フレームをまたいで持っておく（M1-5）。 */
  private lastViewProj: Mat4 | null = null;
  /** AN-2: ダブルクリックで寄るときのレイキャスト対象。直近フレームで実際に描いたノード。 */
  private lastDrawn: CachedNode[] = [];

  /** M3-8: コンストラクタで`defaultRenderSettings()`の`pointBudgetStart`から
   *  設定する（デスクトップは変更前と同じ値、モバイルはdeviceMemoryから算出）。 */
  private pointBudget: number;
  /** タスクB（ADR-0009）: 自動調整のオン/オフ。`setPointBudget()`で手動設定すると
   *  自動でoffになる（手動設定を自動調整より常に優先するため）。 */
  private autoPointBudgetEnabled = true;
  /** M3-8: 自動調整が動ける点予算の上限。コンストラクタで`defaultRenderSettings()`
   *  の`pointBudgetMax`から設定する（デスクトップは変更前と同じ値、モバイルは
   *  deviceMemoryから算出。詳細はdevice-profile.tsのコメント参照）。 */
  private readonly autoPointBudgetMax: number;
  /** 自動調整の判断に使う直近フレームの所要時間(ms)。`evaluatePointBudget`に
   *  ウィンドウごと渡し、「vsyncを落としたフレームの割合」を判定させる
   *  （単発の重いフレームに反応しないため。ADR-0010）。 */
  private recentFrameDeltasMs: number[] = [];
  private previousFrameTime: number | null = null;
  private lastAutoBudgetAdjustAt = 0;
  /** タスクB（ADR-0010）: 「間に合っている」評価が何回連続で続いているか。
   *  `evaluatePointBudget`の`PointBudgetState.consecutiveHits`をここに保持する。 */
  private autoPointBudgetConsecutiveHits = 0;
  /** タスクB（ADR-0010）: 推定したディスプレイのリフレッシュ周期。
   *  `recordFrameDelta`で毎フレーム`updateRefreshIntervalEstimate`により
   *  更新する（直近2世代・既定30秒の最小値。全期間の最小値だと異常に短い
   *  観測値に永久に固定される一方向ラチェットになるため期限付きにした。
   *  詳細は`point-budget.ts`）。 */
  private refreshIntervalEstimate: RefreshIntervalEstimate | null = null;
  /** HQ-2: 止まったら上限まで上げる判定の状態（idle-boost.ts）。 */
  private idleBoost: IdleBoostState = INITIAL_IDLE_BOOST_STATE;
  /** HQ-2: 前フレームのカメラ姿勢。動いたかの判定用。 */
  private previousCameraPose: CameraPose | null = null;
  private rafHandle = 0;
  private disposed = false;
  /** AN-2: 前フレームの時刻。カメラのアニメーションを実時間で進めるため。 */
  private previousCameraTime: number | null = null;

  /** AN: アニメーション（ノードのフェードイン・カメラの動き）の設定。既定はオン。
   *  実際に動かすかは、これとOSの`prefers-reduced-motion`の両方で決める（`motionEnabled()`）。 */
  private animationEnabled = true;

  private onStats: ((stats: RenderStats) => void) | null = null;
  private lastStatsEmitAt = 0;
  private frameTimestamps: number[] = [];

  /** WebGPUのエラー（ADR-0011）が起きるたびに呼ばれる。実際の蓄積・重複抑制は
   *  呼び出し側（src/state/useErrorLog.ts）の`GpuErrorLog`が行う。
   *  ここは伝える役目だけ（規約3: このファイルはReactを知らないので、
   *  コールバックで外へ渡す。`onStatsUpdate`と同じ形）。 */
  private onGpuError: ((message: string) => void) | null = null;

  /** M3(ADR-0013): `pcv://`のノード読み出しが失敗するたびに呼ばれる
   *  （`NodeLoader`の`onFailed`から。`addLayer()`のreadNode参照）。`onGpuError`と
   *  同じ形で、呼び出し側が同じ`GpuErrorLog`にsource="node-read"で報告する。 */
  private onNodeLoadError: ((message: string) => void) | null = null;

  /** 空の背景（M2-0c）。既定は単色(暗)のままで、"sky"を選んだときだけ描く。 */
  private backgroundMode: BackgroundMode = DEFAULT_BACKGROUND_MODE;

  /** 地面のグリッド（M2-0c補強B）。既定はオフ（空と同じく既定で強制しない）。 */
  private gridEnabled = DEFAULT_GRID_ENABLED;
  /** シーンのバウンディングボックスから決める、グリッドの間隔・フェード距離・高さ。
   *  `addLayer()`/`removeLayer()`/`setLayerVisible()`のたびに更新する（固定値にしないため）。 */
  private gridCellSize = 1;
  private gridFadeDistance = 100;
  private gridGroundHeight = 0;

  /** EDL陰影(M2-1)のオン/オフ・強さ・半径。実際の描画（陰影の計算・合成
   *  パイプライン）はgpu-resources.tsの`GpuResources`が持つ。
   *  **既定値はM3-8でコンストラクタに移った**（デスクトップはオン=変更前と
   *  同じ、モバイルはオフ。`defaultRenderSettings()`参照）。 */
  private edlEnabled: boolean;
  private edlStrength = DEFAULT_EDL_STRENGTH;
  private edlRadiusPx = DEFAULT_EDL_RADIUS_PX;

  /** ADR-0010追記: 中央優先度の強さ。`selectNodesForFrame`に渡し、画面中央からの
   *  距離に応じた重みを画面空間誤差に掛ける（`center-priority.ts`参照）。
   *  既定値は実機で検証していない（`DEFAULT_CENTER_PRIORITY_STRENGTH`のコメント
   *  参照）。設定画面から0（今までどおり）に戻せる。 */
  private centerPriorityStrength = DEFAULT_CENTER_PRIORITY_STRENGTH;
  /** 2026-10-08追記: 中央優先度の重みの下限。`setMinCenterPriorityWeight()`で
   *  設定画面から変更できる（既定`DEFAULT_MIN_CENTER_PRIORITY_WEIGHT`=0.2のまま、
   *  今まで`center-priority.ts`内の定数固定だったものを可変にした）。
   *  0を許している理由・リスクは`setMinCenterPriorityWeight()`のコメント参照。 */
  private minCenterPriorityWeight = DEFAULT_MIN_CENTER_PRIORITY_WEIGHT;

  /**
   * M3-8: レンダースケール(内部解像度 = 表示サイズ(CSS px) × この値)。
   * **devicePixelRatioはここに含めない**(2026-09-24追記の修正。理由は
   * `render-scale.ts`冒頭のコメント参照。含めるとモバイルの既定値0.5が
   * devicePixelRatio≈2の端末で実質1.0になり無効化される一方、
   * devicePixelRatio>1のデスクトップでは以前より重くなってしまうため)。
   * 変更するとキャンバスの描画バッファを作り直す必要があるため、
   * `setRenderScale()`経由でのみ変更し、そのたびに`applyCanvasSize()`を呼ぶ。
   */
  private renderScale: number;
  /** M3-8: 点の形（丸/四角）。gpu-resources.tsが起動時に両方のパイプラインを
   *  作成済みなので、切り替えにリソースの作り直しは要らない
   *  (`setPointShape()`参照)。 */
  private pointShape: PointShape;
  /** M3-8: モバイル判定の結果。コンストラクタで一度だけ決め、以後は変えない
   *  (実行中に`navigator.deviceMemory`や入力デバイスが変わることは想定しない)。 */
  private readonly isMobileProfile: boolean;
  /** M3-8: レンダースケール変更時にキャンバスサイズを再計算するために、
   *  直近の`resize()`呼び出しの表示サイズ(CSS px)を覚えておく。 */
  private lastDisplayWidthCss = 1;
  private lastDisplayHeightCss = 1;

  // 着色モード・標高の範囲・強度の範囲は、レイヤーごとの`Layer`に持つ（L1-C）。
  // 元の説明（単一ファイルだった頃）の要点は`Layer`と`addLayer`のコメントに移した:
  //  - 着色モードのRGB→標高フォールバックは呼び出し側（resolveColorMode）が行い、ここでは
  //    渡された値をそのまま使う
  //  - 標高の範囲はノードのbounds（立方体）ではなくLASヘッダーの実データ範囲から決める
  //    （scene-bounds.ts冒頭参照）
  //  - 強度の範囲はノードが届くたびに広げる（colormap.tsのextendRange）

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new OrbitCamera([0, 0, 0], 100);

    // M3-8: モバイル判定と各最適化手段の既定値を、端末プロファイル
    // (device-profile.ts)からまとめて決める。`src/state/useCopcViewer.ts`も
    // 同じ`defaultRenderSettings(readDeviceProfileInput())`を同じ入力(実行中の
    // ブラウザの状態は変わらない)で呼ぶため、ハンドシェイクなしで両者の初期値が
    // 一致する（既存のDEFAULT_EDL_STRENGTH等、モジュール定数をimportして揃える
    // やり方と同じ考え方を、値ではなく「同じ純粋関数の呼び出し」に広げたもの）。
    const deviceProfile = defaultRenderSettings(readDeviceProfileInput());
    this.isMobileProfile = deviceProfile.isMobile;
    this.renderScale = deviceProfile.renderScale;
    this.pointShape = deviceProfile.pointShape;
    this.edlEnabled = deviceProfile.edlEnabled;
    this.autoPointBudgetMax = deviceProfile.pointBudgetMax;
    this.pointBudget = deviceProfile.pointBudgetStart;

    this.cache = new NodeCache(this.pointBudget * CACHE_BUDGET_MULTIPLIER);
    // ローダーは1つで全レイヤーを扱う。どのレイヤーの`readNode`を呼ぶかは、キーの前置きで決める。
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

  /**
   * カーソル位置（キャンバスのピクセル座標）を通るワールド空間のレイの方向を
   * 返す（M1-5）。まだ1フレームも描画していない場合はnull（呼び出し側が
   * targetを動かさずdistanceだけ縮めるフォールバックを使う）。
   *
   * かつてはここでAABBへのレイキャストを行い「カーソルの下にある点」を求めて
   * `OrbitCamera.zoom()`に渡していたが、その方式（AABBの面を点の代理に使う）は
   * 構造的に成立しなかった（詳細はorbit-camera.tsのzoom()のコメント参照）。
   * 今は方向だけを渡す。
   */
  private getCursorDirection(screenX: number, screenY: number): [number, number, number] | null {
    if (!this.lastViewProj) return null;
    const ray = screenPointToWorldRay(this.lastViewProj, screenX, screenY, this.canvas.width, this.canvas.height);
    return ray?.direction ?? null;
  }

  /**
   * AN-2: 画面上の点（キャンバスのCSSピクセル）へ視点を寄せる。直近フレームのレイと
   * 描画中ノードのAABBとの交点（fly-to.tsの`pickFlyToPoint`）を新しい注視点にし、
   * 距離を縮める。当たらなければ何もしない。
   *
   * 座標はCSS px。内部バッファはレンダースケールで縮んでいるので、バッファの解像度へ
   * 換算してからレイを作る（ホイールの`getCursorDirection`はこの換算をしていない。
   * そちらは既存の挙動なので触らない）。
   */
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
    // 実データの範囲で箱を切る（fly-to.ts）。複数レイヤーのときは見えているレイヤーの和集合。
    const hit = pickFlyToPoint(ray, boxes, this.visibleCloudBounds() ?? undefined);
    if (!hit) return;
    const goal = flyToGoal(hit, this.camera.distance);
    this.camera.animateTo(goal);
  }

  // ===== L2-D: picking (screen point -> 3D point) and the view needed to overlay measurement lines =====

  /** View matrix of the latest frame (recombined with a projection that only changes near/far in picking stage 2). */
  private lastView: Mat4 | null = null;
  /** Draw options of the latest frame (so the picking redraw uses the same point size and shape). */
  private lastDrawOptions: DrawFrameOptions | null = null;

  /**
   * The latest frame's view, for overlaying measurement lines and labels. null before the first frame.
   * `viewProj` maps world to clip coordinates (f64). `up` is the camera up axis (used to split horizontal and vertical).
   */
  getViewSnapshot(): { viewProj: Mat4; up: readonly [number, number, number] } | null {
    if (!this.lastViewProj) return null;
    return { viewProj: this.lastViewProj, up: this.camera.getUpAxis() };
  }

  /**
   * Returns the 3D coordinates (world, f64) of the point-cloud point at a screen point (canvas CSS pixels).
   * null where there is no point (background). `refined` tells whether stage 2 (redraw with a narrow
   * near/far for a precise depth) was usable; if not, the stage-1 depth (coarser the farther, see the
   * top of pick-math.ts) is used.
   *
   * The points are not on the CPU, so the drawn depth is read back from the GPU and unprojected. Both
   * the EDL-on and EDL-off paths have a texture with point-cloud-only depth, so the same steps work
   * (`readDepthWindow` in gpu-resources.ts).
   */
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

    // Stage 1: from the already drawn depth, in a window around the click, find the nearest pixel with a point.
    const coarseSize = 2 * COARSE_HALF + 1;
    const coarse = await this.gpu.readDepthWindow(px - COARSE_HALF, py - COARSE_HALF, coarseSize, options.edlEnabled);
    if (!coarse) return null;
    const hit = nearestHit(coarse, coarseSize);
    if (!hit) return null;
    const coarseVP = windowViewProj(viewProj, px, py, coarseSize, width, height);
    const coarsePoint = unprojectWindowSample(coarseVP, hit.ix, hit.iy, coarseSize, hit.depth);

    // Stage 2: redraw around that pixel with a projection whose near/far bracket the rough distance, and read the depth.
    const hx = px - COARSE_HALF + hit.ix;
    const hy = py - COARSE_HALF + hit.iy;
    const range = refineDepthRange(depthToEyeDistance(hit.depth, NEAR, FAR), NEAR, FAR);
    const proj = perspective(FOV_Y_RADIANS, width / Math.max(height, 1), range.near, range.far);
    const refineSize = 2 * REFINE_HALF + 1;
    const refineVP = windowViewProj(multiply(proj, view), hx, hy, refineSize, width, height);
    const fine = await this.gpu.renderDepthWindow(refineVP, refineSize, this.lastDrawn, options);
    const fineHit = fine ? nearestHit(fine, refineSize) : null;
    if (fineHit) {
      const point = unprojectWindowSample(refineVP, fineHit.ix, fineHit.iy, refineSize, fineHit.depth);
      if (point) return { point, refined: true };
    }
    return coarsePoint ? { point: coarsePoint, refined: false } : null;
  }

  // ===== 複数レイヤー（L1-C） =====
  //
  // 方針（TaskSheets/L1-multi-layer.md「決めたこと」）:
  //  - 点予算は全レイヤーで1つを分け合う。ノード選択は見えている全レイヤーのノードを
  //    同じ優先度（画面上の大きさ）で比べる（node-selection.ts の selectNodesForLayers）
  //  - キャッシュ・ローダーのキーは "<通し番号>:<ノードキー>" でレイヤーごとに分ける（layer-key.ts）
  //  - 標高の範囲は見えている全レイヤーの合併、強度の範囲はレイヤーごと
  //  - 非表示のレイヤーは選択・描画の対象外（ロードも、選ばれないので要求されない）

  /**
   * レイヤーを足す。足したら、見えている全レイヤーが入るように視点を合わせる
   * （遠くのファイルを足したとき、見えないままにならないように）。
   * 同じ`layerId`が既にあれば、先にそれを`removeLayer`してから足す。
   *
   * 標高の範囲は、ノードのbounds（octreeセル、立方体でZが水平方向に引き伸ばされる）ではなく、
   * `boundsMin`/`boundsMax`（LASヘッダーの実データ範囲）から決める
   * （実機不具合の経緯は`scene-bounds.ts`冒頭のコメント）。
   */
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

    // 足したレイヤーへカメラを移す（L2-B）。最初のレイヤーは、まだ見ているものが無いので即座に置く
    // （原点から数km先へ飛ぶ動きを見せない）。2つ目以降は視点移動のアニメーションで飛ぶ。
    if (layer.visible) this.moveCameraToLayer(layer, !hadVisibleLayer);
  }

  /**
   * レイヤーを消す。そのレイヤーのノードをGPUバッファごとキャッシュから捨てる。
   * 読み込み中のノードが後から届いても、通し番号がもう無いので`handleNodeLoaded`が捨てる。
   * 視点は動かさない（グリッドの高さ・大きさだけ、残りのレイヤーに合わせ直す）。
   */
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

  /** 表示・非表示。非表示のレイヤーは、ノード選択・読み込み・描画のどれの対象にもならない。視点は動かさない。 */
  setLayerVisible(layerId: string, visible: boolean): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    layer.visible = visible;
    this.updateGridFromVisibleLayers();
  }

  /**
   * そのレイヤーの着色モードを変える。RGBを持たないファイルでの`"rgb"`のフォールバックは
   * ここでは行わない（呼び出し側の`resolveColorMode`が解決した値を渡す前提。判断を1箇所に閉じるため）。
   */
  setLayerColorMode(layerId: string, mode: ColorMode): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.colorMode = mode;
  }

  getLayerColorMode(layerId: string): ColorMode | undefined {
    return this.layers.get(layerId)?.colorMode;
  }

  /**
   * そのレイヤーの点の形・大きさを変える（L2-B）。次のフレームから反映される。
   * 形は丸/四角のパイプラインが起動時に両方あるので、作り直しは要らない。
   * 大きさは直径（内部バッファのピクセル）。範囲外・NaN は`sanitizePointSize`で丸める。
   */
  setLayerPointShape(layerId: string, shape: PointShape): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.style = { ...layer.style, shape };
  }

  setLayerPointSize(layerId: string, px: number): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.style = { ...layer.style, sizePx: sanitizePointSize(px) };
  }

  getLayerPointShape(layerId: string): PointShape | undefined {
    return this.layers.get(layerId)?.style.shape;
  }

  getLayerPointSize(layerId: string): number | undefined {
    return this.layers.get(layerId)?.style.sizePx;
  }

  /** 描画のとき、ノードのキー（"<通し番号>:<ノードキー>"）からそのレイヤーの点の見た目を引く。 */
  private nodeStyleOf(node: CachedNode): NodePointStyle {
    const parsed = parseLayerNodeKey(node.key);
    return (parsed && this.layersBySerial.get(parsed.serial)?.style) || this.defaultNodeStyle();
  }

  private defaultNodeStyle(): NodePointStyle {
    return { shape: this.pointShape, sizePx: DEFAULT_POINT_SIZE_PX };
  }

  /**
   * そのレイヤーへカメラを移す（L2-B）。視点移動のアニメーションで（アニメーション無効なら即時）。
   * 向き（yaw/pitch）は今のまま、注視点と距離だけ変える。グリッドもこのレイヤーに合わせる。
   * レイヤーが無ければ何もせず`false`。非表示のレイヤーにも移れる（見たければ表示すればよい）。
   */
  focusLayer(layerId: string, orientation?: { yaw: number; pitch: number }): boolean {
    const layer = this.layers.get(layerId);
    if (!layer) return false;
    this.moveCameraToLayer(layer, false, orientation);
    return true;
  }

  /**
   * L2-F: move the camera to a box (used for measurement layers, which are not in the renderer).
   * Same animation as `focusLayer`; the orientation is kept. The grid is left as it is.
   */
  focusBox(min: readonly [number, number, number], max: readonly [number, number, number]): void {
    const bounds = layerFocusBounds(null, min, max);
    this.camera.setSceneScale(bounds.diagonal);
    this.camera.animateTo(focusGoalFor(bounds));
  }

  private focusedLayer(): Layer | undefined {
    return this.focusedLayerId !== null ? this.layers.get(this.focusedLayerId) : undefined;
  }

  /**
   * カメラをレイヤーに合わせ、グリッドもそのレイヤーに合わせる。
   * `immediate`なら即座に置く（最初のレイヤー用）。そうでなければ視点移動のアニメーション。
   */
  private moveCameraToLayer(layer: Layer, immediate: boolean, orientation?: { yaw: number; pitch: number }): void {
    const bounds = layerFocusBounds(layer.sceneBounds, layer.boundsMin, layer.boundsMax);
    this.focusedLayerId = layer.id;
    this.camera.setSceneScale(bounds.diagonal);
    this.applyGridBounds(bounds);
    const goal = focusGoalFor(bounds, orientation);
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

  /** 見えているレイヤーの、ノードのbounds（octreeセル）の和集合。カメラ・グリッド用。 */
  private visibleSceneBounds(): SceneBounds | null {
    const list: SceneBounds[] = [];
    for (const layer of this.layers.values()) {
      if (layer.visible && layer.sceneBounds) list.push(layer.sceneBounds);
    }
    return mergeSceneBounds(list);
  }

  /** 見えているレイヤーの、LASヘッダーの実データ範囲の和集合。ダブルクリックで寄る先の切り取り用。 */
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

  /**
   * グリッドの高さ・大きさを決め直す。最後に移動したレイヤー（見えていれば）に合わせる。
   * それが無い・非表示なら、見えているレイヤーの合併（従来と同じ）。
   */
  private updateGridFromVisibleLayers(): void {
    const focused = this.focusedLayer();
    const bounds =
      focused && focused.visible
        ? layerFocusBounds(focused.sceneBounds, focused.boundsMin, focused.boundsMax)
        : this.visibleSceneBounds();
    if (bounds) this.applyGridBounds(bounds);
  }

  /**
   * M2-0c補強B: グリッドの間隔・フェード距離・高さをシーンのスケールから決め直す
   * （固定値にしないため、タスクシートの要求）。高さは上方向(upAxis)成分での
   * バウンディングボックス底面（点群の一番下）に置く。
   */
  private applyGridBounds(bounds: SceneBounds): void {
    const upAxis = this.camera.getUpAxis();
    this.gridGroundHeight = bounds.min[0] * upAxis[0] + bounds.min[1] * upAxis[1] + bounds.min[2] * upAxis[2];
    this.gridCellSize = niceGridCellSize(bounds.diagonal);
    this.gridFadeDistance = gridFadeDistance(bounds.diagonal);
  }

  /**
   * ローダーから呼ばれる。"<通し番号>:<ノードキー>" から、そのレイヤーの`readNode`を引いて読む。
   * レイヤーがもう無ければ`StaleNodeRequestError`にして、ローダーに黙って捨てさせる。
   */
  private readLayerNode(key: string): Promise<ArrayBuffer> {
    const parsed = parseLayerNodeKey(key);
    const layer = parsed ? this.layersBySerial.get(parsed.serial) : undefined;
    if (!parsed || !layer) return Promise.reject(new StaleNodeRequestError(key));
    return layer.readNode(parsed.nodeKey);
  }

  /**
   * 点予算を手動で設定する。ADR-0009:「ユーザーの手動設定を常に優先する。
   * 手で変えたら自動調整は止まる」に従い、呼ぶと自動調整（タスクB）を止める。
   * 再開するには`setAutoPointBudgetEnabled(true)`を呼ぶこと。
   */
  setPointBudget(budget: number): void {
    this.autoPointBudgetEnabled = false;
    this.pointBudget = Math.max(1, Math.floor(budget));
    this.cache.maxPoints = this.pointBudget * CACHE_BUDGET_MULTIPLIER;
  }

  getPointBudget(): number {
    return this.pointBudget;
  }

  /**
   * タスクB（ADR-0009）: 点予算の自動調整のオン/オフ。offにすると
   * `pointBudget`は最後の値のまま固定され、`setPointBudget()`で手動設定した
   * ときと同じ状態になる。onにすると次の評価タイミング
   * （`AUTO_POINT_BUDGET_INTERVAL_MS`ごと）から閉ループでの調整を再開する。
   */
  setAutoPointBudgetEnabled(enabled: boolean): void {
    this.autoPointBudgetEnabled = enabled;
  }

  getAutoPointBudgetEnabled(): boolean {
    return this.autoPointBudgetEnabled;
  }

  /** AN: アニメーションのオン/オフ（設定）。OSが「視差効果を減らす」ならオンでも動かさない。 */
  /**
   * AN-2: カメラが慣性・なめらかなズーム・視点移動のいずれかで動いている間true。
   * 点予算の調整や、将来のHQ-2（止まったら最大画質）の「動いているか」の判定は、これを使う。
   */
  isCameraAnimating(): boolean {
    return this.camera.isAnimating();
  }

  /** 計測・テスト用: カメラの現在の状態（毎フレーム読める。統計は500msごとなので粗い）。 */
  debugCameraState(): {
    yaw: number;
    pitch: number;
    distance: number;
    target: [number, number, number];
    animating: boolean;
  } {
    const c = this.camera;
    return { yaw: c.yaw, pitch: c.pitch, distance: c.distance, target: [...c.target], animating: c.isAnimating() };
  }

  setAnimationEnabled(enabled: boolean): void {
    this.animationEnabled = enabled;
  }

  getAnimationEnabled(): boolean {
    return this.animationEnabled;
  }

  /** 設定オン かつ OSが動きを減らす指定をしていない。毎フレーム問い合わせるので、OS設定の変更にも追従する。 */
  private motionEnabled(): boolean {
    return resolveMotionEnabled(this.animationEnabled, prefersReducedMotion());
  }

  /** 背景モード（M2-0c）: 空 / 単色(暗) / 単色(明)。既定は単色(暗)。 */
  setBackgroundMode(mode: BackgroundMode): void {
    this.backgroundMode = mode;
  }

  getBackgroundMode(): BackgroundMode {
    return this.backgroundMode;
  }

  /** 地面グリッド（M2-0c補強B）: 向き・尺度・地平線の手がかりを与える。既定はオフ。 */
  setGridEnabled(enabled: boolean): void {
    this.gridEnabled = enabled;
  }

  getGridEnabled(): boolean {
    return this.gridEnabled;
  }

  /** EDL(M2-1)のオン/オフ。オフのとき、合成パスへ渡す強さを0にすることで
   *  無効化する（edl.ts参照）。既定はオン。 */
  setEdlEnabled(enabled: boolean): void {
    this.edlEnabled = enabled;
  }

  getEdlEnabled(): boolean {
    return this.edlEnabled;
  }

  /** EDL(M2-1)の強さ。0で無効(強さ0でM1と同じ見た目になる、というタスクシートの
   *  受け入れ条件は`edlShadingFactor`の性質そのもので満たされる。edl.ts参照)。 */
  setEdlStrength(strength: number): void {
    this.edlStrength = Math.max(0, strength);
  }

  getEdlStrength(): number {
    return this.edlStrength;
  }

  /** EDL(M2-1)が近傍として見る距離（スクリーンピクセル単位）。タスクシートが
   *  「望ましい」とした調整項目。 */
  setEdlRadiusPx(radiusPx: number): void {
    this.edlRadiusPx = Math.max(0, radiusPx);
  }

  getEdlRadiusPx(): number {
    return this.edlRadiusPx;
  }

  /** ADR-0010追記: 中央優先度の強さ。0にすると今までどおり画面空間誤差だけの
   *  優先度になる（`center-priority.ts`の`centerPriorityWeight`参照）。 */
  setCenterPriorityStrength(strength: number): void {
    this.centerPriorityStrength = Math.max(0, strength);
  }

  getCenterPriorityStrength(): number {
    return this.centerPriorityStrength;
  }

  /** 2026-10-08追記: 中央優先度の重みの下限（0〜1）。下げるほど、画面端の
   *  ノードを後回しにしてよい度合いが大きくなる（`minWeight`が小さいほど
   *  `priority = error * weight`の`weight`が小さくなり得るため）。
   *
   *  **0を渡すこと自体は許すが、`centerPriorityStrength`が大きいときに
   *  画面端のノードが点予算の厳しい状況で事実上選ばれなくなる
   *  （飢餓防止が効かなくなる）リスクがある。** 下限を設けない案は
   *  当初（ADR-0010追記4）、この飢餓のリスクを理由に却下していたが、
   *  所有者がスライダーで下限まで触れるようにしたいと明示したため、
   *  既定値は0.2のまま変えず、0まで下げられる選択の自由だけを設定画面に渡す
   *  （選んだ結果のリスクは設定画面の説明文で示す。SettingsModal.tsx参照）。 */
  setMinCenterPriorityWeight(minWeight: number): void {
    this.minCenterPriorityWeight = Math.min(1, Math.max(0, minWeight));
  }

  getMinCenterPriorityWeight(): number {
    return this.minCenterPriorityWeight;
  }

  /**
   * M3-8: レンダースケール(内部解像度 = 表示サイズ(CSS px) × この値。
   * devicePixelRatioは含めない。理由は`renderScale`フィールドのコメント参照)
   * を変更する。キャンバスの描画バッファ(depth/オフスクリーンのテクスチャを
   * 含む)を作り直す必要があるため、`applyCanvasSize()`（`resize()`と共通）を呼ぶ。
   */
  setRenderScale(scale: number): void {
    this.renderScale = Math.max(0.05, scale);
    this.applyCanvasSize();
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  /**
   * M3-8: 点の形（丸/四角）の既定値。L2-B以降は形がレイヤーごとなので、これは
   * 「これから足すレイヤーの初期値」（`LayerInput.pointShape`を省いたとき）と統計表示にだけ効き、
   * 既にあるレイヤーは変えない。既存レイヤーは`setLayerPointShape`で変える。
   * gpu-resources.tsが起動時に丸・四角の両方のパイプラインを作成済みなので、
   * リソースの作り直しは不要。
   */
  setPointShape(shape: PointShape): void {
    this.pointShape = shape;
  }

  getPointShape(): PointShape {
    return this.pointShape;
  }

  /** M3-8: モバイル判定の結果(コンストラクタで一度だけ決めた値)。 */
  getIsMobile(): boolean {
    return this.isMobileProfile;
  }

  /** M3-8: 自動調整が動ける点予算の上限(端末プロファイルから決めた値)。 */
  getAutoPointBudgetMax(): number {
    return this.autoPointBudgetMax;
  }

  /** 統計（描画点数・ロード中ノード数・fpsなど）が更新されるたびに呼ばれる。 */
  onStatsUpdate(callback: (stats: RenderStats) => void): void {
    this.onStats = callback;
  }

  /** WebGPUのエラー（ADR-0011）が起きるたびに呼ばれる。`onStatsUpdate`と同じ形。 */
  onGpuErrorReported(callback: (message: string) => void): void {
    this.onGpuError = callback;
  }

  /**
   * WebGPUのエラーメッセージを1件報告する。コンソールには常に出す（今までの
   * 挙動を減らさない）うえで、コールバックが登録されていれば画面のバナー用にも渡す。
   */
  private reportGpuError(message: string): void {
    console.error(`[renderer] WebGPU error: ${message}`);
    this.onGpuError?.(message);
  }

  /**
   * M3-8追加: WebGPUデバイス消失(`device.lost`)から復帰し、`GpuResources`が
   * リソースを作り直し終えた直後に呼ばれる（`gpu-resources.ts`の
   * `handleDeviceLost()`参照）。**古いデバイスで作ったGPUバッファ
   * (キャッシュ済みノードの`vertexBuffer`/`uniformBuffer`)は新しいデバイスでは
   * 使えない**ため、キャッシュを空にする。`NodeLoader`はDataSource越しの
   * 生バイト取得でデバイスに依存しないため影響を受けず、キャッシュが空になった
   * ことで次のフレームから`selectNodesForFrame`が改めて必要なノードを
   * `wanted`に含め、自然に読み込み直される。
   *
   * **レイヤーの入れ替えとは違い、`loader.reset()`は呼ばない。** デバイス消失は
   * 開いているファイルが変わるわけではない（同じファイル・同じ世代のまま）ので、
   * 取得中のノードは無効化する必要が無く、キャッシュだけ空にすれば十分
   * （ファイル切り替え時の不具合修正、レイヤーの入れ替えのコメント参照）。
   */
  private handleDeviceRecovered(): void {
    this.cache.dispose();
    // レイヤーの着色設定のバッファも古いデバイスのものなので使えない。
    // 次に使うとき（`ensureColorBuffer`）に新しいデバイスで作り直す。
    for (const layer of this.layers.values()) layer.colorBuffer = null;
  }

  /** レイヤーの着色設定のバッファを返す。無ければ（デバイス復帰の直後など）作る。デバイスが無ければnull。 */
  private ensureColorBuffer(layer: Layer): GPUBuffer | null {
    if (!layer.colorBuffer) layer.colorBuffer = this.gpu.createColorSettingsBuffer();
    return layer.colorBuffer;
  }

  /** M3(ADR-0013): ノード読み出し失敗が起きるたびに呼ばれる。`onGpuErrorReported`と同じ形。 */
  onNodeLoadErrorReported(callback: (message: string) => void): void {
    this.onNodeLoadError = callback;
  }

  /**
   * ノード読み出しの失敗を1件報告する。`reportGpuError`と対になる形にした
   * （コンソールには常に出し、コールバックがあればバナー用にも渡す）。
   * メッセージの組み立て（本文をそのまま含める）は`formatNodeLoadErrorMessage`
   * （GPUにもReactにも依存しない純粋関数、node-load-error.ts）に任せる。
   */
  private reportNodeLoadError(key: string, error: unknown): void {
    // キーは "<通し番号>:<ノードキー>"。メッセージには人が読めるよう レイヤーid/ノードキー にする。
    const parsed = parseLayerNodeKey(key);
    const layerId = parsed ? this.layersBySerial.get(parsed.serial)?.id : undefined;
    // 読み込み中に消されたレイヤーの失敗は、エラーとして報告しない（結果を捨てるのと同じ扱い。
    // ファイルを開き直したとき、前のファイル宛ての読み出しが失敗してもバナーに出さない）。
    if (parsed && layerId === undefined) return;
    const label = parsed && layerId !== undefined ? `${layerId}/${parsed.nodeKey}` : key;
    const message = formatNodeLoadErrorMessage(label, error);
    console.error(`[renderer] ${message}`);
    this.onNodeLoadError?.(message);
  }

  /**
   * 表示サイズ(CSS px、通常は`canvas.clientWidth`/`clientHeight`)を渡す。
   * **M3-8**: 以前はこの値をそのまま`canvas.width`/`height`(描画バッファの
   * サイズ)に使っていたが、レンダースケール導入により「表示サイズ×
   * レンダースケール」を計算してから使うように変えた(`applyCanvasSize()`
   * 参照。**devicePixelRatioは掛けない**。2026-09-24追記、理由は
   * `render-scale.ts`冒頭のコメント参照)。表示サイズ自体は
   * `lastDisplayWidthCss`/`lastDisplayHeightCss`に覚えておき、
   * `setRenderScale()`で倍率だけが変わったときも同じ計算を再利用する。
   */
  resize(displayWidthCss: number, displayHeightCss: number): void {
    this.lastDisplayWidthCss = Math.max(1, displayWidthCss);
    this.lastDisplayHeightCss = Math.max(1, displayHeightCss);
    this.applyCanvasSize();
  }

  /**
   * 表示サイズ(CSS px)・レンダースケールから、キャンバスの描画バッファ
   * (internal resolution)を計算し直す。計算そのものは`render-scale.ts`の
   * `computeCanvasBackingSize`（純粋関数、単体テスト済み）に任せ、ここでは
   * 結果を`canvas.width`/`height`と`gpu.resize()`へ反映するだけにする。
   * 「表示サイズが変わったとき」(`resize()`)と「レンダースケールだけ
   * 変わったとき」(`setRenderScale()`)の両方がこのメソッドを通ることで、
   * 処理が分岐しないようにしてある。
   *
   * **devicePixelRatioを渡さない理由（2026-09-24追記）**: 当初は
   * `window.devicePixelRatio`を渡していたが、これが2つの問題を生んでいた。
   * (1) OPPO Pad Air(devicePixelRatio≈2の見込み)ではモバイルの既定
   * `renderScale=0.5`が実質2×0.5=1.0倍になり、無効化されていた。所有者の
   * 実機の症状は`VK_ERROR_DEVICE_LOST`(GPUのハング)で、1フレームのGPUの
   * 仕事を減らすことが本命の対策なのに、その手段が効いていなかった。
   * (2) デスクトップでも表示スケール125%/150%等(devicePixelRatio>1)の
   * 環境では、renderScale=1.0(デスクトップの既定)でも以前(devicePixelRatio
   * を一切考慮していなかったv0.1.0)より内部解像度が上がってしまい、
   * 「デスクトップの見た目と挙動を変えない」というタスクシートの必須要件に
   * 反していた。devicePixelRatioを外すことで、renderScale=1.0が
   * `canvas.clientWidth`そのまま(変更前と完全一致)に戻る。
   */
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
    // 読み込み中に`removeLayer`されたレイヤーのノードは、ここで捨てる。
    const parsed = parseLayerNodeKey(key);
    const layer = parsed ? this.layersBySerial.get(parsed.serial) : undefined;
    if (!layer) return;
    const colorBuffer = this.ensureColorBuffer(layer);
    if (!colorBuffer) return;
    const cached = this.gpu.createCachedNode(key, node, colorBuffer);
    if (!cached) return;
    this.cache.set(cached);

    // M2-2: 強度のレンジを実データから広げていく（colormap.tsの`extendRange`参照）。
    // ノードが届くたびにそのノード内のmin/maxを求め、既知のレンジをその2値ぶんだけ広げる
    // （狭まることはない）。複数レイヤー: 計測機が違うと幅が違うので、レイヤーごとに持つ。
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

    // AN-2: カメラのアニメーション（慣性・ズーム・視点移動）を実際の経過時間で進める。
    // 動きが無効なら、進行中のものは止めて今までどおり即時の挙動にする。
    const motionEnabled = this.motionEnabled();
    if (!motionEnabled && this.camera.motionEnabled) this.camera.cancelMotion();
    this.camera.motionEnabled = motionEnabled;
    if (this.previousCameraTime !== null) this.camera.update(time - this.previousCameraTime);
    this.previousCameraTime = time;

    // HQ-2: 止まったら上限まで上げ、動いたら（描く前に）元の点予算に戻す。
    // 点を選ぶ前に行うこと。止まっている間は AIMD を呼ばない。
    const aimdPaused = this.updateIdleBoost(time);
    if (!aimdPaused) this.autoAdjustPointBudget(time);

    const width = this.canvas.width;
    const height = this.canvas.height;
    const aspect = width / Math.max(height, 1);
    const proj = perspective(FOV_Y_RADIANS, aspect, NEAR, FAR);
    const view = this.camera.viewMatrix();
    const viewProj = multiply(proj, view);
    this.lastViewProj = viewProj;
    const planes = frustumPlanes(viewProj);

    // 見えているレイヤーだけを選択の対象にする（非表示のノードは選ばれず、ロードも要求されない）。
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

    // AN-1: 初めて描画対象になったノードに時刻を刻む（フェードインの起点）。
    for (const node of selection.toDraw) {
      if (node.firstDrawnAtMs === null) node.firstDrawnAtMs = time;
    }

    // 着色の設定はレイヤーごとのバッファに書く。標高の範囲・強度の範囲とも、そのレイヤー自身の範囲。
    // （L2-F: 以前は標高だけ見えている全レイヤーの合併だった。離れた場所のレイヤーを並べると範囲が広がって
    // 各レイヤーの色の差が無くなるため、レイヤーごとにした。隣り合うタイルを別レイヤーで開くと境目で色が
    // ずれるが、結合すれば1つのレイヤーになり解消する。）
    for (const layer of visibleLayers) {
      const elevationRange = layer.elevationRange;
      const buffer = this.ensureColorBuffer(layer);
      if (!buffer) continue;
      // まだ1件もノードが届いていない間の強度の範囲はnull。0..0の縮退レンジを渡せば
      // gpu-resources.tsのcolorForVertex()側で「レンジ無し→常にt=0」に安全にフォールバックする。
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
    };
    this.lastView = view; // L2-D: for picking (measurement)
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

  /**
   * タスクB（ADR-0010）: 直近フレームの所要時間(ms)を`recentFrameDeltasMs`に
   * 記録する。`evaluatePointBudget`に渡すウィンドウの材料。`frameTimestamps`
   * （fps計算用、直近1秒分をすべて保持）とは別に、こちらは直近
   * `AUTO_POINT_BUDGET_FRAME_HISTORY`本だけを保持する短い窓にする
   * （「今vsyncに間に合っているか」の指標にするには、古いフレームを
   * 引きずらないほうがよいため）。
   */
  private recordFrameDelta(time: number): void {
    if (this.previousFrameTime !== null) {
      const deltaMs = time - this.previousFrameTime;
      this.recentFrameDeltasMs.push(deltaMs);
      if (this.recentFrameDeltasMs.length > AUTO_POINT_BUDGET_FRAME_HISTORY) {
        this.recentFrameDeltasMs.shift();
      }
      // リフレッシュ周期の推定は、上のrecentFrameDeltasMs（短い窓、ミス割合の
      // 判定用）とは別に、直近2世代（既定30秒）の最小値を使う。ADR-0010追記3:
      // 「これまで全期間の最小値」は、異常に短い間隔が一度でも来ると
      // 永久に固定される一方向ラチェットだったため、期限付きに直した
      // （point-budget.ts参照）。`time`をnowMsとして渡し、世代交代の判定に使う。
      this.refreshIntervalEstimate = updateRefreshIntervalEstimate(this.refreshIntervalEstimate, deltaMs, time);
    }
    this.previousFrameTime = time;
  }

  /**
   * HQ-2: カメラが止まったら点予算を上限まで上げ、動いたら元に戻す。
   * 判定は `idle-boost.ts`（純粋関数）に任せ、ここでは結果を点予算に反映するだけ。
   * 戻り値は「AIMD を止めるか」。
   *
   * 戻すとき、AIMD の直近フレームの窓を捨てて最初からやり直す。止まっている間は
   * 点予算が大きく、フレームが重くなっていることがあるため、それを AIMD が
   * 「外した」と読んで、動き出した直後に予算を下げてしまうのを防ぐ。
   */
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

  /**
   * タスクB（ADR-0010）: 「vsyncに間に合っているか」を信号にしたAIMDで
   * 点予算を調整する。実際の計算（ミス割合の判定・不感帯・変化量の制限・
   * 上限下限）はすべて`evaluatePointBudget`（純粋関数、`point-budget.ts`）に
   * 任せ、ここでは「いつ・何を渡すか」だけを決める（規約: このファイルは
   * 呼ぶだけにする）。
   */
  private autoAdjustPointBudget(time: number): void {
    if (!this.autoPointBudgetEnabled) return;
    if (time - this.lastAutoBudgetAdjustAt < AUTO_POINT_BUDGET_INTERVAL_MS) return;
    if (this.recentFrameDeltasMs.length === 0) return;
    this.lastAutoBudgetAdjustAt = time;

    // 固定の1000/60msを目標にせず、recordFrameDeltaで継続的に更新している
    // 推定リフレッシュ周期を使う（60Hzでも144Hzでも正しく動かすため。ADR-0010）。
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
