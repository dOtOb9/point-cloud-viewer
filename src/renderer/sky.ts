// 空の背景（M2-0c）。
//
// 方式は手続き的なグラデーション（テクスチャ不使用）。全画面パスでビューのレイ方向から
// 色を決めるだけなので、アセットも頂点バッファも要らない（TaskSheets/M2-shading-and-ui.md
// M2-0c参照。キューブマップ・大気散乱シミュレーションは却下済み）。
//
// 守ること（タスクシートより）:
// - 点より必ず奥に描く: depthWriteEnabled=false, depthCompare="always"にして、
//   このパイプラインが深度バッファに何も書き込まない/常に通すようにする
//   （点群側のパイプラインはdepthCompare="less"のまま。空が先に描かれても、
//   その後の点はすべて手前に来る）
// - 既定で強制しない: 空 / 単色(暗) / 単色(明) を切り替えられるようにする。
//   既定は単色(暗)のまま（点のコントラストを最大にするため）
// - 地平線の下も描く: 上方向(upAxis)との内積が負の側（地平線より下）にも
//   別の色（ground）を割り当てる。空だけだと下を向いたときに背景が消えるため。

import type { Vec3 } from "./up-axis";

export type BackgroundMode = "sky" | "solid-dark" | "solid-light";

/** 既定は単色(暗)のまま。点群ビューアが暗い背景を使うのは点のコントラストが
 *  最大になるため（M2-0c）。空は選べる状態にするだけで、既定にはしない。 */
export const DEFAULT_BACKGROUND_MODE: BackgroundMode = "solid-dark";

export const SOLID_DARK_CLEAR: GPUColor = { r: 0.05, g: 0.05, b: 0.08, a: 1 };
export const SOLID_LIGHT_CLEAR: GPUColor = { r: 0.92, g: 0.93, b: 0.95, a: 1 };

interface SkyColors {
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
}

/** 空色。彩度を抑えた薄い青系のグラデーション（M3の実機で見づらければ調整する）。 */
const SKY_COLORS: SkyColors = {
  zenith: [0.16, 0.32, 0.55],
  horizon: [0.7, 0.78, 0.85],
  ground: [0.12, 0.12, 0.11],
};

const SKY_SHADER_SRC = /* wgsl */ `
struct SkyUniforms {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,          // xyzだけ使う
  upAxis: vec4<f32>,       // xyzだけ使う。M2-0b: 上方向はここでも1箇所（このuniform）を経由する
  zenithColor: vec4<f32>,  // rgbだけ使う
  horizonColor: vec4<f32>,
  groundColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: SkyUniforms;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  // 画面全体を覆う巨大三角形（頂点バッファ不要）。
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VertexOut;
  let p = positions[vertexIndex];
  out.clipPosition = vec4<f32>(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // 遠クリップ面(NDC z=1、WebGPUの深度レンジは0..1)上の点をワールド座標へ戻し、
  // カメラ位置からその点への方向を「このピクセルが見ている方向」とする。
  let farPoint4 = u.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let farPoint = farPoint4.xyz / farPoint4.w;
  let dir = normalize(farPoint - u.eye.xyz);

  let up = normalize(u.upAxis.xyz);
  let t = dot(dir, up); // 1: 天頂, 0: 地平線, -1: 真下

  var color: vec3<f32>;
  if (t >= 0.0) {
    // 地平線寄りの角度で急に暗くなるよう、指数を掛けて空らしいグラデーションにする。
    let k = pow(clamp(t, 0.0, 1.0), 0.7);
    color = mix(u.horizonColor.rgb, u.zenithColor.rgb, k);
  } else {
    // 地平線の下: 空だけだと下を向いたときに背景が消えるため、別の色(ground)へ落とす。
    let k = clamp(-t, 0.0, 1.0);
    color = mix(u.horizonColor.rgb, u.groundColor.rgb, k);
  }
  return vec4<f32>(color, 1.0);
}
`;

const SKY_UNIFORM_FLOATS = 16 /* invViewProj */ + 4 /* eye */ + 4 /* upAxis */ + 4 * 3 /* colors */;
const SKY_UNIFORM_BYTES = SKY_UNIFORM_FLOATS * 4;

/**
 * 空の全画面パス。点群のパイプラインとは別に持ち、同じレンダーパス内で
 * 点より先に描く（呼び出し側がdrawの順序を保証する。point-cloud-renderer.ts参照）。
 */
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

    const shaderModule = device.createShaderModule({ code: SKY_SHADER_SRC });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      // 深度を書かず、常に通す。点は既存の点群パイプライン(depthCompare="less")で
      // 描かれるので、空が先に描かれても点は必ず空より手前に残る。
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

  /** 同じレンダーパス内で、点群を描く前に呼ぶこと。 */
  draw(device: GPUDevice, pass: GPURenderPassEncoder, invViewProj: number[], eye: Vec3, upAxis: Vec3): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData.set(invViewProj, 0);
    this.uniformData.set([eye[0], eye[1], eye[2], 0], 16);
    this.uniformData.set([upAxis[0], upAxis[1], upAxis[2], 0], 20);
    this.uniformData.set([...SKY_COLORS.zenith, 0], 24);
    this.uniformData.set([...SKY_COLORS.horizon, 0], 28);
    this.uniformData.set([...SKY_COLORS.ground, 0], 32);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1);
  }
}

/** 背景モードに応じたクリアカラー。"sky"のときは全画面が上書きされるので任意の値でよい。 */
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
