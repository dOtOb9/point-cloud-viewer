import depthWindowWgsl from "./shaders/depth-window.wgsl?raw";

export class DepthWindowReader {
  private pipeline: GPUComputePipeline | null = null;
  private pipelineDevice: GPUDevice | null = null;

  private ensurePipeline(device: GPUDevice): GPUComputePipeline {
    if (this.pipeline && this.pipelineDevice === device) return this.pipeline;
    this.pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: depthWindowWgsl }), entryPoint: "main" },
    });
    this.pipelineDevice = device;
    return this.pipeline;
  }

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
