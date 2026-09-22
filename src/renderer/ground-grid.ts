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
//
// 修正1回目（実機報告: グリッドにチェックしても表示が変わらない）: sky.tsと同じ
// 原因（NEAR/FAR(0.01〜1e7)のダイナミックレンジ + autzenの大きなワールド座標で、
// f32のinvViewProjからレイ方向を復元するとNaNになる）。この時点でレイ方向を
// JS(f64)で計算する方式に直したのに加えて、**平面との交点計算もすべてカメラ
// 相対にした**（この部分は2回目の修正でも変わらず有効）:
// - 平面の高さはカメラからの相対値(`groundHeight - eyeHeight`)で渡す
// - グリッド線の位相合わせは、カメラ位置をセルサイズで割った余り(`phase`)で渡す。
//   世界座標の整数部（大きい）を捨てて余り（小さい）だけ使っても、格子線は
//   セルサイズ周期で繰り返すパターンなので見た目は変わらない
//
// 修正2回目（実機報告: 空やグリッドを入れると画面が真っ黒になる）: 1回目の
// 対策は「全画面三角形の3頂点それぞれのレイ方向(正規化済み)を線形補間する」
// 方式だったが、これも壊れていた。NDC=3（三角形の頂点。画面中心から70度以上）
// のような広い角度にわたって単位ベクトルを線形補間すると、球面上の弧ではなく
// 弦を取ることになり、長さが縮む（条件によってはほぼ0になり`normalize`がNaNに
// なる）。詳しい原因と教訓は`sky.ts`のファイル冒頭コメントを参照（このファイルも
// 同じ罠にかかっていた）。
//
// 対策（2回目）: レイ方向の補間をやめ、sky.tsと同じ「画素ごとに基底から
// 直接組み立てる」方式にした:
// `dir = normalize(forward + ndc.x * rightScaled + ndc.y * upScaled)`
// 頂点シェーダで補間するのはNDC座標（位置）だけ。`forward`/`rightScaled`/
// `upScaled`はカメラ基底（`mat4.ts`の`cameraBasis()`）から求める。

import type { Vec3 } from "./up-axis";

/** 既定はオン。策定時はオフだったが、実機フィードバックを受けて空(sky.ts)と
 *  合わせてオンに変更した。経緯はTaskSheets/M2-shading-and-ui.md M2-0cに記録して
 *  ある。グリッドは薄い線を背景に重ねるだけで点群のコントラストをほとんど
 *  損なわないため、そもそも既定オフにする理由が空ほど強くなかった。 */
export const DEFAULT_GRID_ENABLED = true;

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

/**
 * `a`を`m`で割った余り。JSの`%`は`a`が負のとき負の余りを返す
 * （例: `-1 % 100 === -1`）ため、常に`[0, m)`に収まる「floored」な余りを別途用意する。
 *
 * グリッドの位相合わせ（`draw()`の`phaseU`/`phaseV`）に使う。カメラ位置の
 * right/forward成分（世界座標そのもの、負にもなり得る）から、GPUに渡してよい
 * 小さい値（`[0, cellSize)`）を作るためのもの。
 */
export function floorMod(a: number, m: number): number {
  return a - Math.floor(a / m) * m;
}

