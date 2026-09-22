// 点群のWebGPU描画パイプライン本体。M1-3（1ノード描画・orbitカメラ）に続き、
// M1-4のoctree LOD（画面空間誤差での優先度付け・視錐台カリング・点予算・
// ノードキャッシュ・非同期ロード）をここに実装する。統計表示は次のコミットで足す。
//
// 規約3（ARCHITECTURE.md）: このファイルはReactを知らない。canvasと`DataSource`だけを
// 受け取る。UIから触るときは `src/state/` を経由すること。

import type { DataSource, HierarchyNodeInfo } from "../datasource/DataSource";
import { NODE_POINT_STRIDE, type ParsedNode } from "../datasource/node-format";
import { attachOrbitControls, OrbitCamera } from "./orbit-camera";
import { multiply, perspective, translation, type Mat4 } from "./mat4";
import { aabbIntersectsFrustum, frustumPlanes, type Plane } from "./frustum";
import { screenSpaceError } from "./screen-space-error";
import { ndcPointToWorldRay, screenPointToWorldRay } from "./raycast";
import { NodeCache, type CachedNode } from "./node-cache";
import { NodeLoader } from "./node-loader";
import { clearColorForMode, DEFAULT_BACKGROUND_MODE, SkyBackground, type BackgroundMode } from "./sky";
import { DEFAULT_GRID_ENABLED, floorMod, gridFadeDistance, GroundGrid, niceGridCellSize } from "./ground-grid";
import { horizontalBasis, type Vec3 } from "./up-axis";

const DEFAULT_POINT_BUDGET = 3_000_000;
/** キャッシュは点予算より少し余裕を持たせる（視点を少し動かしただけの再取得を防ぐ）。 */
const CACHE_BUDGET_MULTIPLIER = 2;
const POINT_SIZE_PX = 4;
const FOV_Y_RADIANS = Math.PI / 3;
const NEAR = 0.01;
const FAR = 1e7;
/** 深度バッファのフォーマット。点群パイプラインと空パイプライン(sky.ts)の両方が
 *  同じレンダーパスに参加するので、1箇所にまとめて食い違いを防ぐ。 */
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
/** 統計をコールバックへ流す間隔(ms)。毎フレームだと呼び出し側(React state更新やRust
 *  stdoutへのinvoke)が重くなるため間引く。 */
const STATS_INTERVAL_MS = 500;

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
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });

    this.sky.init(device, this.format, DEPTH_FORMAT);
    this.grid.init(device, this.format, DEPTH_FORMAT);

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

  setPointBudget(budget: number): void {
    this.pointBudget = Math.max(1, Math.floor(budget));
    this.cache.maxPoints = this.pointBudget * CACHE_BUDGET_MULTIPLIER;
  }

  getPointBudget(): number {
    return this.pointBudget;
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
    });
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

  private drawFrame(viewProj: Mat4, width: number, height: number, nodes: CachedNode[]): void {
    const device = this.device;
    const context = this.context;
    const pipeline = this.pipeline;
    const depthView = this.depthView;
    if (!device || !context || !pipeline || !depthView) return;

    const encoder = device.createCommandEncoder();
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
    // (depthWriteEnabled=false, depthCompare="always")ので、この後に描く点群
    // (depthCompare="less")は常に手前に残る。
    if (this.backgroundMode === "sky" || this.gridEnabled) {
      const upAxis = this.camera.getUpAxis();
      const eye = this.camera.eye();

      // 実機不具合の修正（TaskSheets/M2-shading-and-ui.md M2-0c、
      // scripts/diag-sky-ray.ts参照）: ワールド空間のinvViewProjをそのままf32で
      // GPUに渡すと、NEAR/FAR(0.01/1e7)のダイナミックレンジとautzenのような
      // 大きなワールド座標が重なってwが桁落ちし、全ピクセルNaNになっていた。
      // 対策は、GPUに行列を渡すのをやめ、JS側(f64)でレイ方向だけを計算して渡すこと。
      // 全画面三角形の3頂点(sky.ts/ground-grid.tsのvs_mainのpositionsと同じNDC座標。
      // -1..1の外側にも一直線に延びる)それぞれのレイ方向を`ndcPointToWorldRay`
      // (raycast.ts。カーソルのズームで実際に使われていて正しく動く実装と同じもの)
      // で求める。方向は正規化済みで大きさ~1なので、f32にキャストしても精度は
      // 落ちない。
      const rayA = ndcPointToWorldRay(viewProj, -1, -1);
      const rayB = ndcPointToWorldRay(viewProj, 3, -1);
      const rayC = ndcPointToWorldRay(viewProj, -1, 3);

      // viewProjが特異なとき（通常は起きないが、初期化直後などの防御）はどちらも描かない。
      if (rayA && rayB && rayC) {
        const vertexDirs: readonly [Vec3, Vec3, Vec3] = [rayA.direction, rayB.direction, rayC.direction];

        if (this.backgroundMode === "sky") {
          this.sky.draw(device, pass, vertexDirs, upAxis);
        }
        if (this.gridEnabled) {
          // グリッドは空を描いた後（or 単色クリアの後）に、半透明で重ねる。
          // ここから先もすべてカメラ相対（ワールド座標の絶対値をf32で渡さない。
          // ground-grid.tsのdraw()コメント参照）。
          const { right, forward } = horizontalBasis(upAxis);
          const eyeHeight = eye[0] * upAxis[0] + eye[1] * upAxis[1] + eye[2] * upAxis[2];
          const eyeRight = eye[0] * right[0] + eye[1] * right[1] + eye[2] * right[2];
          const eyeForward = eye[0] * forward[0] + eye[1] * forward[1] + eye[2] * forward[2];
          this.grid.draw(
            device,
            pass,
            vertexDirs,
            upAxis,
            right,
            forward,
            this.gridGroundHeight - eyeHeight,
            this.gridCellSize,
            this.gridFadeDistance,
            floorMod(eyeRight, this.gridCellSize),
            floorMod(eyeForward, this.gridCellSize),
          );
        }
      }
    }

    pass.setPipeline(pipeline);

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

      pass.setBindGroup(0, node.bindGroup);
      pass.setVertexBuffer(0, node.vertexBuffer);
      pass.draw(6, node.pointCount);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
