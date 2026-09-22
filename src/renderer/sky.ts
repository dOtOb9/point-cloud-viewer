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
// - 切り替えられること: 空 / 単色(暗) / 単色(明) を選べるようにする。既定値は
//   下の`DEFAULT_BACKGROUND_MODE`のコメント、および TaskSheets/M2-shading-and-ui.md
//   M2-0cの「既定の決定」を参照（策定時の既定=単色(暗)から、実機フィードバックを
//   受けて既定=空に変更した経緯を記録してある）
// - 地平線の下も描く: 上方向(upAxis)との内積が負の側（地平線より下）にも
//   別の色（ground）を割り当てる。空だけだと下を向いたときに背景が消えるため。
//
// 補強（M2-0c 実機報告への対応）: 所有者が段階2を実機で見て「地平線が分からない。
// 地面がない？」と報告した。原因はグラデーションだけでは境界が無く、色が
// 滑らかに変わる面にしか見えないこと。対策として、(1) groundColorをhorizonColorと
// 明度・色相ともにはっきり分け、(2) t=0の近傍に細い地平線（horizonLineColor）を
// 明示的に描く。地面のグリッドは別ファイル(ground-grid.ts)で扱う。
//
// 実機不具合1回目（実機報告: 空にすると地面しか見えない）: 当初はワールド空間の
// viewProjの逆行列(invViewProj)をそのままuniformに積んでf32でGPUに渡し、
// フラグメントシェーダで`invViewProj * ndc`からレイ方向を復元していた。これは
// `mat4.ts`冒頭の規約（ワールド座標そのものを行列に持たせない）に反していた:
// NEAR(0.01)/FAR(1e7)のダイナミックレンジにautzenのような大きなワールド座標
// （X約637,000）が重なると、逆行列の成分は1e-9〜1e8桁まで開く。f32(有効桁約7桁)
// ではこれを表現しきれず、変換後のwが桁落ちして0になり、`xyz / w`がInf、
// `normalize`がNaNになっていた（`scripts/diag-sky-ray.ts`で再現・実測済み）。
// WGSLは`NaN >= 0.0`がfalseなので全ピクセルがelse分岐(groundColor)に落ち、
// 「空にすると地面しか見えない」形で現れていた。
//
// 実機不具合2回目（実機報告: 空やグリッドを入れると画面が真っ黒になる）:
// 1回目の対策として「全画面三角形の3頂点(NDC (-1,-1),(3,-1),(-1,3))それぞれの
// レイ方向(正規化済み)をuniformで渡し、頂点シェーダで@locationに渡して線形補間、
// フラグメントシェーダで再度normalize」という方式にしたが、これも壊れていた。
// NDC=3は画面の中心から見て水平半画角(FOV60°・アスペクト16:9なら約46°)の
// 3倍近い、70度以上離れた方向になる。**正規化済みの単位ベクトルをこれだけ広い
// 角度で線形補間すると、球面上の弧ではなく弦を取ることになり、結果のベクトルは
// 向きがずれるだけでなく長さが縮む**（数値検証: 画面上の位置によって補間直後の
// 長さが0.53〜1.0まで変動。角度が開くほど0に近づく設計上の欠陥）。長さがほぼ0に
// なった場所では`normalize(ほぼ0)`がNaNになり、同じNaNが別の経路で戻ってきて
// いた（「画面が真っ黒」はNaNがアルファ/カラーに伝播した結果）。
//
// **教訓（重要。次に踏みやすい罠）:**
// 1. **単位ベクトル（方向）を広い角度にわたって線形補間してはいけない。**
//    線形補間は「位置」や「まっすぐ変化する量」には正しいが、正規化された
//    方向ベクトルは球面上の点なので、弦（chord）を取ることになり、角度が
//    開くほど誤差が増え、長さが縮む。全画面三角形は画面の3倍外側まで頂点が
//    延びるため、この誤差が致命的な大きさになる
// 2. **「NaNが出ない」は正しさの証明にならない。** 1回目の修正のとき、
//    診断スクリプト(`scripts/diag-sky-ray.ts`)はNaNの有無だけを確認しており、
//    値がf64の真値と一致するかを検証していなかった。その結果、2回目の
//    不具合（値が真値から最大0.48もずれ、条件によってはNaNにもなる）を
//    見逃した。**「NaNが出ない」は必要条件であって十分条件ではない。**
//
// 対策（2回目）: 方向ベクトルの補間そのものをやめた。頂点シェーダで補間するのは
// **NDC座標（位置）だけ**にする（位置の線形補間はアフィンな量なので正しい）。
// フラグメントシェーダで、画素ごとに
//   dir = normalize(forward + ndc.x * rightScaled + ndc.y * upScaled)
// としてレイ方向を組み立てる。`forward`(カメラの視線方向)・`rightScaled`
// (right * tan(fovY/2) * アスペクト比)・`upScaled`(up * tan(fovY/2))は
// JS側(f64)で`mat4.ts`の`cameraBasis()`から求める。これはNDCがいくつでも
// 厳密で（外挿ではなく、透視投影の逆関数そのもの）、扱う数値はどれも
// 大きさ~1、行列もワールド座標の絶対値も一切GPUに渡らない
// （詳細はdraw()のコメント参照）。

