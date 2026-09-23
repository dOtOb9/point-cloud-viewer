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

import type { DataSource, HierarchyNodeInfo } from "../datasource/DataSource";
import { computeIntensityRange, NODE_POINT_STRIDE, type ParsedNode } from "../datasource/node-format";
import { attachOrbitControls, OrbitCamera } from "./orbit-camera";
import { multiply, perspective, type Mat4 } from "./mat4";
import { frustumPlanes } from "./frustum";
import {
  evaluatePointBudget,
  pointBudgetMaxFromMemoryBudget,
  updateRefreshIntervalEstimate,
  DEFAULT_POINT_BUDGET_TUNING,
  type RefreshIntervalEstimate,
} from "./point-budget";
import { screenPointToWorldRay } from "./raycast";
import { NodeCache, type CachedNode } from "./node-cache";
import { NodeLoader } from "./node-loader";
import { selectNodesForFrame } from "./node-selection";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "./sky";
import { DEFAULT_GRID_ENABLED, gridFadeDistance, niceGridCellSize } from "./ground-grid";
import { DEFAULT_EDL_ENABLED, DEFAULT_EDL_RADIUS_PX, DEFAULT_EDL_STRENGTH } from "./edl";
import { FAR, FOV_Y_RADIANS, GpuResources, NEAR } from "./gpu-resources";
import { DEFAULT_COLOR_MODE, extendRange, type ColorMode, type ValueRange } from "./colormap";
import { computeSceneBounds, elevationRangeFromCloudBounds } from "./scene-bounds";

// WebGPUのエラーを画面に出す仕組み(新設)。蓄積・重複抑制のロジック自体は
// GPUに依存しないgpu-error-log.tsに切り出してあり、このファイルはWebGPUの
// APIから文字列を取り出して渡すだけにする(詳しい経緯はTaskSheets/
// ADR-0011-gpu-error-visibility.md参照)。

/** キャッシュは点予算より少し余裕を持たせる（視点を少し動かしただけの再取得を防ぐ）。 */
const CACHE_BUDGET_MULTIPLIER = 2;

/**
 * タスクB（ADR-0010で刷新）: 点キャッシュに割り当てる想定メモリ予算(バイト)。
 *
 * **この数値は実測していない、未検証の初期値。** 当初は256MiBにしていたが、
 * 所有者の実機（RTX 4070、VRAM 12GB）で「近くのチャンクが精緻にならない」
 * 症状の原因がまさに点予算(≒このメモリ予算から逆算される上限)の不足だった
 * ことが確定したため、1GiBへ引き上げた。`sofi.copc.laz`はレベル6だけで
 * 4,431ノード・ノードあたり約25,000点あるため、この程度の余裕を見ても
 * 全レベルを賄いきれるわけではないが、旧256MiB(=旧DEFAULT_POINT_BUDGETの
 * 2.2倍)よりは大幅に改善する。ADR-0009の対象端末（OPPO Pad Air / RAM 4GB）
 * では1GiBは大きすぎる可能性が高いが、端末ごとにこの値を変える仕組みは
 * まだ無く（[M3-8](../../TaskSheets/M3-release-and-update.md)に送る）、
 * 現状は開発機基準の値になっている。
 */
const POINT_CACHE_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

/**
 * タスクB（ADR-0009）: 自動調整（`evaluatePointBudget`）が動かせる下限・上限。
 *
 * 下限（`AUTO_POINT_BUDGET_MIN`）は「これより粗いと点群として意味が無い」
 * という経験的な最低ラインで、実測ではない。
 *
 * 上限（`AUTO_POINT_BUDGET_MAX`）は、`POINT_CACHE_MEMORY_BUDGET_BYTES`から
 * 逆算する。`node-cache.ts`のキャッシュは点予算そのものではなく
 * `点予算 × CACHE_BUDGET_MULTIPLIER`点分のGPUバッファを保持するので、
 * 上限点数はメモリ予算をその倍率で割ったものになる
 * （式の説明は`point-budget.ts`の`pointBudgetMaxFromMemoryBudget`参照）。
 * 端末情報（`adapter.limits`等）から`POINT_CACHE_MEMORY_BUDGET_BYTES`自体を
 * 動的に決める仕組みは、このタスクの範囲外で
 * [M3-8](../../TaskSheets/M3-release-and-update.md)の端末適応作業に送る。
 */
