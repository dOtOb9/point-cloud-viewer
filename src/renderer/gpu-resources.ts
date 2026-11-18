import { NODE_POINT_STRIDE, type ParsedNode } from "../datasource/node-format";
import { cameraBasis, multiply, translation, type Mat4 } from "./mat4";
import { FOV_Y_RADIANS, orthoReferenceDistance, type Projection } from "./projection";
import { type CachedNode } from "./node-cache";
import { clearColorForMode, SkyBackground, type BackgroundMode } from "./sky";
import { floorMod, GroundGrid } from "./ground-grid";
import { horizontalBasis, type Vec3 } from "./up-axis";
import { EdlPass } from "./edl";
import { DepthWindowReader } from "./depth-pick";
import { nodeFadeFactor } from "./animation";
import { ELEVATION_INTENSITY_RAMP, rampToWgslFunction, type ColorMode, type ValueRange } from "./colormap";
import type { PointShape } from "./device-profile";
import {
  decideDeviceRecovery,
  recordDeviceRecoveryAttempt,
  DEFAULT_DEVICE_RECOVERY_LIMITS,
  type DeviceRecoveryAttempt,
} from "./device-recovery";
import pointsWgsl from "./shaders/points.wgsl?raw";

export interface NodePointStyle {
  shape: PointShape;
  sizePx: number;
}
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const OFFSCREEN_COLOR_FORMAT: GPUTextureFormat = "rgba8unorm";

const NODE_UNIFORM_FIELD_BYTES = { mvp: 64, pointSizePx: 4, viewportWidth: 4, viewportHeight: 4, originZ: 4, fade: 4 };
const WGSL_UNIFORM_STRUCT_ALIGNMENT_BYTES = 16;
const UNIFORM_BUFFER_SIZE = roundUpToMultiple(
  Object.values(NODE_UNIFORM_FIELD_BYTES).reduce((sum, bytes) => sum + bytes, 0),
  WGSL_UNIFORM_STRUCT_ALIGNMENT_BYTES,
);

const NODE_UNIFORM_FLOAT_INDEX = { pointSizePx: 16, viewportWidth: 17, viewportHeight: 18, originZ: 19, fade: 20 };

function ignoreBecauseDeviceLostNeverRejects(): void {}

function roundUpToMultiple(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple;
}

const COLOR_MODE_INDEX: Record<ColorMode, number> = {
  rgb: 0,
  elevation: 1,
  intensity: 2,
  classification: 3,
};

const COLOR_SETTINGS_UNIFORM_F32_FIELDS = ["mode", "elevationMin", "elevationMax", "intensityMin", "intensityMax", "_pad0", "_pad1", "_pad2"] as const;
const COLOR_SETTINGS_UNIFORM_FLOATS = COLOR_SETTINGS_UNIFORM_F32_FIELDS.length;
const COLOR_SETTINGS_UNIFORM_BYTES = COLOR_SETTINGS_UNIFORM_FLOATS * 4;

const ELEVATION_INTENSITY_RAMP_WGSL_FN = "elevationOrIntensityRampColor";
const ELEVATION_INTENSITY_RAMP_WGSL_SRC = rampToWgslFunction(ELEVATION_INTENSITY_RAMP_WGSL_FN, ELEVATION_INTENSITY_RAMP);

const SHADER_SRC = ELEVATION_INTENSITY_RAMP_WGSL_SRC + "\n" + pointsWgsl;

export interface DrawFrameOptions {
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  gridCellSize: number;
  gridFadeDistance: number;
  gridGroundHeight: number;
  edlEnabled: boolean;
  edlStrength: number;
  edlRadiusPx: number;
  renderScale: number;
  nodeStyle: (node: CachedNode) => NodePointStyle;
  cameraEye: readonly [number, number, number];
  cameraTarget: readonly [number, number, number];
  upAxis: Vec3;
  projection: Projection;
  nowMs: number;
  fadeEnabled: boolean;
}

export class GpuResources {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private pipelineOffscreenRound: GPURenderPipeline | null = null;
  private pipelineOffscreenSquare: GPURenderPipeline | null = null;
  private pipelineSwapchainRound: GPURenderPipeline | null = null;
  private pipelineSwapchainSquare: GPURenderPipeline | null = null;
  private pipelineOffscreenRoundFade: GPURenderPipeline | null = null;
  private pipelineOffscreenSquareFade: GPURenderPipeline | null = null;
  private pipelineSwapchainRoundFade: GPURenderPipeline | null = null;
  private pipelineSwapchainSquareFade: GPURenderPipeline | null = null;
  private readonly pointGroupsScratch: CachedNode[][] = [[], [], [], []];
  private uniformLayout: GPUBindGroupLayout | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