import type { Vec3 } from "./up-axis";

export type BackgroundMode = "sky" | "solid-dark" | "solid-light";

/** 既定は「空」。M2-0c策定時は「点のコントラストを落とすため既定にしない」
 *  としていたが、実データを見て判断した結果、空を既定にした。経緯は
 *  TaskSheets/M2-shading-and-ui.md M2-0cに記録している（方針転換ではなく、
 *  当初「実データを見て決める」と書いた通りに決めたもの）。 */
export const DEFAULT_BACKGROUND_MODE: BackgroundMode = "sky";

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

/** 空色。定数はこの1箇所にまとめてあるので、次に微調整するときはここだけ触ればよい。
 *
 * 実機フィードバック（所有者、空とグリッドが実機で正しく動くようになった後）:
 * 「空はちょっと白っぽくて違和感あるけど」。原因は`horizon`の明度が0.75〜0.83と
 * ほぼ白だったこと。地平線付近が明るくなるのは物理的には正しい（大気散乱）が、
 * **点群ビューアでは背景が明るいほど暗い点が見えなくなる**（TaskSheets/
 * M2-shading-and-ui.md M2-0c参照）。彩度はできるだけ保ったまま明度だけを
 * 落とした（HSLでおおまかに確認: horizonの彩度は旧S≈0.19→新S≈0.21で維持、
 * 明度はL≈0.79→L≈0.38まで下げた）。zenithも同じ考え方でもう少し深くした。
 * horizonLineは「地平線が線として見える」ことは残しつつ0.95は下げた
 * （horizon/groundより明るければ線として機能するので、0.95である必要はない）。
 *
 * 色そのものは主観なので、この値で所有者に再度見てもらってから微調整する前提。
 * groundは今回変更なし（所有者から「そのままでよい」）。 */
const SKY_COLORS: SkyColors = {
  zenith: [0.05, 0.12, 0.28],
  horizon: [0.3, 0.38, 0.46],
  ground: [0.05, 0.05, 0.055],
  horizonLine: [0.55, 0.6, 0.65],
};

const SKY_SHADER_SRC = /* wgsl */ `
struct SkyUniforms {
  // カメラ基底（JS側(f64)でmat4.tsのcameraBasis()から求める。draw()のコメント参照）。
  // ワールド空間の行列やeyeの絶対座標はここには無い。
  forward: vec4<f32>,      // xyzだけ使う。カメラの視線方向(eye->target正規化)
  rightScaled: vec4<f32>,  // xyzだけ使う。right * tan(fovY/2) * アスペクト比
  upScaled: vec4<f32>,     // xyzだけ使う。up * tan(fovY/2)
  upAxis: vec4<f32>,       // xyzだけ使う。M2-0b: 上方向はここでも1箇所（このuniform）を経由する
  zenithColor: vec4<f32>,  // rgbだけ使う
  horizonColor: vec4<f32>,
  groundColor: vec4<f32>,
  horizonLineColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: SkyUniforms;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  // NDC座標（位置）。線形補間が正しいのはこれだけ（ファイル冒頭の教訓1参照。
  // 方向ベクトルを直接ここに乗せて補間してはいけない）。
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
  // このピクセルのレイ方向を、画素ごとに基底から直接組み立てる（NDCがいくつでも
  // 厳密。ファイル冒頭の「対策（2回目）」参照）。
  let dir = normalize(u.forward.xyz + in.ndc.x * u.rightScaled.xyz + in.ndc.y * u.upScaled.xyz);

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
  4 * 3 /* forward/rightScaled/upScaled */ + 4 /* upAxis */ + 4 * 4 /* colors (zenith/horizon/ground/horizonLine) */;
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
   * `forward`/`rightScaled`/`upScaled`はカメラ基底（呼び出し側`point-cloud-renderer.ts`が
   * `mat4.ts`の`cameraBasis()`とFOV/アスペクト比からf64で計算する。詳細は
   * ファイル冒頭の「対策（2回目）」参照）。どれも大きさ~1のベクトルなので、
   * f32にキャストしても精度の問題は起きない。ワールド座標の絶対値
   * （invViewProjやeyeの絶対座標）はここには一切登場しない。
   */
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
