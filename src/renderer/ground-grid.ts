import type { Vec3 } from "./up-axis";
import groundGridWgsl from "./shaders/ground-grid.wgsl?raw";

export const DEFAULT_GRID_ENABLED = true;

const GRID_LINE_COLOR: Vec3 = [0.55, 0.58, 0.6];
const GRID_MAX_ALPHA = 0.35;
const TARGET_CELLS_ACROSS_SCENE = 40;
const FADE_DISTANCE_RATIO = 1.5;

export function niceGridCellSize(sceneDiagonal: number): number {
  if (!(sceneDiagonal > 0) || !Number.isFinite(sceneDiagonal)) return 1;

  const target = sceneDiagonal / TARGET_CELLS_ACROSS_SCENE;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const residual = target / magnitude;

  let niceResidual: number;
  if (residual < 1.5) niceResidual = 1;
  else if (residual < 3.5) niceResidual = 2;
  else if (residual < 7.5) niceResidual = 5;
  else niceResidual = 10;

  return niceResidual * magnitude;
}

export function gridFadeDistance(sceneDiagonal: number): number {
  return (sceneDiagonal || 100) * FADE_DISTANCE_RATIO;
}

export function floorMod(a: number, m: number): number {
  return a - Math.floor(a / m) * m;
}

const GRID_UNIFORM_VEC4_FIELDS = ["viewForward", "viewRightScaled", "viewUpScaled", "upAxis", "gridRight", "gridForward", "params", "phase", "lineColor"] as const;
const GRID_UNIFORM_FLOATS = GRID_UNIFORM_VEC4_FIELDS.length * 4;
const GRID_UNIFORM_BYTES = GRID_UNIFORM_FLOATS * 4;

export class GroundGrid {
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private readonly uniformData = new Float32Array(GRID_UNIFORM_FLOATS);

  init(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    const shaderModule = device.createShaderModule({ code: groundGridWgsl });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "always" },
    });

    this.uniformBuffer = device.createBuffer({
      size: GRID_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    viewForward: Vec3,
    viewRightScaled: Vec3,
    viewUpScaled: Vec3,
    upAxis: Vec3,
    gridRight: Vec3,
    gridForward: Vec3,
    relGroundHeight: number,
    cellSize: number,
    fadeDistance: number,
    phaseU: number,
    phaseV: number,
    orthographic = false,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData.set([...viewForward, 0], 0);
    this.uniformData.set([...viewRightScaled, 0], 4);
    this.uniformData.set([...viewUpScaled, 0], 8);
    this.uniformData.set([upAxis[0], upAxis[1], upAxis[2], 0], 12);
    this.uniformData.set([gridRight[0], gridRight[1], gridRight[2], 0], 16);
    this.uniformData.set([gridForward[0], gridForward[1], gridForward[2], 0], 20);
    this.uniformData.set([relGroundHeight, cellSize, fadeDistance, orthographic ? 1 : 0], 24);
    this.uniformData.set([phaseU, phaseV, 0, 0], 28);
    this.uniformData.set([...GRID_LINE_COLOR, GRID_MAX_ALPHA], 32);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1);
  }
}
