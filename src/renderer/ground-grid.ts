// 地面のグリッド（M2-0c 補強B）。
//
// 実機報告（所有者）: 空のグラデーションだけでは「地平線が分からない。地面が無い？」
// という状態だった。原因は (1) 真上からの俯瞰では点群が画面の大半を覆い、空が見える
// のは端だけになること、(2) グラデーションだけでは境界が無いこと。
//
// グリッドは Blender / CloudCompare / QGIS 3D 等の定番の解決策で、次の3つを一度に
// 与える:
// - 向き: 上方向(upAxis)に直交する水平面が見えることで、姿勢が把握できる
// - 尺度: 目盛りの間隔で距離感がつかめる（測量ツールとして本質的）
// - 地平線: 遠方で格子が収束することで、自然に地平線が浮かび上がる
//
// 太陽や雲は入れない（タスクシートで却下済み。空は表現の対象ではなく向きを示す計器）。
//
// 実装は空(sky.ts)と同じ全画面パス方式。レイと水平面（上方向に直交し、点群の
// バウンディングボックス底面あたりの高さを通る平面）の交点を求め、その面上の
// 2D座標（upAxisに直交する基底right/forward上）でグリッド線を描く。
// - 距離に応じてフェードさせ、遠方のモアレを避ける
// - 線幅はfwidth()でスクリーン空間の微分を基準にし、アンチエイリアスする
// - 深度は書かない（sky.tsと同様）。点群パイプラインが後から不透明に上書きするので、
//   点は常にグリッドより手前に残る
// - 色はアルファブレンドで背景(空 or 単色)の上に重ねる

import type { Vec3 } from "./up-axis";

/** 既定はオフ。空と同じく「既定で強制しない」方針を踏襲する（トグルで有効化）。 */
export const DEFAULT_GRID_ENABLED = false;

const GRID_LINE_COLOR: Vec3 = [0.55, 0.58, 0.6];
/** グリッド線の最大不透明度。背景に薄く重ねるだけにし、点群を邪魔しない。 */
const GRID_MAX_ALPHA = 0.35;
/** グリッド間隔を決めるとき、シーン対角線をおよそ何マスに割るか。 */
const TARGET_CELLS_ACROSS_SCENE = 40;
/** フェード距離をシーン対角線の何倍にするか。 */
const FADE_DISTANCE_RATIO = 1.5;

/**
 * シーンのスケール(バウンディングボックス対角線)から、キリのいいグリッド間隔を選ぶ。
 * 固定値にしないこと（タスクシートの要求）。1-2-5系列（1, 2, 5, 10, 20, 50, ...）で
 * 目盛りの間隔を選ぶ、軸ラベルの刻み幅選定などで使われる標準的な手法。
 *
 * 例: 対角線100m -> 目安2.5m -> 2m刻み。対角線4656m(autzenのY幅) -> 目安116m -> 100m刻み。
 */
