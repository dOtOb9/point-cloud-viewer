// L2-D: read back part of a depth texture (a size x size pixel window) to the CPU.
//
// depth24plus cannot be copied directly with copyTextureToBuffer (WebGPU rule). So a tiny
// compute shader reads the depth texture with textureLoad and writes it to a storage
// buffer, which is copied to a MAP_READ buffer and read. The window is at most 9x9 = 81
// pixels, so speed is not a concern. Pixels outside the texture are returned as 1.0
// (the "no point" clear value).
//
// The math (unprojection, window projection) lives in pick-math.ts. This file only does
// the GPU read-back.

const SHADER = /* wgsl */ `
struct Params {
  x0: i32,
  y0: i32,
  size: u32,
  pad: u32,
}
@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> outDepth: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.size || gid.y >= params.size) {
    return;
  }
  let dims = vec2<i32>(textureDimensions(depthTex));
  let p = vec2<i32>(params.x0 + i32(gid.x), params.y0 + i32(gid.y));
  var d = 1.0;
  if (p.x >= 0 && p.y >= 0 && p.x < dims.x && p.y < dims.y) {
    d = textureLoad(depthTex, p, 0);
  }
  outDepth[gid.y * params.size + gid.x] = d;
}
`;

export class DepthWindowReader {
  private pipeline: GPUComputePipeline | null = null;
  private pipelineDevice: GPUDevice | null = null;

  /** Recreate the pipeline when the device changed (recovery from device loss). */
  private ensurePipeline(device: GPUDevice): GPUComputePipeline {
    if (this.pipeline && this.pipelineDevice === device) return this.pipeline;
    this.pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: SHADER }), entryPoint: "main" },
    });
    this.pipelineDevice = device;
    return this.pipeline;
  }

  /**
   * Returns the depth of the size x size window of `texture` (depth24plus) whose top-left is
   * (x0, y0), as a row-major array of 0..1 depths (1.0 where there is no point). Throws on
   * failure (the caller routes it to the error display).
   */
  async read(device: GPUDevice, texture: GPUTexture, x0: number, y0: number, size: number): Promise<Float32Array> {
    const pipeline = this.ensurePipeline(device);
    const count = size * size;
    const byteLength = count * 4;

    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const storage = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const paramData = new ArrayBuffer(16);
      const view = new DataView(paramData);
      view.setInt32(0, x0, true);
      view.setInt32(4, y0, true);
      view.setUint32(8, size, true);
      device.queue.writeBuffer(params, 0, paramData);

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ aspect: "depth-only" }) },
          { binding: 1, resource: { buffer: storage } },
          { binding: 2, resource: { buffer: params } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(size, size);
      pass.end();
      encoder.copyBufferToBuffer(storage, 0, readback, 0, byteLength);
      device.queue.submit([encoder.finish()]);

      await readback.mapAsync(GPUMapMode.READ);
      const result = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return result;
    } finally {
      params.destroy();
      storage.destroy();
      readback.destroy();
    }
  }
}