const GRID_SHADER_SRC = /* wgsl */ `
struct GridUniforms {
  // カメラ基底（sky.tsと同じ方式。ワールド空間の行列やeyeの絶対座標は
  // ここには無い。ファイル冒頭のコメント参照）。
  viewForward: vec4<f32>,      // xyzだけ使う。カメラの視線方向(eye->target正規化)
  viewRightScaled: vec4<f32>,  // xyzだけ使う。right * tan(fovY/2) * アスペクト比
  viewUpScaled: vec4<f32>,     // xyzだけ使う。up * tan(fovY/2)
  upAxis: vec4<f32>,           // xyzだけ使う。シーンの上方向（グリッド平面の法線）
  // グリッド平面に沿った水平基底（up-axis.tsのhorizontalBasis。カメラ基底とは別物、
  // シーンのupAxisに直交する）。グリッド線の格子座標(uCoord/vCoord)を作るのに使う。
  gridRight: vec4<f32>,    // xyzだけ使う
  gridForward: vec4<f32>,  // xyzだけ使う
  // x: 平面の高さ(カメラからの相対値。groundHeight - eyeHeight), y: セルサイズ,
  // z: フェード距離, w: 未使用
  params: vec4<f32>,
  // x: カメラ位置のgridRight成分をセルサイズで割った余り, y: 同gridForward成分の余り,
  // z, w: 未使用。ワールド座標の絶対値の代わりにこれを使う（ファイル冒頭のコメント）。
  phase: vec4<f32>,
  lineColor: vec4<f32>, // rgb: 線の色, a: 最大不透明度
};
@group(0) @binding(0) var<uniform> u: GridUniforms;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  // NDC座標（位置）。線形補間が正しいのはこれだけ（sky.tsファイル冒頭の教訓1参照。
  // 方向ベクトルを直接ここに乗せて補間してはいけない）。
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
  // このピクセルのレイ方向を、画素ごとに基底から直接組み立てる（NDCがいくつでも
  // 厳密。sky.tsファイル冒頭の「対策（2回目）」参照）。カメラを原点とする座標系
  // (カメラ相対)ですべて計算する。eyeの絶対座標そのものは登場しない。
  let dir = normalize(u.viewForward.xyz + in.ndc.x * u.viewRightScaled.xyz + in.ndc.y * u.viewUpScaled.xyz);
  let up = normalize(u.upAxis.xyz);

  let relGroundHeight = u.params.x; // 平面の高さ(カメラからの相対値)
  let cellSize = u.params.y;
  let fadeDistance = u.params.z;

  // レイと水平面の交点（カメラ相対）。denomがほぼ0ならレイが面とほぼ平行
  // （地平線を真横に見ている）で交点が定まらない。
  let denom = dot(dir, up);
  if (abs(denom) < 1e-6) {
    discard;
  }
  let t = relGroundHeight / denom;
  if (t <= 0.0) {
    // 交点がカメラの後ろ（＝面は視線の逆側）。
    discard;
  }

  // カメラから交点までの差分（カメラ相対なので、これがそのまま交点の座標）。
  let hitRel = dir * t;
  let hitU = dot(hitRel, u.gridRight.xyz);
  let hitV = dot(hitRel, u.gridForward.xyz);

  // グリッドの位相はカメラ位置の余り(u.phase)にhitRelを足して作る。世界座標の
  // 整数部（大きい）を経由しないので、f32でも精度が落ちない。整数個のcellSizeが
  // 混じっていてもfract()で消えるので、位相さえ合っていれば結果は変わらない。
  let uCoord = (u.phase.x + hitU) / cellSize;
  let vCoord = (u.phase.y + hitV) / cellSize;

  // アンチエイリアスされた格子線。fwidth()でスクリーン空間の変化率を求め、
  // それを線幅の基準にすることで、距離やズームによらずおよそ同じ太さになる
  // （モアレを避けるため、近傍のセルの半分の位置(0.5)を中心に線を引く）。
  let du = max(fwidth(uCoord), 1e-6);
  let dv = max(fwidth(vCoord), 1e-6);
  let lineU = 1.0 - min(abs(fract(uCoord - 0.5) - 0.5) / du, 1.0);
  let lineV = 1.0 - min(abs(fract(vCoord - 0.5) - 0.5) / dv, 1.0);
  let intensity = max(lineU, lineV);

  // 遠方はフェードさせ、格子が密集してモアレになるのを避ける（カメラ相対なので
  // 交点までの距離はhitRelの長さそのもの）。
  let dist = length(hitRel);
  let fade = 1.0 - smoothstep(fadeDistance * 0.5, fadeDistance, dist);

  let alpha = intensity * fade * u.lineColor.a;
  if (alpha <= 0.001) {
    discard;
  }
  return vec4<f32>(u.lineColor.rgb, alpha);
}
`;

const GRID_UNIFORM_FLOATS =
  4 * 3 /* viewForward/viewRightScaled/viewUpScaled */ +
  4 /* upAxis */ +
  4 /* gridRight */ +
  4 /* gridForward */ +
  4 /* params */ +
  4 /* phase */ +
  4 /* lineColor */;
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
   *
   * `viewForward`/`viewRightScaled`/`viewUpScaled`はsky.tsと同じカメラ基底
   * （呼び出し側`point-cloud-renderer.ts`が`mat4.ts`の`cameraBasis()`と
   * FOV/アスペクト比からf64で計算する）。
   *
   * `gridRight`/`gridForward`はそれとは別物で、シーンのupAxisに直交する
   * 水平基底（`up-axis.ts`の`horizontalBasis()`）。グリッド線を並べる平面上の
   * 2D座標を作るのに使う。
   *
   * ここから先はすべて**カメラ相対**（ワールド座標の絶対値をそのまま渡さない。
   * ファイル冒頭のコメント参照）:
   * - `relGroundHeight`: 平面の高さから、カメラの高さ(`dot(eye, upAxis)`)を
   *   引いた差分。点群バウンディングボックス底面あたりの高さを想定。
   * - `phaseU`/`phaseV`: カメラ位置の`gridRight`/`gridForward`成分を`cellSize`で
   *   割った余り（呼び出し側で`floorMod`を使って求める）。世界座標の絶対値
   *   そのものではなく、格子の位相合わせに要る分（余り）だけを渡す。
   *
   * `cellSize`は`niceGridCellSize()`、`fadeDistance`は`gridFadeDistance()`で
   * それぞれ決めた値。
   */
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
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData.set([...viewForward, 0], 0);
    this.uniformData.set([...viewRightScaled, 0], 4);
    this.uniformData.set([...viewUpScaled, 0], 8);
    this.uniformData.set([upAxis[0], upAxis[1], upAxis[2], 0], 12);
    this.uniformData.set([gridRight[0], gridRight[1], gridRight[2], 0], 16);
    this.uniformData.set([gridForward[0], gridForward[1], gridForward[2], 0], 20);
    this.uniformData.set([relGroundHeight, cellSize, fadeDistance, 0], 24);
    this.uniformData.set([phaseU, phaseV, 0, 0], 28);
    this.uniformData.set([...GRID_LINE_COLOR, GRID_MAX_ALPHA], 32);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1);
  }
}
