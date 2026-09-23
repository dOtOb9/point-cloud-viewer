// 点群のWebGPU描画パイプライン本体。M1-3（1ノード描画・orbitカメラ）に続き、
// M1-4のoctree LOD（画面空間誤差での優先度付け・視錐台カリング・点予算・
// ノードキャッシュ・非同期ロード）をここに実装する。統計表示は次のコミットで足す。
//
// 規約3（ARCHITECTURE.md）: このファイルはReactを知らない。canvasと`DataSource`だけを
// 受け取る。UIから触るときは `src/state/` を経由すること。

import type { DataSource, HierarchyNodeInfo } from "../datasource/DataSource";
import { NODE_POINT_STRIDE, type ParsedNode } from "../datasource/node-format";
import { attachOrbitControls, OrbitCamera } from "./orbit-camera";
import { cameraBasis, multiply, perspective, translation, type Mat4 } from "./mat4";
import { aabbIntersectsFrustum, frustumPlanes, type Plane } from "./frustum";
import { screenSpaceError } from "./screen-space-error";
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
import { clearColorForMode, DEFAULT_BACKGROUND_MODE, SkyBackground, type BackgroundMode } from "./sky";
import { DEFAULT_GRID_ENABLED, floorMod, gridFadeDistance, GroundGrid, niceGridCellSize } from "./ground-grid";
import { horizontalBasis, type Vec3 } from "./up-axis";
import { DEFAULT_EDL_ENABLED, DEFAULT_EDL_RADIUS_PX, DEFAULT_EDL_STRENGTH, EdlPass } from "./edl";

const DEFAULT_POINT_BUDGET = 3_000_000;
/** キャッシュは点予算より少し余裕を持たせる（視点を少し動かしただけの再取得を防ぐ）。 */
const CACHE_BUDGET_MULTIPLIER = 2;

/**
 * タスクB（ADR-0010で刷新）: 点キャッシュに割り当てる想定メモリ予算(バイト)。
 *
 * **この数値は実測していない、未検証の初期値。** ADR-0009の対象端末
 * （OPPO Pad Air / RAM 4GB）を念頭に、点群キャッシュ以外にOS・アプリ本体・
 * UI・テクスチャ等が別途メモリを使うことを踏まえ、4GBを丸ごと点キャッシュに
 * 割り当てるのは無理があるという保守的な見立てで256MiBとした。
 * 実機での検証は[M3-8](../../TaskSheets/M3-release-and-update.md)に送る。
 */
const POINT_CACHE_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

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

/** 自動調整の判断に使う直近フレームの本数。ADR-0009:「判断は数フレームの中央値で
 *  行う。単発の重いフレーム（ノード到着時など）に反応しない」。 */
const AUTO_POINT_BUDGET_FRAME_HISTORY = 20;
/** まだ1フレームも記録していない起動直後だけ使うフォールバック値。
 *  `updateRefreshIntervalEstimate`で実際の値が1回でも記録されればすぐに
 *  上書きされる（60Hz相当を仮の初期値にしているだけで、決め打ちの目標では
 *  ない）。 */
const FALLBACK_REFRESH_INTERVAL_MS = 1000 / 60;
const POINT_SIZE_PX = 4;
const FOV_Y_RADIANS = Math.PI / 3;
const NEAR = 0.01;
const FAR = 1e7;
/** 深度バッファのフォーマット。点群パイプラインと空パイプライン(sky.ts)の両方が
 *  同じレンダーパスに参加するので、1箇所にまとめて食い違いを防ぐ。 */
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
/**
 * M2-1: 点群だけを描くオフスクリーンの色テクスチャのフォーマット。スワップチェーンの
 * フォーマット(`bgra8unorm`等、環境依存)とは独立に固定値にしておく。EDLの合成パス
 * (edl.ts)がこのテクスチャを`texture_2d<f32>`として読むだけで、直接画面に出す
 * わけではないため、環境ごとに変わるスワップチェーンのフォーマットに合わせる
 * 理由が無い。`rgba8unorm`はRENDER_ATTACHMENT/TEXTURE_BINDINGの両方をWebGPUの
 * どの実装でも標準でサポートするフォーマット。
 */
