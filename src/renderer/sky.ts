import type { Vec3 } from "./up-axis";
import skyWgsl from "./shaders/sky.wgsl?raw";

export type BackgroundMode = "sky" | "solid-dark" | "solid-light";

export const DEFAULT_BACKGROUND_MODE: BackgroundMode = "solid-dark";

export const SOLID_DARK_CLEAR: GPUColor = { r: 0.05, g: 0.05, b: 0.08, a: 1 };
export const SOLID_LIGHT_CLEAR: GPUColor = { r: 0.92, g: 0.93, b: 0.95, a: 1 };

interface SkyColors {
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  horizonLine: Vec3;
}

const SKY_COLORS: SkyColors = {
  zenith: [0.08, 0.17, 0.36],
  horizon: [0.48, 0.56, 0.64],
  ground: [0.05, 0.05, 0.055],
  horizonLine: [0.7, 0.74, 0.78],
};

const SKY_UNIFORM_VEC4_FIELDS = ["forward", "rightScaled", "upScaled", "upAxis", "zenithColor", "horizonColor", "groundColor", "horizonLineColor"] as const;
const SKY_UNIFORM_FLOATS = SKY_UNIFORM_VEC4_FIELDS.length * 4;
const SKY_UNIFORM_BYTES = SKY_UNIFORM_FLOATS * 4;

export class SkyBackground {
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private readonly uniformData = new Float32Array(SKY_UNIFORM_FLOATS);

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

    const shaderModule = device.createShaderModule({ code: skyWgsl });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "always" },
    });

    this.uniformBuffer = device.createBuffer({
      size: SKY_UNIFORM_BYTES,
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
    forward: Vec3,
    rightScaled: Vec3,
    upScaled: Vec3,
    upAxis: Vec3,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData.set([...forward, 0], 0);
    this.uniformData.set([...rightScaled, 0], 4);
    this.uniformData.set([...upScaled, 0], 8);
    this.uniformData.set([upAxis[0], upAxis[1], upAxis[2], 0], 12);
    this.uniformData.set([...SKY_COLORS.zenith, 0], 16);
    this.uniformData.set([...SKY_COLORS.horizon, 0], 20);
    this.uniformData.set([...SKY_COLORS.ground, 0], 24);
    this.uniformData.set([...SKY_COLORS.horizonLine, 0], 28);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1);
  }
}

export function clearColorForMode(mode: BackgroundMode): GPUColor {
  switch (mode) {
    case "solid-light":
      return SOLID_LIGHT_CLEAR;
    case "sky":
    case "solid-dark":
    default:
      return SOLID_DARK_CLEAR;
  }
}
