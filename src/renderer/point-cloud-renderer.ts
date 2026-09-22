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
import { pickWorldPointUnderCursor, type NodeAabb } from "./raycast";
import { NodeCache, type CachedNode } from "./node-cache";
import { NodeLoader } from "./node-loader";

const DEFAULT_POINT_BUDGET = 3_000_000;
/** キャッシュは点予算より少し余裕を持たせる（視点を少し動かしただけの再取得を防ぐ）。 */
const CACHE_BUDGET_MULTIPLIER = 2;
const POINT_SIZE_PX = 4;
const FOV_Y_RADIANS = Math.PI / 3;
const NEAR = 0.01;
const FAR = 1e7;
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
  /**
   * 直近フレームで実際に描画したノード（selectNodesForThisFrameのtoDraw）のAABB。
   * pickPointUnderCursorはこの集合だけを対象にする。hierarchy全体を対象にすると、
   * 内部ノードの入れ子AABBに対する最近傍判定が常に粗い外側の箱を選んでしまう
   * （M1-point-rendering.md M1-5「実機確認で見つかった不具合」参照）。
   */
  private lastDrawnAabbs: NodeAabb[] = [];

  private pointBudget = DEFAULT_POINT_BUDGET;
  private rafHandle = 0;
  private disposed = false;

  private onStats: ((stats: RenderStats) => void) | null = null;
  private lastStatsEmitAt = 0;
  private frameTimestamps: number[] = [];

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
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    this.resize(this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height);
    this.detachControls = attachOrbitControls(this.canvas, this.camera, {
      pickPointUnderCursor: (screenX, screenY) => this.pickPointUnderCursor(screenX, screenY),
    });
  }

  /**
   * カーソル位置（キャンバスのピクセル座標）の下に、直近フレームで実際に描画した
   * ノードがあれば、そのAABBとの最も近い交点を返す（M1-5）。まだ1フレームも
   * 描画していない、またはカーソルが空を指している場合はnull（呼び出し側が
   * targetへ向かって寄るフォールバックを使う）。
   *
   * 対象をthis.lastDrawnAabbs（今フレーム描画したノードだけ）に限定している。
   * this.hierarchy（全ノード）を渡すと、内部ノードの入れ子AABBのせいで常に
   * 粗い外側の箱が最近傍判定に勝ってしまう不具合があった。
   */
  private pickPointUnderCursor(screenX: number, screenY: number): [number, number, number] | null {
    if (!this.lastViewProj) return null;
    return pickWorldPointUnderCursor(
      this.lastViewProj,
      screenX,
      screenY,
      this.canvas.width,
      this.canvas.height,
      this.lastDrawnAabbs,
    );
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
      format: "depth24plus",
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
    this.lastDrawnAabbs = selection.toDrawAabbs;

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
  ): { toDraw: CachedNode[]; toDrawAabbs: NodeAabb[]; wanted: { key: string; priority: number }[] } {
    const candidates: {
      key: string;
      priority: number;
      pointCount: number;
      boundsMin: readonly [number, number, number];
      boundsMax: readonly [number, number, number];
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
        boundsMin: node.boundsMin,
        boundsMax: node.boundsMax,
      });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    const toDraw: CachedNode[] = [];
    const toDrawAabbs: NodeAabb[] = [];
    const wanted: { key: string; priority: number }[] = [];
    let budgetUsed = 0;

    for (const candidate of candidates) {
      if (budgetUsed + candidate.pointCount > this.pointBudget) continue;
      budgetUsed += candidate.pointCount;

      const cached = this.cache.get(candidate.key);
      if (cached) {
        toDraw.push(cached);
        toDrawAabbs.push({ boundsMin: candidate.boundsMin, boundsMax: candidate.boundsMax });
      } else {
        wanted.push({ key: candidate.key, priority: candidate.priority });
      }
    }

    return { toDraw, toDrawAabbs, wanted };
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
          clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
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
