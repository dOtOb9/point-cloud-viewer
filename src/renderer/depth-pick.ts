// L2-D: 深度テクスチャの一部（size×size ピクセルの窓）を CPU に読み戻す。
//
// 深度フォーマットの depth24plus は copyTextureToBuffer で直接コピーできない（WebGPU の規則）。
// そこで、深度テクスチャを textureLoad で読む小さな compute シェーダで storage バッファへ書き、
// それを MAP_READ のバッファへコピーして読む。窓は最大 9×9 = 81 画素なので、速さは問題にならない。
// 窓が画面の外にはみ出した画素は 1.0（= 点なしのクリア値）として返す。
//
// 数式（逆投影・窓の射影）は pick-math.ts にある。ここは GPU の読み戻しだけ。

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

  /** デバイスが変わった（消失からの復帰）ら作り直す。 */
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
   * `texture`（depth24plus）の (x0, y0) を左上とする size×size の窓の深度を、行優先の配列で返す。
   * 戻る配列は 0..1 の深度（点が無い画素は 1.0）。失敗したら例外（呼び出し側がエラー表示に流す）。
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