  private readonly sky = new SkyBackground();
  private readonly grid = new GroundGrid();
  private readonly edl = new EdlPass();

  private offscreenColorTexture: GPUTexture | null = null;
  private offscreenColorView: GPUTextureView | null = null;
  private offscreenDepthTexture: GPUTexture | null = null;
  private offscreenDepthView: GPUTextureView | null = null;

  private lastWidth = 1;
  private lastHeight = 1;
  private canvas: HTMLCanvasElement | null = null;
  private recentRecoveryAttempts: DeviceRecoveryAttempt[] = [];
  private disposed = false;

  constructor(
    private readonly reportError: (message: string) => void,
    private readonly onDeviceRecovered: () => void,
  ) {}

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    await this.setupDevice();
  }

  private async setupDevice(): Promise<void> {
    const canvas = this.canvas;
    if (!canvas) {
      throw new Error("setupDevice() called before init() (canvas is not set)");
    }
    if (!("gpu" in navigator) || !navigator.gpu) {
      throw new Error("WebGPU is not supported (navigator.gpu is missing)");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("navigator.gpu.requestAdapter() returned null");
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("failed to get a webgpu canvas context");
    }

    device.onuncapturederror = (event) => {
      this.reportError(event.error.message);
    };
    device.lost
      .then((info) => this.handleDeviceLost(info))
      .catch(ignoreBecauseDeviceLostNeverRejects);

    this.device = device;
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });

    await this.initWithErrorScope(device, "点群パイプラインの生成", () => {
      this.uniformLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform" },
          },
        ],
      });

      const shaderModule = device.createShaderModule({ code: SHADER_SRC });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout] });
      const vertexState: GPUVertexState = {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: NODE_POINT_STRIDE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "unorm8x4" },
              { shaderLocation: 2, offset: 16, format: "uint32" },
            ],
          },
        ],
      };

      const buildPointsPipeline = (fragmentEntryPoint: string, targetFormat: GPUTextureFormat): GPURenderPipeline =>
        device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: vertexState,
          fragment: {
            module: shaderModule,
            entryPoint: fragmentEntryPoint,
            targets: [{ format: targetFormat }],
          },
          primitive: { topology: "triangle-list" },
          depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
        });

      this.pipelineOffscreenRound = buildPointsPipeline("fs_main_round", OFFSCREEN_COLOR_FORMAT);
      this.pipelineOffscreenSquare = buildPointsPipeline("fs_main_square", OFFSCREEN_COLOR_FORMAT);
      this.pipelineSwapchainRound = buildPointsPipeline("fs_main_round", this.format);
      this.pipelineSwapchainSquare = buildPointsPipeline("fs_main_square", this.format);
      this.pipelineOffscreenRoundFade = buildPointsPipeline("fs_main_round_fade", OFFSCREEN_COLOR_FORMAT);
      this.pipelineOffscreenSquareFade = buildPointsPipeline("fs_main_square_fade", OFFSCREEN_COLOR_FORMAT);
      this.pipelineSwapchainRoundFade = buildPointsPipeline("fs_main_round_fade", this.format);
      this.pipelineSwapchainSquareFade = buildPointsPipeline("fs_main_square_fade", this.format);
    });

    await this.initWithErrorScope(device, "空の背景(sky)の初期化", () => {
      this.sky.init(device, this.format, DEPTH_FORMAT);
    });
    await this.initWithErrorScope(device, "地面グリッド(ground-grid)の初期化", () => {
      this.grid.init(device, this.format, DEPTH_FORMAT);
    });
    await this.initWithErrorScope(device, "EDL合成パイプラインの初期化", () => {
      this.edl.init(device, this.format, DEPTH_FORMAT);
    });
  }

  private async handleDeviceLost(info: GPUDeviceLostInfo): Promise<void> {
    if (this.disposed) return;

    this.reportError(`WebGPUデバイスが失われました (reason=${info.reason}): ${info.message}`);

    if (info.reason === "destroyed") return;

    const now = Date.now();
    const decision = decideDeviceRecovery(this.recentRecoveryAttempts, now, DEFAULT_DEVICE_RECOVERY_LIMITS);
    if (!decision.shouldRecover) {
      this.reportError(`WebGPUデバイスへの復帰を諦めました: ${decision.reason}`);
      return;
    }
    this.recentRecoveryAttempts = recordDeviceRecoveryAttempt(
      this.recentRecoveryAttempts,
      now,
      DEFAULT_DEVICE_RECOVERY_LIMITS,
    );

    this.device = null;

    try {
      await this.setupDevice();
      this.resize(this.lastWidth, this.lastHeight);
      this.onDeviceRecovered();
      this.reportError("WebGPUデバイスから復帰しました(読み込み済みのノードは破棄し、再読み込みします)");
    } catch (e) {
      this.reportError(`WebGPUデバイスへの復帰に失敗しました: ${String(e)}`);
    }
  }

  private async initWithErrorScope(device: GPUDevice, label: string, fn: () => void): Promise<void> {
    device.pushErrorScope("validation");
    fn();
    const error = await device.popErrorScope();
    if (error) {
      this.reportError(`${label}でバリデーションエラー: ${error.message}`);
    }
  }

  isReady(): boolean {
    return !!(
      this.device &&
      this.context &&
      this.pipelineOffscreenRound &&
      this.pipelineOffscreenSquare &&
      this.pipelineSwapchainRound &&
      this.pipelineSwapchainSquare &&
      this.depthView
    );
  }

  resize(width: number, height: number): void {
    this.lastWidth = width;
    this.lastHeight = height;
    if (!this.device) return;
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthView = this.depthTexture.createView();

    this.offscreenColorTexture?.destroy();
    this.offscreenColorTexture = this.device.createTexture({
      size: [width, height],
      format: OFFSCREEN_COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenColorView = this.offscreenColorTexture.createView();

    this.offscreenDepthTexture?.destroy();
    this.offscreenDepthTexture = this.device.createTexture({
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenDepthView = this.offscreenDepthTexture.createView();

    this.edl.updateInputTextures(this.device, this.offscreenColorView, this.offscreenDepthView);
  }

  createColorSettingsBuffer(): GPUBuffer | null {
    if (!this.device) return null;
    return this.device.createBuffer({
      size: COLOR_SETTINGS_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  writeColorSettings(
    buffer: GPUBuffer,
    colorMode: ColorMode,
    elevationRange: ValueRange,
    intensityRange: ValueRange,
  ): void {
    if (!this.device) return;
    const data = new Float32Array(COLOR_SETTINGS_UNIFORM_FLOATS);
    data[0] = COLOR_MODE_INDEX[colorMode];
    data[1] = elevationRange.min;
    data[2] = elevationRange.max;
    data[3] = intensityRange.min;
    data[4] = intensityRange.max;
    this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  }

  createCachedNode(key: string, node: ParsedNode, colorSettingsBuffer: GPUBuffer): CachedNode | null {
    if (!this.device || !this.uniformLayout) return null;
    const device = this.device;

    const vertexBuffer = device.createBuffer({
      size: Math.max(node.pointsBytes.byteLength, NODE_POINT_STRIDE),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      vertexBuffer,
      0,
      node.pointsBytes.buffer,
      node.pointsBytes.byteOffset,
      node.pointsBytes.byteLength,
    );

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: this.uniformLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: colorSettingsBuffer } },
      ],
    });

    return {
      key,
      origin: node.origin,
      pointCount: node.pointCount,
      vertexBuffer,
      uniformBuffer,
      bindGroup,
      firstDrawnAtMs: null,
    };
  }

  drawFrame(viewProj: Mat4, width: number, height: number, nodes: CachedNode[], options: DrawFrameOptions): void {
    const device = this.device;
    const context = this.context;
    const depthView = this.depthView;
    const offscreenColorView = this.offscreenColorView;
    const offscreenDepthView = this.offscreenDepthView;
    if (
      !device ||
      !context ||
      !depthView ||
      !offscreenColorView ||
      !offscreenDepthView ||
      !this.pipelineOffscreenRound ||
      !this.pipelineOffscreenSquare ||
      !this.pipelineSwapchainRound ||
      !this.pipelineSwapchainSquare ||
      !this.pipelineOffscreenRoundFade ||
      !this.pipelineOffscreenSquareFade ||
      !this.pipelineSwapchainRoundFade ||
      !this.pipelineSwapchainSquareFade
    ) {
      return;
    }

    const encoder = device.createCommandEncoder();

    if (options.edlEnabled) {
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
      const pipelines: PointPipelines = {
        round: this.pipelineOffscreenRound,
        square: this.pipelineOffscreenSquare,
        roundFade: this.pipelineOffscreenRoundFade,
        squareFade: this.pipelineOffscreenSquareFade,
      };
      this.drawPoints(device, pointsPass, pipelines, viewProj, width, height, nodes, options);
      pointsPass.end();

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: clearColorForMode(options.backgroundMode),
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
      this.drawBackground(device, pass, options, width, height);

      this.edl.draw(
        device,
        pass,
        options.edlStrength,
        options.edlRadiusPx * options.renderScale,
        options.projection.near,
        options.projection.far,
        width,
        height,
        orthoReferenceDistance(options.projection),
      );

      pass.end();
    } else {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: clearColorForMode(options.backgroundMode),
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
      this.drawBackground(device, pass, options, width, height);
      const pipelines: PointPipelines = {
        round: this.pipelineSwapchainRound,
        square: this.pipelineSwapchainSquare,
        roundFade: this.pipelineSwapchainRoundFade,
        squareFade: this.pipelineSwapchainSquareFade,
      };
      this.drawPoints(device, pass, pipelines, viewProj, width, height, nodes, options);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  }

  private drawBackground(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    options: DrawFrameOptions,
    width: number,
    height: number,
  ): void {
    if (options.backgroundMode !== "sky" && !options.gridEnabled) return;

    const upAxis = options.upAxis;
    const eye = options.cameraEye;

    const { forward, right, up } = cameraBasis(eye, options.cameraTarget, upAxis);
    const aspect = width / Math.max(height, 1);
    const tanHalfFovY = Math.tan(FOV_Y_RADIANS / 2);
    const rightScaled: Vec3 = [right[0] * aspect * tanHalfFovY, right[1] * aspect * tanHalfFovY, right[2] * aspect * tanHalfFovY];
    const upScaled: Vec3 = [up[0] * tanHalfFovY, up[1] * tanHalfFovY, up[2] * tanHalfFovY];
    const orthographic = options.projection.mode === "orthographic";
    const halfHeight = options.projection.halfHeight;
    const gridRightScaled: Vec3 = orthographic
      ? [right[0] * aspect * halfHeight, right[1] * aspect * halfHeight, right[2] * aspect * halfHeight]
      : rightScaled;
    const gridUpScaled: Vec3 = orthographic ? [up[0] * halfHeight, up[1] * halfHeight, up[2] * halfHeight] : upScaled;

    if (options.backgroundMode === "sky") {
      this.sky.draw(device, pass, forward, rightScaled, upScaled, upAxis);
    }
    if (options.gridEnabled) {
      const { right: gridRight, forward: gridForward } = horizontalBasis(upAxis);
      const eyeHeight = eye[0] * upAxis[0] + eye[1] * upAxis[1] + eye[2] * upAxis[2];
      const eyeGridRight = eye[0] * gridRight[0] + eye[1] * gridRight[1] + eye[2] * gridRight[2];
      const eyeGridForward = eye[0] * gridForward[0] + eye[1] * gridForward[1] + eye[2] * gridForward[2];
      this.grid.draw(
        device,
        pass,
        forward,
        gridRightScaled,
        gridUpScaled,
        upAxis,
        gridRight,
        gridForward,
        options.gridGroundHeight - eyeHeight,
        options.gridCellSize,
        options.gridFadeDistance,
        floorMod(eyeGridRight, options.gridCellSize),
        floorMod(eyeGridForward, options.gridCellSize),
        orthographic,
      );
    }
  }

  private drawPoints(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    pipelines: PointPipelines,
    viewProj: Mat4,
    width: number,
    height: number,
    nodes: CachedNode[],
    options: DrawFrameOptions,
  ): void {
    const uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    const groups = this.pointGroupsScratch;
    for (const g of groups) g.length = 0;

    for (const node of nodes) {
      const square = options.nodeStyle(node).shape === "square";
      const fading = nodeFadeFactor(node.firstDrawnAtMs, options.nowMs, options.fadeEnabled) < 1;
      groups[groupIndex(square, fading)].push(node);
    }
    const order: Array<[boolean, boolean, GPURenderPipeline]> = [
      [false, false, pipelines.round],
      [true, false, pipelines.square],
      [false, true, pipelines.roundFade],
      [true, true, pipelines.squareFade],
    ];
    for (const [square, fading, pipeline] of order) {
      const list = groups[groupIndex(square, fading)];
      if (list.length === 0) continue;
      pass.setPipeline(pipeline);
      for (const node of list) {
        const fade = fading ? nodeFadeFactor(node.firstDrawnAtMs, options.nowMs, options.fadeEnabled) : 1;
        const scaledPointSizePx = options.nodeStyle(node).sizePx * options.renderScale;
        this.drawNode(device, pass, node, viewProj, width, height, scaledPointSizePx, fade, uniformData);
      }
      list.length = 0;
    }
  }

  private drawNode(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    node: CachedNode,
    viewProj: Mat4,
    width: number,
    height: number,
    scaledPointSizePx: number,
    fade: number,
    uniformData: Float32Array,
  ): void {
    const model = translation(node.origin[0], node.origin[1], node.origin[2]);
    const mvp = multiply(viewProj, model);
    uniformData.set(mvp, 0);
    uniformData[NODE_UNIFORM_FLOAT_INDEX.pointSizePx] = scaledPointSizePx;
    uniformData[NODE_UNIFORM_FLOAT_INDEX.viewportWidth] = width;
    uniformData[NODE_UNIFORM_FLOAT_INDEX.viewportHeight] = height;
    uniformData[NODE_UNIFORM_FLOAT_INDEX.originZ] = node.origin[2];
    uniformData[NODE_UNIFORM_FLOAT_INDEX.fade] = fade;
    device.queue.writeBuffer(node.uniformBuffer, 0, uniformData.buffer, uniformData.byteOffset, uniformData.byteLength);

    pass.setBindGroup(0, node.bindGroup);
    pass.setVertexBuffer(0, node.vertexBuffer);
    pass.draw(6, node.pointCount);
  }

  private readonly depthReader = new DepthWindowReader();

  readDepthWindow(x0: number, y0: number, size: number, edlEnabled: boolean): Promise<Float32Array | null> {
    const device = this.device;
    const texture = edlEnabled ? this.offscreenDepthTexture : this.depthTexture;
    if (!device || !texture) return Promise.resolve(null);
    return this.depthReader.read(device, texture, x0, y0, size);
  }

  async renderDepthWindow(
    viewProj: Mat4,
    size: number,
    nodes: CachedNode[],
    options: DrawFrameOptions,
  ): Promise<Float32Array | null> {
    const device = this.device;
    const pipelineRound = this.pipelineOffscreenRound;
    const pipelineSquare = this.pipelineOffscreenSquare;
    const fadeRound = this.pipelineOffscreenRoundFade;
    const fadeSquare = this.pipelineOffscreenSquareFade;
    if (!device || !pipelineRound || !pipelineSquare || !fadeRound || !fadeSquare) return null;

    const color = device.createTexture({ size: [size, size], format: OFFSCREEN_COLOR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const depth = device.createTexture({
      size: [size, size],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    try {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: color.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "discard" }],
        depthStencilAttachment: { view: depth.createView(), depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store" },
      });
      const pipelines: PointPipelines = { round: pipelineRound, square: pipelineSquare, roundFade: fadeRound, squareFade: fadeSquare };
      const noFade = { ...options, fadeEnabled: false };
      this.drawPoints(device, pass, pipelines, viewProj, size, size, nodes, noFade);
      pass.end();
      device.queue.submit([encoder.finish()]);
      return await this.depthReader.read(device, depth, 0, 0, size);
    } finally {
      color.destroy();
      depth.destroy();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.depthTexture?.destroy();
    this.offscreenColorTexture?.destroy();
    this.offscreenDepthTexture?.destroy();
  }
}

interface PointPipelines {
  round: GPURenderPipeline;
  square: GPURenderPipeline;
  roundFade: GPURenderPipeline;
  squareFade: GPURenderPipeline;
}

function groupIndex(square: boolean, fading: boolean): number {
  return (fading ? 2 : 0) + (square ? 1 : 0);
}