const AUTO_POINT_BUDGET_MIN = 200_000;
const AUTO_POINT_BUDGET_MAX = pointBudgetMaxFromMemoryBudget(
  POINT_CACHE_MEMORY_BUDGET_BYTES,
  NODE_POINT_STRIDE,
  CACHE_BUDGET_MULTIPLIER,
);

/**
 * 起動直後の点予算。**旧実装は固定で3,000,000だったが、これが所有者の実機で
 * 「近くのチャンクが精緻にならない」症状の直接の原因だった**
 * （`sofi.copc.laz`はノードあたり約25,000点なので、3,000,000点では
 * 約120ノード分しか描けず、レベル6だけで4,431ノードあるこのファイルでは
 * 全く足りない）。
 *
 * 低い値から上限を探り上げる（成長は`growRate`/`sustainedHitsToGrow`で
 * ゆっくりにしてある）のではなく、**楽観的に上限から始めて、外したら
 * 即座に大きく下げる側（`shrinkRate`、持続要求なし）で実機に合った値を
 * 素早く見つける**ほうが体感が良いと判断し、上限(`AUTO_POINT_BUDGET_MAX`)に
 * 連動させた。
 *
 * 到達秒数（`AUTO_POINT_BUDGET_INTERVAL_MS`=500msごとに評価する前提の計算値。
 * 実測ではない。`npx tsx`で`evaluatePointBudget`を実際に呼んで数えた具体的な
 * ステップ数を基にしている）:
 * - 上限(起動時の開始値)→下限: 約11秒（下げは持続要求が無く、20%/回で
 *   即座に効くため速い）
 * - 下限→上限: 約78秒（上げは`sustainedHitsToGrow`=3回(1.5秒)の持続を
 *   要求したうえで10%/回。ただし開始値がすでに上限なので、これは
 *   「一度下限まで落ちた後に完全回復する」という稀なケースの所要時間であり、
 *   通常発生する経路ではない）
 */
const DEFAULT_POINT_BUDGET = AUTO_POINT_BUDGET_MAX;

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
  /** M2-1: EDLのオン/オフと強さ。GUIを目視できなくても、UIの操作がrendererまで
   *  届いているかをstdoutで確認できるようにする（陰影が実際に効いているかどうか
   *  自体は目視でしか確認できないが、状態が正しく伝わっているかは機械的に見える）。 */
  edlEnabled: boolean;
  edlStrength: number;
  /** M2-2: 現在の着色モード。EDLと同じく、UIの操作がrendererまで届いているかを
   *  stdoutで機械的に確認できるようにする。 */
  colorMode: ColorMode;
}

