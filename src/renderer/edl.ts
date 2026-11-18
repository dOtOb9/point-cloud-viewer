import edlWgsl from "./shaders/edl.wgsl?raw";

export const DEFAULT_EDL_ENABLED = true;

export const DEFAULT_EDL_STRENGTH = 0.15;

export const DEFAULT_EDL_RADIUS_PX = 1.4;

export const EDL_RESPONSE_SCALE = 300.0;

export const EDL_MIN_SHADE = 0.5;

export function linearizeDepth(ndcDepth: number, near: number, far: number): number {
  return (near * far) / (far - ndcDepth * (far - near));
}

export function linearizeDepthOrtho(ndcDepth: number, near: number, far: number): number {
  return near + ndcDepth * (far - near);
}

export function edlLogDepth(eyeDistance: number): number {
  return Math.log2(eyeDistance);
}
export function edlLogDepthOrtho(eyeDistance: number, referenceDistance: number): number {
  return eyeDistance / (referenceDistance * Math.LN2);
}

export function edlShadingFactor(ownDepth: number, neighbourDepths: readonly number[], strength: number): number {
  return edlShadingFactorFromLogs(edlLogDepth(ownDepth), neighbourDepths.map(edlLogDepth), strength);
}

export function edlShadingFactorFromLogs(ownLog: number, neighbourLogs: readonly number[], strength: number): number {
  if (neighbourLogs.length === 0 || strength === 0) return 1.0;

  let sum = 0;
  for (const neighbourLog of neighbourLogs) {
    sum += Math.max(0, ownLog - neighbourLog);
  }
  const response = sum / neighbourLogs.length;

  return Math.max(EDL_MIN_SHADE, Math.exp(-response * EDL_RESPONSE_SCALE * strength));
}

const EDL_UNIFORM_F32_FIELDS = ["strength", "radiusPx", "near", "far", "viewportWidth", "viewportHeight", "orthoRef", "_pad1"] as const;
const EDL_UNIFORM_FLOATS = EDL_UNIFORM_F32_FIELDS.length;
const EDL_UNIFORM_BYTES = EDL_UNIFORM_FLOATS * 4;

function wgslFloat(value: number): string {
  return value.toFixed(4);
}

const EDL_SHADER_SRC =
  `const EDL_MIN_SHADE: f32 = ${wgslFloat(EDL_MIN_SHADE)};\n` +
  `const EDL_RESPONSE_SCALE: f32 = ${wgslFloat(EDL_RESPONSE_SCALE)};\n` +
  edlWgsl;

export class EdlPass {
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private readonly uniformData = new Float32Array(EDL_UNIFORM_FLOATS);

  init(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: EDL_SHADER_SRC });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "always" },
    });

    this.uniformBuffer = device.createBuffer({
      size: EDL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  updateInputTextures(device: GPUDevice, colorView: GPUTextureView, depthView: GPUTextureView): void {
    if (!this.bindGroupLayout || !this.uniformBuffer) return;
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: colorView },
        { binding: 2, resource: depthView },
      ],
    });
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    strength: number,
    radiusPx: number,
    near: number,
    far: number,
    viewportWidth: number,
    viewportHeight: number,
    orthoRefDistance = 0,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData[0] = strength;
    this.uniformData[1] = radiusPx;
    this.uniformData[2] = near;
    this.uniformData[3] = far;
    this.uniformData[4] = viewportWidth;
    this.uniformData[5] = viewportHeight;
    this.uniformData[6] = orthoRefDistance;
    this.uniformData[7] = 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1);
  }
}