export function niceGridCellSize(sceneDiagonal: number): number {
  if (!(sceneDiagonal > 0) || !Number.isFinite(sceneDiagonal)) return 1;

  const target = sceneDiagonal / TARGET_CELLS_ACROSS_SCENE;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const residual = target / magnitude; // [1, 10) の範囲に正規化された値

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

const GRID_SHADER_SRC = /* wgsl */ `
struct GridUniforms {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,      // xyzだけ使う
  upAxis: vec4<f32>,   // xyzだけ使う
  right: vec4<f32>,    // xyzだけ使う。upAxisに直交する水平基底（up-axis.tsのhorizontalBasis）
  forward: vec4<f32>,  // xyzだけ使う。同上
  // x: 平面の高さ(upAxis方向の座標), y: セルサイズ, z: フェード距離, w: 未使用
  params: vec4<f32>,
  lineColor: vec4<f32>, // rgb: 線の色, a: 最大不透明度
};
@group(0) @binding(0) var<uniform> u: GridUniforms;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  // 画面全体を覆う巨大三角形（頂点バッファ不要。sky.tsと同じ手法）。
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
  let farPoint4 = u.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let farPoint = farPoint4.xyz / farPoint4.w;
  let dir = normalize(farPoint - u.eye.xyz);
  let up = normalize(u.upAxis.xyz);

  let groundHeight = u.params.x;
  let cellSize = u.params.y;
  let fadeDistance = u.params.z;

  // レイと水平面(dot(p, up) = groundHeight)の交点。denomがほぼ0なら
  // レイが面とほぼ平行（地平線を真横に見ている）で交点が定まらない。
  let denom = dot(dir, up);
  if (abs(denom) < 1e-6) {
    discard;
  }
  let t = (groundHeight - dot(u.eye.xyz, up)) / denom;
  if (t <= 0.0) {
    // 交点がカメラの後ろ（＝面は視線の逆側）。
    discard;
  }

  let hit = u.eye.xyz + dir * t;
  // 平面上の基準点。ワールド原点をupAxis方向にgroundHeightだけ動かした点に固定する
  // ことで、グリッド線がカメラの動きで揺れない（ワールドに固定された格子になる）。
  let refPoint = up * groundHeight;
  let rel = hit - refPoint;
  let uCoord = dot(rel, u.right.xyz) / cellSize;
  let vCoord = dot(rel, u.forward.xyz) / cellSize;

  // アンチエイリアスされた格子線。fwidth()でスクリーン空間の変化率を求め、
  // それを線幅の基準にすることで、距離やズームによらずおよそ同じ太さになる
  // （モアレを避けるため、近傍のセルの半分の位置(0.5)を中心に線を引く）。
  let du = max(fwidth(uCoord), 1e-6);
  let dv = max(fwidth(vCoord), 1e-6);
  let lineU = 1.0 - min(abs(fract(uCoord - 0.5) - 0.5) / du, 1.0);
  let lineV = 1.0 - min(abs(fract(vCoord - 0.5) - 0.5) / dv, 1.0);
  let intensity = max(lineU, lineV);

  // 遠方はフェードさせ、格子が密集してモアレになるのを避ける。
  let dist = length(hit - u.eye.xyz);
  let fade = 1.0 - smoothstep(fadeDistance * 0.5, fadeDistance, dist);

  let alpha = intensity * fade * u.lineColor.a;
  if (alpha <= 0.001) {
    discard;
  }
  return vec4<f32>(u.lineColor.rgb, alpha);
}
`;

const GRID_UNIFORM_FLOATS =
  16 /* invViewProj */ + 4 /* eye */ + 4 /* upAxis */ + 4 /* right */ + 4 /* forward */ + 4 /* params */ + 4 /* lineColor */;
const GRID_UNIFORM_BYTES = GRID_UNIFORM_FLOATS * 4;

/**
 * 地面グリッドの全画面パス。sky.tsと同様、点群のパイプラインとは別に持ち、
 * 同じレンダーパス内で点より先に描く。背景(空/単色)の上にアルファブレンドで
 * 重ねるため、色ターゲットにblendを設定する。
 */
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

    const shaderModule = device.createShaderModule({ code: GRID_SHADER_SRC });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            // 背景(空/単色)の上に半透明で重ねる。points側は不透明のまま変更しない。
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      // sky.tsと同じ理由: 深度を書かず常に通す。点群が後から不透明に描かれるので、
      // 点は常にグリッドより手前に残る。
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

  /**
   * 同じレンダーパス内で、点群を描く前（空を描いた後でよい）に呼ぶこと。
   * `groundHeight`は上方向(upAxis)成分での平面の高さ（点群バウンディングボックス
   * 底面あたりを渡す想定）、`cellSize`は`niceGridCellSize()`で決めた間隔、
   * `fadeDistance`は`gridFadeDistance()`で決めたフェード距離。
   */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    invViewProj: number[],
    eye: Vec3,
    upAxis: Vec3,
    right: Vec3,
    forward: Vec3,
    groundHeight: number,
    cellSize: number,
    fadeDistance: number,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData.set(invViewProj, 0);
    this.uniformData.set([eye[0], eye[1], eye[2], 0], 16);
    this.uniformData.set([upAxis[0], upAxis[1], upAxis[2], 0], 20);
    this.uniformData.set([right[0], right[1], right[2], 0], 24);
    this.uniformData.set([forward[0], forward[1], forward[2], 0], 28);
    this.uniformData.set([groundHeight, cellSize, fadeDistance, 0], 32);
    this.uniformData.set([...GRID_LINE_COLOR, GRID_MAX_ALPHA], 36);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1);
  }
}