export class PointCloudRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: OrbitCamera;
  private detachControls: () => void = () => {};

  /** WebGPUのデバイス・パイプライン・テクスチャ・drawFrameの実体。
   *  WebGPUのAPIを直接叩くのはgpu-resources.tsだけにする（ARCHITECTURE.md）。 */
  private readonly gpu: GpuResources;

  private hierarchy: HierarchyNodeInfo[] = [];
  private cache: NodeCache;
  private loader: NodeLoader | null = null;
  /** 直近フレームのviewProj。ホイールイベント（フレームの外で起きる）でカーソル位置の
   *  レイを作るために、フレームをまたいで持っておく（M1-5）。 */
  private lastViewProj: Mat4 | null = null;

  private pointBudget = DEFAULT_POINT_BUDGET;
  /** タスクB（ADR-0009）: 自動調整のオン/オフ。`setPointBudget()`で手動設定すると
   *  自動でoffになる（手動設定を自動調整より常に優先するため）。 */
  private autoPointBudgetEnabled = true;
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
  private rafHandle = 0;
  private disposed = false;

  private onStats: ((stats: RenderStats) => void) | null = null;
  private lastStatsEmitAt = 0;
  private frameTimestamps: number[] = [];

  /** WebGPUのエラー（新設）が起きるたびに呼ばれる。実際の蓄積・重複抑制は
   *  呼び出し側（src/state/useCopcViewer.ts）の`GpuErrorLog`が行う。
   *  ここは伝える役目だけ（規約3: このファイルはReactを知らないので、
   *  コールバックで外へ渡す。`onStatsUpdate`と同じ形）。 */
  private onGpuError: ((message: string) => void) | null = null;

  /** 空の背景（M2-0c）。既定は単色(暗)のままで、"sky"を選んだときだけ描く。 */
  private backgroundMode: BackgroundMode = DEFAULT_BACKGROUND_MODE;

  /** 地面のグリッド（M2-0c補強B）。既定はオフ（空と同じく既定で強制しない）。 */
  private gridEnabled = DEFAULT_GRID_ENABLED;
  /** シーンのバウンディングボックスから決める、グリッドの間隔・フェード距離・高さ。
   *  `setHierarchy()`で点群を開くたびに更新する（固定値にしないため）。 */
  private gridCellSize = 1;
  private gridFadeDistance = 100;
  private gridGroundHeight = 0;

  /** EDL陰影(M2-1)のオン/オフ・強さ・半径。既定はオン。実際の描画（陰影の計算・
   *  合成パイプライン）はgpu-resources.tsの`GpuResources`が持つ。 */
  private edlEnabled = DEFAULT_EDL_ENABLED;
  private edlStrength = DEFAULT_EDL_STRENGTH;
  private edlRadiusPx = DEFAULT_EDL_RADIUS_PX;

  /** M2-2: 着色モード。既定はRGB。RGBを持たないファイルへのフォールバックは
   *  呼び出し側（`src/state/useCopcViewer.ts`）が`colormap.ts`の
   *  `resolveColorMode`で行う。ここでは渡された値をそのまま使うだけにする
   *  （所有者が実装を追えるよう、フォールバックの判断を1箇所に閉じるため）。 */
  private colorMode: ColorMode = DEFAULT_COLOR_MODE;
  /** M2-2: 標高の正規化に使うレンジ。**ノードのbounds(octreeセル、立方体)
   *  ではなく、LASヘッダーの実データ範囲(`CloudInfo.min`/`max`)から決める。**
   *  `setHierarchy()`が受け取る`HierarchyNodeInfo[]`のboundsMin/boundsMaxを
   *  誤って使うと、COPCのoctreeが立方体であるためZ範囲が水平方向の広さまで
   *  引き伸ばされ、標高の色がほぼ一色に潰れる不具合になる
   *  （実機不具合の詳細は`scene-bounds.ts`ファイル冒頭のコメント、
   *  TaskSheets/M2-shading-and-ui.md M2-2参照）。呼び出し側`useCopcViewer.ts`が
   *  `openFile`成功後に`setElevationRange()`でCloudInfoの値を渡す。 */
  private elevationRange: ValueRange = { min: 0, max: 0 };
  /** M2-2: 強度の正規化に使うレンジ。標高と違い、開いた時点では分からない
   *  （`CloudInfo`は強度のレンジを持たない）。ノードが届くたびに
   *  `computeIntensityRange`でそのノード内のmin/maxを求め、`extendRange`で
   *  少しずつ広げていく（colormap.tsのコメント参照）。まだ1件もノードが
   *  届いていない間は`null`（`renderOnce`で`{min:0,max:0}`にフォールバックする）。 */
  private intensityRange: ValueRange | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new OrbitCamera([0, 0, 0], 100);
    this.cache = new NodeCache(this.pointBudget * CACHE_BUDGET_MULTIPLIER);
    this.gpu = new GpuResources((message) => this.reportGpuError(message));
  }

  async init(): Promise<void> {
    await this.gpu.init(this.canvas);

    this.resize(this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height);
    this.detachControls = attachOrbitControls(this.canvas, this.camera, {
      getCursorDirection: (screenX, screenY) => this.getCursorDirection(screenX, screenY),
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

  setDataSource(dataSource: DataSource): void {
    this.loader = new NodeLoader(
      dataSource,
      (key, node) => this.handleNodeLoaded(key, node),
      (key, error) => {
        console.error(`[renderer] failed to load node ${key}`, error);
      },
    );
  }

  /** octreeのノード一覧をセットする。データ点群を開き直したら呼ぶ。
   *
   *  **標高の正規化レンジはここでは設定しない。** ノードのbounds由来の値
   *  （このメソッドが使うのは、あくまでカメラ位置・グリッド尺度決めのため）を
   *  標高に転用すると実機不具合になるため、`setElevationRange()`を別に設け、
   *  呼び出し側がLASヘッダーの実データ範囲を明示的に渡す設計にした
   *  （`elevationRange`フィールドのコメント、`scene-bounds.ts`参照）。 */
  setHierarchy(nodes: HierarchyNodeInfo[]): void {
    this.hierarchy = nodes;

    // M2-2: 強度のレンジは実データからノードを読み込むたびに広げていく方式
    // (colorMode.private.intensityRangeのコメント参照)。新しいファイルを開いたら、
    // 前のファイルの観測値を引きずらないようリセットする。
    this.intensityRange = null;

    // カメラの初期位置・グリッドの尺度決めに使うシーンのバウンディングボックス。
    // **この`bounds`は標高カラーマップには使わない**（ノードのbounds=octreeセルは
    // 立方体で、Z範囲が水平方向の広さまで引き伸ばされているため。
    // scene-bounds.tsファイル冒頭のコメント参照）。
    const bounds = computeSceneBounds(nodes);
    if (bounds) {
      this.camera.target = bounds.center;
      this.camera.distance = bounds.diagonal;
      this.camera.setSceneScale(bounds.diagonal);

      // M2-0c補強B: グリッドの間隔・フェード距離・高さをシーンのスケールから
      // 決め直す（固定値にしないため、タスクシートの要求）。高さは上方向(upAxis)
      // 成分でのバウンディングボックス底面（点群の一番下）に置く。
      const upAxis = this.camera.getUpAxis();
      this.gridGroundHeight = bounds.min[0] * upAxis[0] + bounds.min[1] * upAxis[1] + bounds.min[2] * upAxis[2];
      this.gridCellSize = niceGridCellSize(bounds.diagonal);
      this.gridFadeDistance = gridFadeDistance(bounds.diagonal);
    }
  }

  /**
   * M2-2: 標高カラーマップの正規化レンジを、LASヘッダーの実データ範囲
   * (`CloudInfo.min`/`max`)から設定する。**`setHierarchy()`のノードbounds
   * (octreeセル、立方体)は使わないこと。** COPCのoctreeはルートが立方体な
   * ため、ノードのZ範囲は水平方向の広さまで引き伸ばされており、これを
   * 標高に使うと実機で「標高が全部紫になる」不具合になる（詳細は
   * `scene-bounds.ts`ファイル冒頭のコメント、TaskSheets/M2-shading-and-ui.md
   * M2-2参照）。呼び出し側(`useCopcViewer.ts`)が`openFile`成功直後、
   * `CloudInfo.min`/`max`をそのまま渡す。
   */
  setElevationRange(cloudMin: readonly [number, number, number], cloudMax: readonly [number, number, number]): void {
    this.elevationRange = elevationRangeFromCloudBounds(cloudMin, cloudMax);
  }

  /** キャッシュをすべて捨てる。別のファイルを開いたときに呼ぶ。 */
  clearCache(): void {
    this.cache.dispose();
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

  /**
   * M2-2: 着色モードを切り替える。RGBを持たないファイルでの`"rgb"`の
   * フォールバックはここでは行わない（呼び出し側`useCopcViewer.ts`の
   * `resolveColorMode`が既に解決した値を渡してくる前提。理由は
   * `colorMode`フィールドのコメント参照）。
   */
  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
  }

  getColorMode(): ColorMode {
    return this.colorMode;
  }

  /** 統計（描画点数・ロード中ノード数・fpsなど）が更新されるたびに呼ばれる。 */
  onStatsUpdate(callback: (stats: RenderStats) => void): void {
    this.onStats = callback;
  }

  /** WebGPUのエラー（新設）が起きるたびに呼ばれる。`onStatsUpdate`と同じ形。 */
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

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.canvas.width = w;
    this.canvas.height = h;
    this.gpu.resize(w, h);
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
    const cached = this.gpu.createCachedNode(key, node);
    if (!cached) return;
    this.cache.set(cached);

    // M2-2: 強度のレンジを実データから広げていく（colorMode.private.intensityRangeの
    // コメント、colormap.tsの`extendRange`参照）。ノードが届くたびにそのノード内の
    // min/maxを求め、既知のレンジをその2値ぶんだけ広げる（狭まることはない）。
    const nodeIntensityRange = computeIntensityRange(node);
    if (nodeIntensityRange) {
      this.intensityRange = extendRange(this.intensityRange, nodeIntensityRange.min);
      this.intensityRange = extendRange(this.intensityRange, nodeIntensityRange.max);
    }
  }

  private renderOnce(time: number): void {
    if (!this.gpu.isReady()) return;

    this.frameTimestamps.push(time);
    while (this.frameTimestamps.length > 0 && time - this.frameTimestamps[0] > 1000) {
      this.frameTimestamps.shift();
    }

    this.recordFrameDelta(time);
    this.autoAdjustPointBudget(time);

    const width = this.canvas.width;
    const height = this.canvas.height;
    const aspect = width / Math.max(height, 1);
    const proj = perspective(FOV_Y_RADIANS, aspect, NEAR, FAR);
    const view = this.camera.viewMatrix();
    const viewProj = multiply(proj, view);
    this.lastViewProj = viewProj;
    const planes = frustumPlanes(viewProj);

    const selection = selectNodesForFrame(
      this.hierarchy,
      planes,
      viewProj,
      width,
      height,
      this.pointBudget,
      this.cache,
    );

    if (this.loader) {
      this.loader.setWanted(selection.wanted, (key) => this.cache.has(key));
    }

    this.gpu.drawFrame(viewProj, width, height, selection.toDraw, {
      backgroundMode: this.backgroundMode,
      gridEnabled: this.gridEnabled,
      gridCellSize: this.gridCellSize,
      gridFadeDistance: this.gridFadeDistance,
      gridGroundHeight: this.gridGroundHeight,
      edlEnabled: this.edlEnabled,
      edlStrength: this.edlStrength,
      edlRadiusPx: this.edlRadiusPx,
      cameraEye: this.camera.eye(),
      cameraTarget: this.camera.target,
      upAxis: this.camera.getUpAxis(),
      colorMode: this.colorMode,
      elevationRange: this.elevationRange,
      // まだ1件もノードが届いていない間はnull。0..0の縮退レンジを渡せば
      // gpu-resources.tsのcolorForVertex()側で「レンジ無し→常にt=0」に
      // 安全にフォールバックする（colormap.tsのnormalizeValueと同じ契約）。
      intensityRange: this.intensityRange ?? { min: 0, max: 0 },
    });

    this.updateStats(selection.toDraw, time);
  }

  private updateStats(drawn: CachedNode[], time: number): void {
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
      autoPointBudgetEnabled: this.autoPointBudgetEnabled,
      edlEnabled: this.edlEnabled,
      edlStrength: this.edlStrength,
      colorMode: this.colorMode,
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
        limits: { min: AUTO_POINT_BUDGET_MIN, max: AUTO_POINT_BUDGET_MAX },
      },
    );
    this.autoPointBudgetConsecutiveHits = result.consecutiveHits;

    if (result.budget !== this.pointBudget) {
      this.pointBudget = result.budget;
      this.cache.maxPoints = this.pointBudget * CACHE_BUDGET_MULTIPLIER;
    }
  }
}
