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
//
// 補強（M2-0c 実機報告への対応）: 所有者が段階2を実機で見て「地平線が分からない。
// 地面がない？」と報告した。原因はグラデーションだけでは境界が無く、色が
// 滑らかに変わる面にしか見えないこと。対策として、(1) groundColorをhorizonColorと
// 明度・色相ともにはっきり分け、(2) t=0の近傍に細い地平線（horizonLineColor）を
// 明示的に描く。地面のグリッドは別ファイル(ground-grid.ts)で扱う。
//
// 修正（実機報告: 空にすると地面しか見えない）: 当初はワールド空間のviewProjの
// 逆行列(invViewProj)をそのままuniformに積んでf32でGPUに渡し、フラグメント
// シェーダで`invViewProj * ndc`からレイ方向を復元していた。これは`mat4.ts`冒頭の
// 規約（ワールド座標そのものを行列に持たせない）に反していた: NEAR(0.01)/FAR(1e7)の
// ダイナミックレンジにautzenのような大きなワールド座標（X約637,000）が重なると、
// 逆行列の成分は1e-9〜1e8桁まで開く。f32(有効桁約7桁)ではこれを表現しきれず、
// 変換後のwが桁落ちして0になり、`xyz / w`がInf、`normalize`がNaNになっていた
// （`scripts/diag-sky-ray.ts`で再現・実測済み）。WGSLは`NaN >= 0.0`がfalseなので
// 全ピクセルがelse分岐（groundColor）に落ち、「空にすると地面しか見えない」形で
// 現れていた。
//
// 対策: 行列(invViewProj)もeyeもGPUに渡さない。JS側(f64)で`raycast.ts`の
// `ndcPointToWorldRay`を使い、全画面三角形の3頂点それぞれのレイ方向を求めておく
// （方向は正規化済みで大きさ~1なので、f32にキャストしても精度の問題が起きない）。
// 頂点シェーダは`@builtin(vertex_index)`でこの3方向から1つを選んで
// `@location`で渡すだけ。線形補間したものをフラグメントシェーダで`normalize`
// すれば、各ピクセルのレイ方向になる（詳細はdraw()のコメント参照）。

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
  /** 地平線より下の色。horizonとは明度・色相の両方ではっきり区別すること
   *  （実機報告: 単なる濃淡だけでは「境界のある地面」に見えなかった）。 */
  ground: Vec3;
  /** 地平線そのものに引く細い線の色。グラデーションだけでは境界が読めなかった
   *  という実機報告への対策（M2-0c補強）。 */
  horizonLine: Vec3;
}

/** 空色。彩度を抑えた薄い青系のグラデーション（M3の実機で見づらければ調整する）。
 *  groundは青系のsky/horizonと違う中立な暗色にして、明度だけでなく色相でも
 *  空とはっきり区別できるようにしてある。 */
const SKY_COLORS: SkyColors = {
  zenith: [0.12, 0.24, 0.45],
  horizon: [0.75, 0.8, 0.83],
  ground: [0.05, 0.05, 0.055],
  horizonLine: [0.95, 0.95, 0.92],
};

const SKY_SHADER_SRC = /* wgsl */ `
struct SkyUniforms {
  // 全画面三角形の3頂点それぞれのレイ方向（JS側でndcPointToWorldRayを使い、f64で
  // 計算済み。ワールド空間の行列やeyeはここには無い。draw()のコメント参照）。
  dirs0: vec4<f32>,        // xyzだけ使う
  dirs1: vec4<f32>,
  dirs2: vec4<f32>,
  upAxis: vec4<f32>,       // xyzだけ使う。M2-0b: 上方向はここでも1箇所（このuniform）を経由する
  zenithColor: vec4<f32>,  // rgbだけ使う
  horizonColor: vec4<f32>,
  groundColor: vec4<f32>,
  horizonLineColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: SkyUniforms;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  // 正規化前のレイ方向。線形補間してからフラグメントシェーダでnormalizeする
  // （正規化してから補間すると、頂点ごとに違う縮尺で割ることになり、補間結果が
  // 本来の方向からずれるため。正規化は必ず補間の後）。
  @location(0) dir: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  // 画面全体を覆う巨大三角形（頂点バッファ不要）。
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var dirs = array<vec3<f32>, 3>(u.dirs0.xyz, u.dirs1.xyz, u.dirs2.xyz);
  var out: VertexOut;
  out.clipPosition = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  out.dir = dirs[vertexIndex];
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // このピクセルが見ている方向（頂点シェーダで渡した3方向を線形補間したもの）。
  let dir = normalize(in.dir);

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

  // 地平線を明示する細い線（M2-0c補強）。グラデーションの濃淡だけでは境界として
  // 読めなかったという実機報告への対策。tのスクリーン空間微分(fwidth)を線幅の
  // 基準にすることで、距離やズームによらずおよそ同じ太さの線になる。
  let lineWidth = max(fwidth(t), 0.0005) * 1.5;
  let lineFactor = 1.0 - smoothstep(0.0, lineWidth, abs(t));
  color = mix(color, u.horizonLineColor.rgb, lineFactor);

  return vec4<f32>(color, 1.0);
}
`;

const SKY_UNIFORM_FLOATS =
  4 * 3 /* dirs0/dirs1/dirs2 */ + 4 /* upAxis */ + 4 * 4 /* colors (zenith/horizon/ground/horizonLine) */;
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

  /**
   * 同じレンダーパス内で、点群を描く前に呼ぶこと。
   *
   * `vertexDirs`は全画面三角形の3頂点（NDC座標 (-1,-1), (3,-1), (-1,3)。
   * `vs_main`のpositionsと同じ並び）それぞれのレイ方向。呼び出し側
   * （point-cloud-renderer.ts）が`raycast.ts`の`ndcPointToWorldRay`をその3点で
   * 呼んで、f64のまま求める。ここではf32にキャストするだけ（方向は正規化済みで
   * 大きさ~1なので、桁落ちは起きない。invViewProjやeyeをここで扱わないのが
   * ポイント。ファイル冒頭のコメント参照）。
   */
  draw(device: GPUDevice, pass: GPURenderPassEncoder, vertexDirs: readonly [Vec3, Vec3, Vec3], upAxis: Vec3): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData.set([...vertexDirs[0], 0], 0);
    this.uniformData.set([...vertexDirs[1], 0], 4);
    this.uniformData.set([...vertexDirs[2], 0], 8);
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