const OFFSCREEN_COLOR_FORMAT: GPUTextureFormat = "rgba8unorm";
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
}

const UNIFORM_BUFFER_SIZE = 80; // mat4(64) + pointSizePx(4) + viewportWidth(4) + viewportHeight(4) + pad(4)

const SHADER_SRC = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4<f32>,
  pointSizePx: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexIn {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
};

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let corner = corners[in.vertexIndex];

  let clip = u.mvp * vec4<f32>(in.position, 1.0);

  // 画面空間で一定のピクセルサイズにする。clip.w を掛けてから頂点座標に足すことで、
  // パースペクティブ除算（GPUが自動でxyz/wする）が起きても見た目のピクセルサイズが
  // 変わらないようにする（距離で小さくならない固定サイズ）。
  let ndcHalf = vec2<f32>(u.pointSizePx / u.viewportWidth, u.pointSizePx / u.viewportHeight);

  var out: VertexOut;
  out.clipPosition = vec4<f32>(clip.xy + corner * ndcHalf * clip.w, clip.z, clip.w);
  out.color = in.color;
  out.uv = corner;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // 四角形を円形に抜く。
  if (dot(in.uv, in.uv) > 1.0) {
    discard;
  }
  return in.color;
}
`;

export class PointCloudRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: OrbitCamera;
  private detachControls: () => void = () => {};

  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private pipeline: GPURenderPipeline | null = null;
  private uniformLayout: GPUBindGroupLayout | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

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
   *  更新する（「これまでの最小値」を覚え続ける。詳細は`point-budget.ts`）。 */
  private refreshIntervalEstimate: RefreshIntervalEstimate | null = null;
  private rafHandle = 0;
  private disposed = false;

  private onStats: ((stats: RenderStats) => void) | null = null;
  private lastStatsEmitAt = 0;
  private frameTimestamps: number[] = [];

  /** 空の背景（M2-0c）。既定は単色(暗)のままで、"sky"を選んだときだけ描く。 */
  private readonly sky = new SkyBackground();
  private backgroundMode: BackgroundMode = DEFAULT_BACKGROUND_MODE;

  /** 地面のグリッド（M2-0c補強B）。既定はオフ（空と同じく既定で強制しない）。 */
  private readonly grid = new GroundGrid();
  private gridEnabled = DEFAULT_GRID_ENABLED;
  /** シーンのバウンディングボックスから決める、グリッドの間隔・フェード距離・高さ。
   *  `setHierarchy()`で点群を開くたびに更新する（固定値にしないため）。 */
  private gridCellSize = 1;
  private gridFadeDistance = 100;
  private gridGroundHeight = 0;

  /** EDL陰影(M2-1)。点群だけを描いたオフスクリーンの色+深度を読み、隣接ピクセルとの
   *  深度差から陰影係数を作って合成する。空・グリッドとは別のテクスチャに
   *  点群だけを描くことで、EDLの陰影が点群にしか掛からないようにしている
   *  （分離方法の設計理由はedl.tsファイル冒頭のコメント、
   *  TaskSheets/M2-shading-and-ui.md M2-1に記録してある）。既定はオン。 */
  private readonly edl = new EdlPass();
  private edlEnabled = DEFAULT_EDL_ENABLED;
  private edlStrength = DEFAULT_EDL_STRENGTH;
  private edlRadiusPx = DEFAULT_EDL_RADIUS_PX;

  /** 点群だけを描くオフスクリーンの色・深度テクスチャ(M2-1)。スワップチェーンの
   *  `depthTexture`とは別に持つ理由: EDLの合成パスは「このピクセルに点が
   *  描かれたかどうか」を深度のクリア値で判定して空・グリッドに触れないようにする
   *  ため、点群専用の深度が要る（edl.ts参照）。`depthTexture`と同様、
   *  ウィンドウリサイズのたびに`resize()`で作り直す。 */
  private offscreenColorTexture: GPUTexture | null = null;
  private offscreenColorView: GPUTextureView | null = null;
  private offscreenDepthTexture: GPUTexture | null = null;
  private offscreenDepthView: GPUTextureView | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new OrbitCamera([0, 0, 0], 100);
    this.cache = new NodeCache(this.pointBudget * CACHE_BUDGET_MULTIPLIER);
  }

  async init(): Promise<void> {
    if (!("gpu" in navigator) || !navigator.gpu) {
      throw new Error("WebGPU is not supported (navigator.gpu is missing)");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("navigator.gpu.requestAdapter() returned null");
    }
    const device = await adapter.requestDevice();
    const context = this.canvas.getContext("webgpu");
    if (!context) {
      throw new Error("failed to get a webgpu canvas context");
    }

    this.device = device;
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });

    this.uniformLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });

    const shaderModule = device.createShaderModule({ code: SHADER_SRC });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: NODE_POINT_STRIDE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "unorm8x4" },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        // M2-1: 点群はもうスワップチェーンへ直接描かない。EDLの合成パス(edl.ts)が
        // 「点が描かれたピクセルだけ」を判定できるよう、点群専用のオフスクリーン
        // テクスチャへ描く（drawFrame()のパス1参照）。
        targets: [{ format: OFFSCREEN_COLOR_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });

    this.sky.init(device, this.format, DEPTH_FORMAT);
    this.grid.init(device, this.format, DEPTH_FORMAT);
    // EDLの合成パスはスワップチェーンのレンダーパスの中、空・グリッドの後の
    // 最後に呼ばれる(drawFrame()のパス2参照)ので、出力フォーマットはスワップ
    // チェーンに合わせる。
    this.edl.init(device, this.format);

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

  /** octreeのノード一覧をセットする。データ点群を開き直したら呼ぶ。 */
  setHierarchy(nodes: HierarchyNodeInfo[]): void {
    this.hierarchy = nodes;

    if (nodes.length > 0) {
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const node of nodes) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], node.boundsMin[axis]);
          max[axis] = Math.max(max[axis], node.boundsMax[axis]);
        }
      }
      const center: [number, number, number] = [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ];
      const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 100;
      this.camera.target = center;
      this.camera.distance = diagonal;
      this.camera.setSceneScale(diagonal);

      // M2-0c補強B: グリッドの間隔・フェード距離・高さをシーンのスケールから
      // 決め直す（固定値にしないため、タスクシートの要求）。高さは上方向(upAxis)
      // 成分でのバウンディングボックス底面（点群の一番下）に置く。
      const upAxis = this.camera.getUpAxis();
      this.gridGroundHeight = min[0] * upAxis[0] + min[1] * upAxis[1] + min[2] * upAxis[2];
      this.gridCellSize = niceGridCellSize(diagonal);
      this.gridFadeDistance = gridFadeDistance(diagonal);
    }
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

  /** 統計（描画点数・ロード中ノード数・fpsなど）が更新されるたびに呼ばれる。 */
  onStatsUpdate(callback: (stats: RenderStats) => void): void {
    this.onStats = callback;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.canvas.width = w;
    this.canvas.height = h;
    if (!this.device) return;
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();

    // M2-1: 点群だけを描くオフスクリーンの色・深度テクスチャも、スワップチェーンの
    // 深度テクスチャと同じくウィンドウサイズに合わせて作り直す。EDLの合成パスは
    // このテクスチャのバインドグループを固定で持つので、テクスチャを作り直したら
    // バインドグループも作り直す必要がある（updateInputTextures()、edl.ts参照）。
    this.offscreenColorTexture?.destroy();
    this.offscreenColorTexture = this.device.createTexture({
      size: [w, h],
      format: OFFSCREEN_COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenColorView = this.offscreenColorTexture.createView();

    this.offscreenDepthTexture?.destroy();
    this.offscreenDepthTexture = this.device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenDepthView = this.offscreenDepthTexture.createView();

    this.edl.updateInputTextures(this.device, this.offscreenColorView, this.offscreenDepthView);
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
    this.depthTexture?.destroy();
    this.offscreenColorTexture?.destroy();
    this.offscreenDepthTexture?.destroy();
  }

  private handleNodeLoaded(key: string, node: ParsedNode): void {
    if (this.disposed || !this.device || !this.uniformLayout) return;

    const vertexBuffer = this.device.createBuffer({
      size: Math.max(node.pointsBytes.byteLength, NODE_POINT_STRIDE),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // pointsBytesはfetchしたArrayBufferへのビュー。writeBufferは内容をコピーするので、
    // 元のArrayBufferをここで保持し続ける必要はない。
    this.device.queue.writeBuffer(
      vertexBuffer,
      0,
      node.pointsBytes.buffer,
      node.pointsBytes.byteOffset,
      node.pointsBytes.byteLength,
    );

    const uniformBuffer = this.device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.uniformLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    const cached: CachedNode = {
      key,
      origin: node.origin,
      pointCount: node.pointCount,
      vertexBuffer,
      uniformBuffer,
      bindGroup,
    };
    this.cache.set(cached);
  }

  private renderOnce(time: number): void {
    if (!this.device || !this.context || !this.pipeline || !this.depthView) return;

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

    const selection = this.selectNodesForThisFrame(viewProj, planes, width, height);

    if (this.loader) {
      this.loader.setWanted(selection.wanted, (key) => this.cache.has(key));
    }

    this.drawFrame(viewProj, width, height, selection.toDraw);

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
      // 判定用）とは別に、アプリ起動からの「これまでの最小値」を使う
      // （負荷が長く続く区間だけを見てしまう問題を避けるため。point-budget.ts参照）。
      this.refreshIntervalEstimate = updateRefreshIntervalEstimate(this.refreshIntervalEstimate, deltaMs);
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

  /**
   * M1-4: 画面空間誤差でノードに優先度を付け、視錐台の外を除外し、
   * 点予算を超えたら優先度の低いノードから諦める。
   */
  private selectNodesForThisFrame(
    viewProj: Mat4,
    planes: Plane[],
    width: number,
    height: number,
  ): { toDraw: CachedNode[]; wanted: { key: string; priority: number }[] } {
    const candidates: {
      key: string;
      priority: number;
      pointCount: number;
    }[] = [];

    for (const node of this.hierarchy) {
      if (!aabbIntersectsFrustum(planes, node.boundsMin, node.boundsMax)) continue;
      const priority = screenSpaceError(
        viewProj,
        node.boundsMin,
        node.boundsMax,
        node.pointCount,
        width,
        height,
      );
      candidates.push({
        key: node.key,
        priority,
        pointCount: node.pointCount,
      });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    const toDraw: CachedNode[] = [];
    const wanted: { key: string; priority: number }[] = [];
    let budgetUsed = 0;

    for (const candidate of candidates) {
      if (budgetUsed + candidate.pointCount > this.pointBudget) continue;
      budgetUsed += candidate.pointCount;

      const cached = this.cache.get(candidate.key);
      if (cached) {
        toDraw.push(cached);
      } else {
        wanted.push({ key: candidate.key, priority: candidate.priority });
      }
    }

    return { toDraw, wanted };
  }

  /**
   * M2-1: 点群・空・グリッドを2つのレンダーパスに分けて描く。
   *
   * なぜ分けたか（EDLの陰影を点群にだけ掛け、空・グリッドには掛けないという
   * タスクシートの必須要件のため）: EDLは「このピクセルと隣のピクセルの深度差」
   * から陰影を作る。空・グリッドと点群を同じ深度バッファに描いてしまうと、
   * フラグメントシェーダの中で「このピクセルは点由来か背景由来か」を区別する
   * 手段が無くなる。そこで点群だけを独立したオフスクリーンの色+深度テクスチャに
   * 先に描き(パス1)、その後スワップチェーンへ空・グリッド・EDL合成済みの点群を
   * 順に描く(パス2)。パス2の最後に呼ぶEDL合成(this.edl.draw())は、オフスクリーンの
   * 深度がクリア値のまま(=点が無い)のピクセルをdiscardするので、空・グリッドの
   * ピクセルには一切書き込まない(edl.tsファイル冒頭のコメント参照)。
   *
   * 他に検討した案: 深度バッファに1ビット立てて判定する/ステンシルバッファを
   * 使う、なども考えたが、色・深度を別テクスチャに分けたほうが「オフスクリーンに
   * 何が入っているか」がテクスチャの宣言から素直に読み取れ、既存のsky.ts/
   * ground-grid.tsのコードに一切手を入れずに済む（所有者の「実装を追えること」を
   * 優先）。
   */
  private drawFrame(viewProj: Mat4, width: number, height: number, nodes: CachedNode[]): void {
    const device = this.device;
    const context = this.context;
    const pipeline = this.pipeline;
    const depthView = this.depthView;
    const offscreenColorView = this.offscreenColorView;
    const offscreenDepthView = this.offscreenDepthView;
    if (!device || !context || !pipeline || !depthView || !offscreenColorView || !offscreenDepthView) return;

    const encoder = device.createCommandEncoder();

    // --- パス1: 点群だけをオフスクリーンへ描く ---
    // 色はクリア時にalpha=0にしておく(「まだ点が描かれていない」の目印。ただし
    // EDL合成側の判定は深度のクリア値で行っており、このalphaは直接は使っていない。
    // 深度のほうを判定に使う理由: 頂点シェーダが円形マスクの外側をdiscardしても
    // 深度は必ずクリア値のまま残るため、"点が1つも無い"ことをより確実に表す)。
    const pointsPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: offscreenColorView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: offscreenDepthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    pointsPass.setPipeline(pipeline);

    const uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    for (const node of nodes) {
      const model = translation(node.origin[0], node.origin[1], node.origin[2]);
      const mvp = multiply(viewProj, model);
      uniformData.set(mvp, 0);
      uniformData[16] = POINT_SIZE_PX;
      uniformData[17] = width;
      uniformData[18] = height;
      uniformData[19] = 0;
      device.queue.writeBuffer(
        node.uniformBuffer,
        0,
        uniformData.buffer,
        uniformData.byteOffset,
        uniformData.byteLength,
      );

      pointsPass.setBindGroup(0, node.bindGroup);
      pointsPass.setVertexBuffer(0, node.vertexBuffer);
      pointsPass.draw(6, node.pointCount);
    }

    pointsPass.end();

    // --- パス2: 背景(空/グリッド/単色)を描いてから、EDL陰影付きの点群を合成する ---
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          // "sky"のときは全画面がSkyBackgroundで上書きされるので、このclearValueは
          // 実質使われない。単色モードのときだけ見えるので、そちらの色にしておく。
          clearValue: clearColorForMode(this.backgroundMode),
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    // 空・グリッドは点より必ず奥に描く（M2-0c）。どちらも深度を書かない
    // (depthWriteEnabled=false, depthCompare="always")ので、この後に合成する点群
    // (EDL合成パスがdiscardしない限り必ず不透明に上書きする)は常に手前に残る。
    if (this.backgroundMode === "sky" || this.gridEnabled) {
      const upAxis = this.camera.getUpAxis();
      const eye = this.camera.eye();

      // 実機不具合の修正（2回。TaskSheets/M2-shading-and-ui.md M2-0c、
      // scripts/diag-sky-ray.ts参照）:
      // 1回目 - ワールド空間のinvViewProjをそのままf32でGPUに渡すと、NEAR/FAR
      //         (0.01/1e7)のダイナミックレンジとautzenのような大きなワールド座標が
      //         重なってwが桁落ちし、全ピクセルNaNになっていた
      // 2回目 - 1回目の対策（全画面三角形の3頂点のレイ方向を線形補間する方式）も
      //         壊れていた。NDC=3（三角形の頂点）は画面中心から70度以上離れており、
      //         正規化済みの単位ベクトルをこの角度で線形補間すると弦を取ることに
      //         なって長さが縮み、条件によってはNaNに戻っていた
      //         （sky.tsファイル冒頭のコメント参照）
      //
      // 対策: 行列もレイ方向の補間も使わない。カメラ基底(forward/right/up)と
      // FOV/アスペクト比から、画素ごとに`dir = normalize(forward + ndc.x*rightScaled
      // + ndc.y*upScaled)`でレイ方向を組み立てる（sky.ts/ground-grid.tsのフラグメント
      // シェーダ参照）。ここではその基底をf64で計算するだけ。扱う数値はどれも
      // 大きさ~1で、f32にキャストしても精度は落ちない。
      const { forward, right, up } = cameraBasis(eye, this.camera.target, upAxis);
      const aspect = width / Math.max(height, 1);
      const tanHalfFovY = Math.tan(FOV_Y_RADIANS / 2);
      const rightScaled: Vec3 = [right[0] * aspect * tanHalfFovY, right[1] * aspect * tanHalfFovY, right[2] * aspect * tanHalfFovY];
      const upScaled: Vec3 = [up[0] * tanHalfFovY, up[1] * tanHalfFovY, up[2] * tanHalfFovY];

      if (this.backgroundMode === "sky") {
        this.sky.draw(device, pass, forward, rightScaled, upScaled, upAxis);
      }
      if (this.gridEnabled) {
        // グリッドは空を描いた後（or 単色クリアの後）に、半透明で重ねる。
        // ここから先もすべてカメラ相対（ワールド座標の絶対値をf32で渡さない。
        // ground-grid.tsのdraw()コメント参照）。gridRight/gridForwardは
        // カメラ基底(right/up)とは別物で、シーンのupAxisに直交する水平基底
        // （グリッド平面に沿った2D座標を作るためのもの）。
        const { right: gridRight, forward: gridForward } = horizontalBasis(upAxis);
        const eyeHeight = eye[0] * upAxis[0] + eye[1] * upAxis[1] + eye[2] * upAxis[2];
        const eyeGridRight = eye[0] * gridRight[0] + eye[1] * gridRight[1] + eye[2] * gridRight[2];
        const eyeGridForward = eye[0] * gridForward[0] + eye[1] * gridForward[1] + eye[2] * gridForward[2];
        this.grid.draw(
          device,
          pass,
          forward,
          rightScaled,
          upScaled,
          upAxis,
          gridRight,
          gridForward,
          this.gridGroundHeight - eyeHeight,
          this.gridCellSize,
          this.gridFadeDistance,
          floorMod(eyeGridRight, this.gridCellSize),
          floorMod(eyeGridForward, this.gridCellSize),
        );
      }
    }

    // EDL合成(M2-1): パス1でオフスクリーンに描いた点群の色+深度を読み、隣接
    // ピクセルとの深度差から陰影を作って合成する。「オフでも同じ見た目になる」
    // という受け入れ条件は、オフのときstrength=0を渡すことで満たす
    // (edlShadingFactor()がstrength=0で常に無変化を返すため。edl.ts参照)。
    // 空・グリッドを描いた直後・最後に呼ぶことで、点群を空・グリッドの手前に
    // 不透明合成する(discardしたピクセルは背景がそのまま残る)。
    this.edl.draw(
      device,
      pass,
      this.edlEnabled ? this.edlStrength : 0,
      this.edlRadiusPx,
      NEAR,
      FAR,
      width,
      height,
    );

    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
