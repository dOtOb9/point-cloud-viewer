// 点群のWebGPU描画パイプライン本体。M1-3: COPCを1つ開き、まず1ノード（ルート）だけを
// 出す。LODはまだ入れない（M1-4で複数ノードのoctree LODに置き換える）。
//
// 規約3（ARCHITECTURE.md）: このファイルはReactを知らない。canvasと`DataSource`だけを
// 受け取る。UIから触るときは `src/state/` を経由すること。

import type { DataSource } from "../datasource/DataSource";
import { NODE_POINT_STRIDE, parseNodeBuffer, type ParsedNode } from "../datasource/node-format";
import { attachOrbitControls, OrbitCamera } from "./orbit-camera";
import { multiply, perspective, translation, type Mat4 } from "./mat4";

const FOV_Y_RADIANS = Math.PI / 3;
const NEAR = 0.01;
const FAR = 1e7;
const POINT_SIZE_PX = 4;

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

interface LoadedNode {
  origin: readonly [number, number, number];
  pointCount: number;
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

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

  private dataSource: DataSource | null = null;
  private node: LoadedNode | null = null;
  private rafHandle = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new OrbitCamera([0, 0, 0], 100);
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
    this.detachControls = attachOrbitControls(this.canvas, this.camera);
  }

  setDataSource(dataSource: DataSource): void {
    this.dataSource = dataSource;
  }

  /** ルートノード（"0-0-0-0"）だけを読み込んで表示する。M1-3のスコープ。 */
  async loadRootNode(rootBoundsMin: readonly [number, number, number], rootBoundsMax: readonly [number, number, number]): Promise<void> {
    if (!this.dataSource) throw new Error("setDataSource() must be called before loadRootNode()");

    const center: [number, number, number] = [
      (rootBoundsMin[0] + rootBoundsMax[0]) / 2,
      (rootBoundsMin[1] + rootBoundsMax[1]) / 2,
      (rootBoundsMin[2] + rootBoundsMax[2]) / 2,
    ];
    const diagonal =
      Math.hypot(
        rootBoundsMax[0] - rootBoundsMin[0],
        rootBoundsMax[1] - rootBoundsMin[1],
        rootBoundsMax[2] - rootBoundsMin[2],
      ) || 100;
    this.camera.target = center;
    this.camera.distance = diagonal;

    const buffer = await this.dataSource.readNode("0-0-0-0");
    const parsed = parseNodeBuffer(buffer);
    this.uploadNode(parsed);
  }

  private uploadNode(node: ParsedNode): void {
    if (!this.device || !this.uniformLayout) return;

    this.node?.vertexBuffer.destroy();
    this.node?.uniformBuffer.destroy();

    const vertexBuffer = this.device.createBuffer({
      size: Math.max(node.pointsBytes.byteLength, NODE_POINT_STRIDE),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
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

    this.node = {
      origin: node.origin,
      pointCount: node.pointCount,
      vertexBuffer,
      uniformBuffer,
      bindGroup,
    };
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
    const frame = () => {
      if (this.disposed) return;
      this.renderOnce();
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
    this.node?.vertexBuffer.destroy();
    this.node?.uniformBuffer.destroy();
    this.depthTexture?.destroy();
  }

  private renderOnce(): void {
    if (!this.device || !this.context || !this.pipeline || !this.depthView) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const aspect = width / Math.max(height, 1);
    const proj = perspective(FOV_Y_RADIANS, aspect, NEAR, FAR);
    const view = this.camera.viewMatrix();
    const viewProj = multiply(proj, view);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this.pipeline);

    if (this.node) {
      this.drawNode(this.node, viewProj, width, height, pass);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private drawNode(node: LoadedNode, viewProj: Mat4, width: number, height: number, pass: GPURenderPassEncoder): void {
    if (!this.device) return;
    const model = translation(node.origin[0], node.origin[1], node.origin[2]);
    const mvp = multiply(viewProj, model);

    const uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    uniformData.set(mvp, 0);
    uniformData[16] = POINT_SIZE_PX;
    uniformData[17] = width;
    uniformData[18] = height;
    uniformData[19] = 0;
    this.device.queue.writeBuffer(node.uniformBuffer, 0, uniformData.buffer, uniformData.byteOffset, uniformData.byteLength);

    pass.setBindGroup(0, node.bindGroup);
    pass.setVertexBuffer(0, node.vertexBuffer);
    pass.draw(6, node.pointCount);
  }
}
