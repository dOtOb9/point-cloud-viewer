// WebGPUのデバイス・パイプライン・テクスチャ（深度・オフスクリーン）・
// sky/grid/EDLの初期化とリサイズ、そして1フレーム分の描画コマンドの
// エンコード（drawFrame）を持つ。**WebGPUのAPIを直接叩くのはこのファイルだけ**
// にする（`TaskSheets/ARCHITECTURE.md`の分割方針）。
//
// フレームループ・カメラ・統計・ローダーとの接続といったオーケストレーションは
// 呼び出し側の`point-cloud-renderer.ts`が持つ。このファイルは「今のフレームで
// 何を描くか（ノード一覧・行列・背景設定）」を毎回引数で渡されるだけで、
// 自分でrAFを回したり点予算を決めたりはしない。
//
// 元は point-cloud-renderer.ts の一部だった（分割の経緯は
// TaskSheets/ARCHITECTURE.md 参照）。個々のコメント（sky の NaN、EDL の
// depthStencil 欠落事故など）は移動元のコミット履歴どおりそのまま持ってきてある。

import { NODE_POINT_STRIDE, type ParsedNode } from "../datasource/node-format";
import { cameraBasis, multiply, translation, type Mat4 } from "./mat4";
import { type CachedNode } from "./node-cache";
import { clearColorForMode, SkyBackground, type BackgroundMode } from "./sky";
import { floorMod, GroundGrid } from "./ground-grid";
import { horizontalBasis, type Vec3 } from "./up-axis";
import { EdlPass } from "./edl";
import { ELEVATION_INTENSITY_RAMP, rampToWgslFunction, type ColorMode, type ValueRange } from "./colormap";
import type { PointShape } from "./device-profile";
import {
  decideDeviceRecovery,
  recordDeviceRecoveryAttempt,
  DEFAULT_DEVICE_RECOVERY_LIMITS,
  type DeviceRecoveryAttempt,
} from "./device-recovery";

const POINT_SIZE_PX = 4;
/** WebGPUのFOV/near/far。orchestrator側（point-cloud-renderer.ts）が投影行列を
 *  組み立てる際にも同じ値が要るため、ここからexportする。 */
export const FOV_Y_RADIANS = Math.PI / 3;
export const NEAR = 0.01;
export const FAR = 1e7;
/**
 * 深度バッファのフォーマット。点群パイプラインと空パイプライン(sky.ts)の両方が
 * 同じレンダーパスに参加するので、1箇所にまとめて食い違いを防ぐ。
 *
 * **M3-8: EDLオン(2パス)・EDLオフ(1パス、drawFrame()参照)のどちらの経路でも、
 * 深度テクスチャ(`depthTexture`/`offscreenDepthTexture`、resize()参照)と
 * 点群パイプライン4つ・sky/grid/EDLの各パイプラインの`depthStencil.format`が
 * すべてこの1つの定数を参照する。** 以前EDL合成パイプラインが`depthStencil`
 * そのものを宣言し忘れ、パスと非互換になって画面が真っ黒になる事故があった
 * (edl.tsのinit()コメント参照)。新しい深度テクスチャやパイプラインを足すときは
 * 必ずこの定数を使うこと（別の値を書かないこと）で、同じ事故を構造的に防ぐ。
 */
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
/**
 * M2-1: 点群だけを描くオフスクリーンの色テクスチャのフォーマット。スワップチェーンの
 * フォーマット(`bgra8unorm`等、環境依存)とは独立に固定値にしておく。EDLの合成パス
 * (edl.ts)がこのテクスチャを`texture_2d<f32>`として読むだけで、直接画面に出す
 * わけではないため、環境ごとに変わるスワップチェーンのフォーマットに合わせる
 * 理由が無い。`rgba8unorm`はRENDER_ATTACHMENT/TEXTURE_BINDINGの両方をWebGPUの
 * どの実装でも標準でサポートするフォーマット。
 */
const OFFSCREEN_COLOR_FORMAT: GPUTextureFormat = "rgba8unorm";

const UNIFORM_BUFFER_SIZE = 80; // mat4(64) + pointSizePx(4) + viewportWidth(4) + viewportHeight(4) + originZ(4)

/**
 * M2-2: 着色モードの数値対応。`ColorSettings.mode`（f32）にこの値を書き込み、
 * シェーダ側は`i32(round(mode))`で整数に戻して比較する（このプロジェクトの
 * uniformバッファは既存のsky.ts/edl.tsと同じくすべてf32で統一しており、
 * 整数型のuniformを別途持ち込まない方針を踏襲した）。
 */
const COLOR_MODE_INDEX: Record<ColorMode, number> = {
  rgb: 0,
  elevation: 1,
  intensity: 2,
  classification: 3,
};

/** M2-2: 着色設定のuniformバッファのバイト数。EDL(edl.ts)と同じく8個のf32(32B)に揃えた。 */
const COLOR_SETTINGS_UNIFORM_FLOATS = 8; // mode, elevationMin, elevationMax, intensityMin, intensityMax, pad*3
const COLOR_SETTINGS_UNIFORM_BYTES = COLOR_SETTINGS_UNIFORM_FLOATS * 4;

/**
 * M2-2実機不具合の修正: 標高・強度の色ランプ(青→緑→黄→赤、CloudCompare風)は
 * `colormap.ts`の`ELEVATION_INTENSITY_RAMP`だけに定義を持ち、WGSL側の関数は
 * `rampToWgslFunction`で**そこから生成する**。
 *
 * 以前はこの関数の値をWGSLの文字列へ手で書き写しており（`edl.ts`の
 * `linearizeDepth`と同じ「TS側を正としてWGSL側は手で再実装し、コメントで
 * 対応を明記する」という以前の方針）、TSとWGSLの制御点が食い違う懸念があった
 * （`colormap.ts`の`rampToWgslFunction`のコメント参照）。制御点を1箇所
 * （`ELEVATION_INTENSITY_RAMP`）だけに持ち、WGSLはそこから生成することで、
 * 「2箇所に同じランプがあるが、生成元は1つ」という構造にし、食い違いを
 * 仕組みで防ぐ。
 */
const ELEVATION_INTENSITY_RAMP_WGSL_FN = "elevationOrIntensityRampColor";
const ELEVATION_INTENSITY_RAMP_WGSL_SRC = rampToWgslFunction(ELEVATION_INTENSITY_RAMP_WGSL_FN, ELEVATION_INTENSITY_RAMP);

const SHADER_SRC = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4<f32>,
  pointSizePx: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  // M2-2: ノード原点のワールドZ座標。標高着色に使う(下のcolorForVertex参照)。
  // mvpの平行移動にも同じ値が畳み込まれているが、行列からは単独で取り出せない
  // ため、標高計算専用にここへ別途渡す。
  originZ: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

// M2-2: 着色モードの設定。ノードごとではなく1フレームに1つ（全ノード共通）の
// 値なので、ノードのuniform(binding 0)とは別のbindingに分けた。値そのものは
// gpu-resources.tsのdrawFrame()が毎フレーム書き込む（point-cloud-renderer.tsの
// 状態を渡すだけの経路。EDLの強さ・半径と同じ形）。
//
// 色の計算式はsrc/renderer/colormap.tsの純粋関数に対応する。GPUが無いと
// 直接テストできないため(edl.tsのlinearizeDepthと同じ事情)、TypeScript側は
// colormap.test.tsで担保する。標高・強度のランプ(sampleRamp/
// ELEVATION_INTENSITY_RAMP)はWGSLの文字列を手で書き写すのではなく
// rampToWgslFunction()で生成し値の食い違いを防いでいる(下の
// ELEVATION_INTENSITY_RAMP_WGSL_SRC参照)。分類コード→色(classificationToColor)は
// 表の構造上生成の恩恵が薄いため、従来どおり手で再実装し、値が一致している
// ことをコメントで対応させている。
struct ColorSettings {
  mode: f32,          // COLOR_MODE_INDEXの値(0=rgb,1=elevation,2=intensity,3=classification)
  elevationMin: f32,
  elevationMax: f32,
  intensityMin: f32,
  intensityMax: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(1) var<uniform> cs: ColorSettings;

struct VertexIn {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  // M2-2: intensity(u16)とclassification(u8)を1つのu32属性として読む
  // (crates/pcv-core/src/node_format.rsのオフセット16、リトルエンディアン4バイト
  // をそのままuint32として読み、シェーダ側でビット演算で分解する)。
  //   bits[0:16)  = intensity
  //   bits[16:24) = classification
  //   bits[24:32) = padding(未使用)
  @location(2) packed: u32,
};

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
};

// 標高・強度で共有する色ランプ(青→緑→黄→赤、CloudCompare風)。
// **手書きではなく、colormap.tsのELEVATION_INTENSITY_RAMPから
// rampToWgslFunction()で生成している**（このファイル上部の定数、
// および生成元のコメント参照）。標高・強度の両方が同じ関数
// (${ELEVATION_INTENSITY_RAMP_WGSL_FN})を呼ぶ(下のcolorForVertex参照)。
${ELEVATION_INTENSITY_RAMP_WGSL_SRC}

// 分類コード→色(colormap.tsのASPRS_CLASSIFICATION_COLORS/UNKNOWN_CLASSIFICATION_COLORと
// 同じ値。表に無いコードはdefaultでシアンにフォールバックする)。
fn classificationColor(code: u32) -> vec3<f32> {
  switch code {
    case 0u:  { return vec3<f32>(0.6, 0.6, 0.6); }
    case 1u:  { return vec3<f32>(0.78, 0.78, 0.78); }
    case 2u:  { return vec3<f32>(0.55, 0.4, 0.22); }
    case 3u:  { return vec3<f32>(0.62, 0.82, 0.35); }
    case 4u:  { return vec3<f32>(0.32, 0.66, 0.28); }
    case 5u:  { return vec3<f32>(0.1, 0.42, 0.16); }
    case 6u:  { return vec3<f32>(0.85, 0.32, 0.22); }
    case 7u:  { return vec3<f32>(1.0, 0.0, 1.0); }
    case 8u:  { return vec3<f32>(0.5, 0.5, 0.5); }
    case 9u:  { return vec3<f32>(0.15, 0.4, 0.85); }
    case 10u: { return vec3<f32>(0.4, 0.4, 0.45); }
    case 11u: { return vec3<f32>(0.25, 0.25, 0.28); }
    case 12u: { return vec3<f32>(0.58, 0.58, 0.58); }
    case 13u: { return vec3<f32>(0.8, 0.6, 0.1); }
    case 14u: { return vec3<f32>(0.9, 0.72, 0.2); }
    case 15u: { return vec3<f32>(0.7, 0.42, 0.12); }
    case 16u: { return vec3<f32>(0.82, 0.55, 0.32); }
    case 17u: { return vec3<f32>(0.62, 0.32, 0.7); }
    case 18u: { return vec3<f32>(1.0, 0.15, 0.15); }
    default:  { return vec3<f32>(0.0, 0.9, 0.9); }
  }
}

// M2-2: 着色モードに応じてこの頂点(点)の基本色を決める。EDLはこの色に対して
// 深度差から求めた陰影係数を後段(edl.ts、別のレンダーパス)で掛けるだけなので、
// ここでは陰影を一切考えない「素の色」を返す(着色→EDLで陰影、の順序)。
fn colorForVertex(in: VertexIn) -> vec4<f32> {
  let mode = i32(round(cs.mode));
  let intensityRaw = in.packed & 0xffffu;
  let classificationRaw = (in.packed >> 16u) & 0xffu;

  if (mode == 1) {
    // 標高: ノード原点のワールドZ + 頂点のノードローカル相対Z = ワールドZ
    // (node_format.rsのencode_node: rel_z = z - origin_rounded[2]の逆算)。
    let worldZ = u.originZ + in.position.z;
    let range = cs.elevationMax - cs.elevationMin;
    var t = 0.0;
    if (range > 0.0) {
      t = clamp((worldZ - cs.elevationMin) / range, 0.0, 1.0);
    }
    return vec4<f32>(${ELEVATION_INTENSITY_RAMP_WGSL_FN}(t), in.color.a);
  }
  if (mode == 2) {
    let range = cs.intensityMax - cs.intensityMin;
    var t = 0.0;
    if (range > 0.0) {
      t = clamp((f32(intensityRaw) - cs.intensityMin) / range, 0.0, 1.0);
    }
    return vec4<f32>(${ELEVATION_INTENSITY_RAMP_WGSL_FN}(t), in.color.a);
  }
  if (mode == 3) {
    return vec4<f32>(classificationColor(classificationRaw), in.color.a);
  }
  // mode == 0 (rgb)、またはそれ以外の想定外の値はRGB属性のままにする
  // (フォールバックとして安全側: 何も表示されなくなるより、元のRGBが出るほうがよい)。
  return in.color;
}

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let corner = corners[in.vertexIndex];

  let clip = u.mvp * vec4<f32>(in.position, 1.0);

  // 画面空間で一定のピクセルサイズにする。clip.w を掛けてから頂点座標に足すことで、
  // パースペクティブ除算（GPUが自動でxyz/wする）が起きても見た目のピクセルサイズが
  // 変わらないようにする（距離で小さくならない固定サイズ）。
  let ndcHalf = vec2<f32>(u.pointSizePx / u.viewportWidth, u.pointSizePx / u.viewportHeight);

  var out: VertexOut;
  out.clipPosition = vec4<f32>(clip.xy + corner * ndcHalf * clip.w, clip.z, clip.w);
  out.color = colorForVertex(in);
  out.uv = corner;
  return out;
}

// M3-8: 点の形（丸/四角）は、同じフラグメントシェーダの中でif分岐して
// discardを迂回するのではなく、エントリポイントそのものを2つに分けた
// (fs_main_round/fs_main_square)。理由: discardは実行時にどちらへ進むかに
// 関わらず、シェーダの中に存在するというだけでGPU(特にAdreno等のタイル
// ベースGPU)のEarly-Z/隠面消去の最適化を無効化しうる。pointShapeをuniformで
// 受け取ってif (pointShapeIsRound) { discard; }と書いても、コンパイラは
// 実行時の値を静的に知らないため「discardされないことがある」余地を消せず、
// 四角形を選んでも最適化が有効に戻らない可能性が高い。エントリポイントごと
// 分ければ、四角形用のパイプラインのシェーダバイナリにはdiscard命令
// そのものが存在しない、という静的な保証になる。
//
// パイプラインは(このエントリポイント2つ)×(描画先2つ、下のGpuResourcesの
// フィールドコメント参照)の4つを初期化時にまとめて作っておき、切り替えは
// 「どのパイプラインをbindするか」を選ぶだけにする(再作成不要。
// drawFrame()参照)。
@fragment
fn fs_main_round(in: VertexOut) -> @location(0) vec4<f32> {
  // 四角形を円形に抜く。
  if (dot(in.uv, in.uv) > 1.0) {
    discard;
  }
  return in.color;
}

@fragment
fn fs_main_square(in: VertexOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

/**
 * 1フレーム分の描画に必要な、カメラ・背景・EDLの設定。オーケストレーション側
 * （point-cloud-renderer.ts）が持っている状態を、drawFrameのたびに渡す。
 * ここに状態を複製して二重管理にしないため、フィールドとしては持たない。
 */
export interface DrawFrameOptions {
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  /** シーンのバウンディングボックスから決める、グリッドの間隔・フェード距離・高さ。 */
  gridCellSize: number;
  gridFadeDistance: number;
  gridGroundHeight: number;
  edlEnabled: boolean;
  edlStrength: number;
  edlRadiusPx: number;
  /**
   * M3-8: レンダースケール(内部解像度 = 表示サイズ×devicePixelRatio×この値)。
   * 点のサイズ・EDLの半径はどちらも「内部バッファのピクセル数」を基準にした
   * 値なので、スケールを掛けて補正しないと、スケールを下げたときに画面上の
   * 見た目のサイズが変わってしまう(補正の理由はdrawPoints()のコメント参照)。
   * デスクトップの既定値1.0では、この補正は実質何もしない(変更前と同じ)。
   */
  renderScale: number;
  /** M3-8: 点の形（丸/四角）。どちらのパイプラインを使うかをここで選ぶだけで、
   *  パイプライン自体はinit()で両方作成済み(切り替えのたびに再作成しない)。 */
  pointShape: PointShape;
  cameraEye: readonly [number, number, number];
  cameraTarget: readonly [number, number, number];
  upAxis: Vec3;
  /** M2-2: 着色モードと、標高/強度を正規化するための実データレンジ。
   *  レンジの決め方はcolormap.tsのコメント参照(標高はCloudInfoのバウンディング
   *  ボックス、強度はノード読み込み時に動的に広げていく)。 */
  colorMode: ColorMode;
  elevationRange: ValueRange;
  intensityRange: ValueRange;
}

export class GpuResources {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  /**
   * M3-8: 点群パイプラインは「丸/四角」×「描画先(オフスクリーン/スワップ
   * チェーン直接)」の組み合わせで4つ持つ。
   *
   * 描画先を分ける理由: オフスクリーン向け(`OFFSCREEN_COLOR_FORMAT`
   * =`rgba8unorm`固定)とスワップチェーン向け(`this.format`、環境依存)では
   * フラグメントターゲットのフォーマットが異なり、WebGPUはレンダーパスの
   * 色アタッチメントとパイプラインの宣言フォーマットが厳密に一致することを
   * 要求するため、1つのパイプラインで両方を兼ねることはできない
   * (EDLオン=2パスならオフスクリーン向け、EDLオフ=1パスならスワップ
   * チェーン向けを使う。drawFrame()参照)。
   * 丸/四角を分ける理由はWGSL側のコメント(fs_main_round/fs_main_square)参照。
   */
  private pipelineOffscreenRound: GPURenderPipeline | null = null;
  private pipelineOffscreenSquare: GPURenderPipeline | null = null;
  private pipelineSwapchainRound: GPURenderPipeline | null = null;
  private pipelineSwapchainSquare: GPURenderPipeline | null = null;
  private uniformLayout: GPUBindGroupLayout | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

  /** M2-2: 着色モードの設定(mode/elevationRange/intensityRange)。ノードごとではなく
   *  フレームごとに1つで全ノード共通のため、点群パイプラインのbinding(1)として
   *  ノードのuniform(binding 0)とは別に持つ。`drawFrame()`が毎フレーム内容を
   *  書き換える(バッファそのものは作り直さない。既存の各ノードのbindGroupは
   *  このバッファを固定で参照しているため、作り直すと参照が壊れる)。 */
  private colorSettingsBuffer: GPUBuffer | null = null;

  /** 空の背景（M2-0c）。既定は単色(暗)のままで、"sky"を選んだときだけ描く。 */
  private readonly sky = new SkyBackground();
  /** 地面のグリッド（M2-0c補強B）。既定はオフ（空と同じく既定で強制しない）。 */
  private readonly grid = new GroundGrid();
  /** EDL陰影(M2-1)。点群だけを描いたオフスクリーンの色+深度を読み、隣接ピクセルとの
   *  深度差から陰影係数を作って合成する。空・グリッドとは別のテクスチャに
   *  点群だけを描くことで、EDLの陰影が点群にしか掛からないようにしている
   *  （分離方法の設計理由はedl.tsファイル冒頭のコメント、
   *  TaskSheets/M2-shading-and-ui.md M2-1に記録してある）。 */
  private readonly edl = new EdlPass();

  /** 点群だけを描くオフスクリーンの色・深度テクスチャ(M2-1)。スワップチェーンの
   *  `depthTexture`とは別に持つ理由: EDLの合成パスは「このピクセルに点が
   *  描かれたかどうか」を深度のクリア値で判定して空・グリッドに触れないようにする
   *  ため、点群専用の深度が要る（edl.ts参照）。`depthTexture`と同様、
   *  ウィンドウリサイズのたびに`resize()`で作り直す。 */
  private offscreenColorTexture: GPUTexture | null = null;
  private offscreenColorView: GPUTextureView | null = null;
  private offscreenDepthTexture: GPUTexture | null = null;
  private offscreenDepthView: GPUTextureView | null = null;

  /** M3-8追加: デバイス消失(device.lost)からの復帰に使う、直近の描画バッファ
   *  サイズ。`resize()`のたびに更新し、復帰後の`resize()`再呼び出しに使う
   *  (呼び出し側(point-cloud-renderer.ts)が復帰を知って改めて呼び直す必要が
   *  無いよう、ここで自己完結させる)。 */
  private lastWidth = 1;
  private lastHeight = 1;
  /** M3-8追加: `init()`で受け取ったcanvas。デバイス消失からの復帰時に
   *  同じcanvasへ対して`getContext("webgpu")`をやり直すために保持する。 */
  private canvas: HTMLCanvasElement | null = null;
  /** M3-8追加: 直近の復帰試行の履歴。`device-recovery.ts`の
   *  `decideDeviceRecovery`/`recordDeviceRecoveryAttempt`（純粋関数）に渡す。 */
  private recentRecoveryAttempts: DeviceRecoveryAttempt[] = [];
  /** M3-8追加: `dispose()`後は復帰を試みない(コンポーネントが破棄された後に
   *  非同期の復帰処理が動き続けるのを防ぐ)。 */
  private disposed = false;

  /**
   * WebGPUのエラーを1件報告するための呼び出し先（呼び出し側=PointCloudRendererの
   * `reportGpuError`をそのまま渡してもらう）。console.errorへの出力やUIバナー用の
   * コールバック呼び出しは呼び出し側の責務なので、ここでは中身を知らずにただ渡す。
   *
   * `onDeviceRecovered`（M3-8追加）: デバイス消失から復帰し、リソースを
   * 作り直し終えた直後に1回呼ばれる。呼び出し側(point-cloud-renderer.ts)は
   * これを使って、古いデバイスのGPUバッファを参照しているノードキャッシュを
   * 空にする（新しいデバイスでは古いバッファは使えないため。詳細は
   * `handleDeviceLost()`のコメント参照）。
   */
  constructor(
    private readonly reportError: (message: string) => void,
    private readonly onDeviceRecovered: () => void,
  ) {}

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    await this.setupDevice();
  }

  /**
   * アダプタ・デバイスの取得、コンテキストの設定、パイプライン・sky/grid/EDLの
   * 初期化をまとめて行う。**`init()`（初回）と`handleDeviceLost()`（デバイス
   * 消失からの復帰）の両方から呼ばれる。** 復帰時は`this.canvas`を再利用し、
   * 全リソースをゼロから作り直す（MDNの"Handling device loss"の推奨どおり、
   * 古いデバイスのリソースは新しいデバイスでは使えないため、使い回さない）。
   */
  private async setupDevice(): Promise<void> {
    const canvas = this.canvas;
    if (!canvas) {
      throw new Error("setupDevice() called before init() (canvas is not set)");
    }
    if (!("gpu" in navigator) || !navigator.gpu) {
      throw new Error("WebGPU is not supported (navigator.gpu is missing)");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("navigator.gpu.requestAdapter() returned null");
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("failed to get a webgpu canvas context");
    }

    // WebGPUのエラーを画面に出す仕組み（ADR-0011）。
    //
    // `onuncapturederror`は、エラースコープ（下のinitWithErrorScope）で
    // 囲んでいない場所で起きたバリデーションエラー・型エラーを拾う。
    // 典型的にはこれは「毎フレームのdraw呼び出し」で起きる（EDL(M2-1)の
    // 事故がまさにこれで、壊れたパイプラインでdrawするたびに同じエラーが
    // フレームごとに発生し続けていた）。同じメッセージが毎フレーム連投
    // されてコンソールが埋まらないよう、実際の抑制はGpuErrorLog（呼び出し側の
    // src/state/useCopcViewer.ts）に任せ、ここでは素通しする。
    device.onuncapturederror = (event) => {
      this.reportError(event.error.message);
    };
    // `device.lost`はGPUのリセットやドライバのクラッシュなどでデバイスその
    // ものが失われたときに解決するPromise。エラースコープ・onuncapturederrorの
    // どちらでも拾えない種類の異常なので、別途監視する。
    // **M3-8追加**: 以前はエラーを報告するだけだったが、それだと一度失われると
    // `isReady()`が恒久的にfalseのままになり、画面が固まったまま二度と復帰
    // しなかった（所有者の実機報告）。`handleDeviceLost()`で復帰を試みる。
    device.lost
      .then((info) => this.handleDeviceLost(info))
      .catch(() => {
        // device.lostはPromise<GPUDeviceLostInfo>で本来rejectしないが、
        // 念のため（未処理rejectionでコンソールを汚さないため）。
      });

    this.device = device;
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });

    // 以降、パイプライン/バインドグループの生成はすべてinitWithErrorScope()で
    // 囲む。EDL(M2-1)の事故では「画面が真っ黒になった」という情報しか
    // 得られず原因の特定に時間がかかったため、生成ステップごとに区切って
    // 「どの生成が失敗したか」がエラーメッセージから分かるようにする。
    await this.initWithErrorScope(device, "点群パイプラインの生成", () => {
      this.uniformLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform" },
          },
          // M2-2: 着色設定(binding 1)。ノードごとのuniform(binding 0)とは別に、
          // フレーム全体で共有する1つのuniformバッファを追加する。
          {
            binding: 1,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform" },
          },
        ],
      });

      const shaderModule = device.createShaderModule({ code: SHADER_SRC });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout] });
      const vertexState: GPUVertexState = {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: NODE_POINT_STRIDE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "unorm8x4" },
              // M2-2: intensity(u16)+classification(u8)+padding(u8)の4バイトを
              // 1つのuint32属性として読む(node_format.rsのオフセット16参照。
              // シェーダ側でビット演算により分解する。SHADER_SRCのVertexIn参照)。
              { shaderLocation: 2, offset: 16, format: "uint32" },
            ],
          },
        ],
      };

      // M3-8: 丸/四角 × オフスクリーン/スワップチェーンの4通り。フィールドの
      // コメント、およびWGSL側のfs_main_round/fs_main_squareのコメントに
      // 理由を書いてある。`depthStencil`は4つとも同じDEPTH_FORMAT(このファイル
      // 冒頭の定数コメント参照)を使う。
      const buildPointsPipeline = (fragmentEntryPoint: string, targetFormat: GPUTextureFormat): GPURenderPipeline =>
        device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: vertexState,
          fragment: {
            module: shaderModule,
            entryPoint: fragmentEntryPoint,
            targets: [{ format: targetFormat }],
          },
          primitive: { topology: "triangle-list" },
          depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
        });

      // M2-1: EDLオン(2パス)のときは、点群をスワップチェーンへ直接描かず、
      // 専用のオフスクリーンテクスチャへ描く（drawFrame()のパス1参照）。
      this.pipelineOffscreenRound = buildPointsPipeline("fs_main_round", OFFSCREEN_COLOR_FORMAT);
      this.pipelineOffscreenSquare = buildPointsPipeline("fs_main_square", OFFSCREEN_COLOR_FORMAT);
      // M3-8: EDLオフ(1パス)のときは、点群をスワップチェーンへ直接描く。
      this.pipelineSwapchainRound = buildPointsPipeline("fs_main_round", this.format);
      this.pipelineSwapchainSquare = buildPointsPipeline("fs_main_square", this.format);

      // M2-2: 着色設定の共有uniformバッファ。全ノードのbindGroup(binding 1)が
      // 同じバッファを参照する。内容は`drawFrame()`が毎フレーム`writeBuffer`で
      // 書き換える(バッファそのものの再生成はしない。既存ノードのbindGroupが
      // このバッファを固定で参照しているため、作り直すと参照が壊れる)。
      this.colorSettingsBuffer = device.createBuffer({
        size: COLOR_SETTINGS_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    });

    await this.initWithErrorScope(device, "空の背景(sky)の初期化", () => {
      this.sky.init(device, this.format, DEPTH_FORMAT);
    });
    await this.initWithErrorScope(device, "地面グリッド(ground-grid)の初期化", () => {
      this.grid.init(device, this.format, DEPTH_FORMAT);
    });
    // EDLの合成パスはスワップチェーンのレンダーパスの中、空・グリッドの後の
    // 最後に呼ばれる(drawFrame()のパス2参照)ので、出力フォーマットはスワップ
    // チェーンに合わせる。深度フォーマットも渡す必要がある(sky.ts/ground-grid.ts
    // と同じ理由。実機不具合の修正、edl.tsのinit()コメント参照: パスが
    // depthStencilAttachmentを持つ以上、このパイプラインも同じフォーマットの
    // depthStencilを宣言しないとパスと非互換になり、drawがまるごと無効になる)。
    await this.initWithErrorScope(device, "EDL合成パイプラインの初期化", () => {
      this.edl.init(device, this.format, DEPTH_FORMAT);
    });
  }

  /**
   * M3-8追加: WebGPUデバイス消失(`device.lost`)を受けたときの処理。
   * 所有者の実機報告（デバイス消失後、画面が固まったまま二度と復帰しない）
   * を踏まえ、MDNの"Handling device loss"の推奨どおり復帰を試みる。
   *
   * 手順:
   * 1. `reason`/`message`をそのままバナーに出す(所有者が原因を推測する
   *    手がかりになる。以前からある挙動で、今回変えていない)
   * 2. `reason === "destroyed"`（こちらが`GPUDevice.destroy()`を意図的に
   *    呼んだ場合。現状このクラスは自分からdestroy()を呼ぶことは無いが、
   *    将来呼ぶようになった場合や、呼び出し元が外部から破棄した場合に
   *    備えて明示的に判定する）は復帰しない。意図的な破棄に対して復帰を
   *    試みるのは筋が違う
   * 3. `dispose()`済み（コンポーネントが破棄された後）なら何もしない
   *    （もう誰も見ていないcanvasに対して非同期の復帰処理を続けない）
   * 4. `device-recovery.ts`の`decideDeviceRecovery`（純粋関数）で、直近の
   *    復帰試行の頻度から「試みてよいか」を判定する。**無限に繰り返さない**
   *    ため。諦める場合はその理由もバナーに出す
   * 5. 試みる場合、`isReady()`が復帰完了までfalseを返すよう`this.device`を
   *    先にnullにしてから（renderOnce()側は`isReady()`をrenderOnce()の
   *    入り口で見ているだけなので、これだけで安全にフレームがスキップされる）、
   *    `setupDevice()`を呼び直してアダプタ・デバイス・パイプライン・
   *    sky/grid/EDLをすべて作り直し、直近の描画サイズで`resize()`も
   *    呼び直す（深度・オフスクリーンテクスチャも作り直す必要があるため）
   * 6. 復帰に成功したら`onDeviceRecovered()`を呼ぶ。呼び出し側
   *    (point-cloud-renderer.ts)はこれでノードキャッシュを空にする
   *    （**古いデバイスのGPUバッファは新しいデバイスでは使えない**ため。
   *    `NodeLoader`はDataSource越しの生バイト取得でデバイスに依存しない
   *    ので、キャッシュさえ空にすれば次のフレームから自然に読み込み直る）
   * 7. 復帰(`setupDevice()`)自体が失敗した場合（アダプタが取れない等、
   *    ハードウェア側がより深刻な状態になっている場合）はバナーで報告して
   *    諦める。この場合、次に自然発生する`device.lost`は無い（新しい
   *    deviceを一度も得られていないため）ので、ここで再試行のループを
   *    自分から作ることはしない
   */
  private async handleDeviceLost(info: GPUDeviceLostInfo): Promise<void> {
    if (this.disposed) return;

    this.reportError(`WebGPUデバイスが失われました (reason=${info.reason}): ${info.message}`);

    if (info.reason === "destroyed") return;

    const now = Date.now();
    const decision = decideDeviceRecovery(this.recentRecoveryAttempts, now, DEFAULT_DEVICE_RECOVERY_LIMITS);
    if (!decision.shouldRecover) {
      this.reportError(`WebGPUデバイスへの復帰を諦めました: ${decision.reason}`);
      return;
    }
    this.recentRecoveryAttempts = recordDeviceRecoveryAttempt(
      this.recentRecoveryAttempts,
      now,
      DEFAULT_DEVICE_RECOVERY_LIMITS,
    );

    // isReady()をfalseにし、復帰完了までrenderOnce()側の描画をスキップさせる。
    this.device = null;

    try {
      await this.setupDevice();
      this.resize(this.lastWidth, this.lastHeight);
      this.onDeviceRecovered();
      this.reportError("WebGPUデバイスから復帰しました(読み込み済みのノードは破棄し、再読み込みします)");
    } catch (e) {
      this.reportError(`WebGPUデバイスへの復帰に失敗しました: ${String(e)}`);
    }
  }

  /**
   * 初期化の1ステップ（パイプライン/バインドグループの生成）を
   * `pushErrorScope("validation")`/`popErrorScope()`で囲み、失敗した場合に
   * 「どの生成が失敗したか」が分かるメッセージで報告する。
   *
   * これが要る理由（EDL(M2-1)の事故の教訓）: `device.onuncapturederror`は
   * デバイス全体に1つのハンドラしか持てず、メッセージだけを見ても「点群
   * パイプラインなのかEDL合成パイプラインなのか」が分からない。初期化の
   * ステップごとにエラースコープで区切ることで、`label`を先頭に付けた
   * メッセージにできる（例:「EDL合成パイプラインの初期化でバリデーション
   * エラー: <message>」）。エラースコープ内のエラーは`onuncapturederror`には
   * 飛ばない（WebGPUの仕様上、スコープが先に捕まえる）ので、両者は競合しない。
   */
  private async initWithErrorScope(device: GPUDevice, label: string, fn: () => void): Promise<void> {
    device.pushErrorScope("validation");
    fn();
    const error = await device.popErrorScope();
    if (error) {
      this.reportError(`${label}でバリデーションエラー: ${error.message}`);
    }
  }

  /** 描画に必要な一式（device/context/pipeline/深度ビュー）が揃っているか。
   *  呼び出し側はこれをrenderOnce()の入り口で確認し、揃うまで描画をスキップする。 */
  isReady(): boolean {
    return !!(
      this.device &&
      this.context &&
      this.pipelineOffscreenRound &&
      this.pipelineOffscreenSquare &&
      this.pipelineSwapchainRound &&
      this.pipelineSwapchainSquare &&
      this.depthView &&
      this.colorSettingsBuffer
    );
  }

  resize(width: number, height: number): void {
    // M3-8追加: デバイス消失からの復帰(handleDeviceLost())が、直近のサイズで
    // 深度・オフスクリーンテクスチャを作り直せるように覚えておく。`device`が
    // 無い(復帰待ち)間に呼ばれた場合も、サイズだけは更新しておく(下のreturnより
    // 前に置く理由)。
    this.lastWidth = width;
    this.lastHeight = height;
    if (!this.device) return;
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();

    // M2-1: 点群だけを描くオフスクリーンの色・深度テクスチャも、スワップチェーンの
    // 深度テクスチャと同じくウィンドウサイズに合わせて作り直す。EDLの合成パスは
    // このテクスチャのバインドグループを固定で持つので、テクスチャを作り直したら
    // バインドグループも作り直す必要がある（updateInputTextures()、edl.ts参照）。
    this.offscreenColorTexture?.destroy();
    this.offscreenColorTexture = this.device.createTexture({
      size: [width, height],
      format: OFFSCREEN_COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenColorView = this.offscreenColorTexture.createView();

    this.offscreenDepthTexture?.destroy();
    this.offscreenDepthTexture = this.device.createTexture({
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenDepthView = this.offscreenDepthTexture.createView();

    this.edl.updateInputTextures(this.device, this.offscreenColorView, this.offscreenDepthView);
  }

  /** ノードの点データが届いたときに、GPUバッファ一式（頂点・uniform・bindGroup）を
   *  作って`CachedNode`として返す。device/uniformLayoutがまだ無い（初期化前・
   *  破棄後）場合はnullを返す。キャッシュへ格納するかどうかは呼び出し側の責務。 */
  createCachedNode(key: string, node: ParsedNode): CachedNode | null {
    if (!this.device || !this.uniformLayout || !this.colorSettingsBuffer) return null;
    const device = this.device;

    const vertexBuffer = device.createBuffer({
      size: Math.max(node.pointsBytes.byteLength, NODE_POINT_STRIDE),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // pointsBytesはfetchしたArrayBufferへのビュー。writeBufferは内容をコピーするので、
    // 元のArrayBufferをここで保持し続ける必要はない。
    device.queue.writeBuffer(
      vertexBuffer,
      0,
      node.pointsBytes.buffer,
      node.pointsBytes.byteOffset,
      node.pointsBytes.byteLength,
    );

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: this.uniformLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        // M2-2: 着色設定は全ノード共有の1つのバッファ(binding 1)を参照する
        // (このバッファ自体はGpuResourcesが1つだけ持ち、内容はdrawFrame()が
        // 毎フレーム書き換える。上のcolorSettingsBufferのコメント参照)。
        { binding: 1, resource: { buffer: this.colorSettingsBuffer } },
      ],
    });

    return {
      key,
      origin: node.origin,
      pointCount: node.pointCount,
      vertexBuffer,
      uniformBuffer,
      bindGroup,
    };
  }

  /**
   * M2-1 → M3-8で分岐を追加: 点群・空・グリッドを描く。
   *
   * **EDLオンのときは従来通り2パス**（点群→オフスクリーン、背景+EDL合成→
   * スワップチェーン）。EDLは「このピクセルと隣のピクセルの深度差」から
   * 陰影を作るため、点群にだけ陰影を掛けたいなら「このピクセルは点由来か
   * 背景由来か」をフラグメントシェーダで区別できる必要があり、それには
   * 点群を独立したオフスクリーンに先に描くのが一番素直（設計判断の詳細は
   * edl.tsファイル冒頭のコメント参照。ここでは変えていない）。
   *
   * **EDLオフのときは1パスにする（M3-8、モバイル最適化の1つ）。** EDLを
   * 使わないなら「点由来か背景由来か」を区別する理由自体が無いので、
   * オフスクリーンを経由する必然性が無い。背景→点群を同じパスでスワップ
   * チェーンへ直接描くことで、オフスクリーンへの描画・テクスチャ読み込み・
   * EDL合成パスの分だけメモリ帯域の往復が減る。
   *
   * **パイプライン/パスの深度フォーマットの一致（重要、実機不具合の再発防止）**:
   * 以前EDL合成パイプラインが`depthStencil`を宣言し忘れ、パスと非互換になって
   * 画面が真っ黒になる事故があった(edl.tsのinit()コメント参照)。同じ事故を
   * この1パス経路でも起こさないよう、すべての深度テクスチャ・すべての
   * 点群パイプラインが`DEPTH_FORMAT`という同じ1つの定数を参照するように
   * してある(このファイル冒頭のDEPTH_FORMAT宣言のコメント参照)。2パス経路は
   * オフスクリーンの深度(`offscreenDepthView`)、1パス経路はスワップチェーンの
   * 深度(`depthView`)を使うが、どちらも同じDEPTH_FORMATで作られているため、
   * パイプラインの宣言と実際のパスのアタッチメントが常に一致する。
   */
  drawFrame(viewProj: Mat4, width: number, height: number, nodes: CachedNode[], options: DrawFrameOptions): void {
    const device = this.device;
    const context = this.context;
    const depthView = this.depthView;
    const offscreenColorView = this.offscreenColorView;
    const offscreenDepthView = this.offscreenDepthView;
    const colorSettingsBuffer = this.colorSettingsBuffer;
    if (
      !device ||
      !context ||
      !depthView ||
      !offscreenColorView ||
      !offscreenDepthView ||
      !colorSettingsBuffer ||
      !this.pipelineOffscreenRound ||
      !this.pipelineOffscreenSquare ||
      !this.pipelineSwapchainRound ||
      !this.pipelineSwapchainSquare
    ) {
      return;
    }

    // M2-2: 着色設定は全ノード共通で1フレームに1回だけ書けばよい(ノードごとの
    // uniform=binding 0とは違い、こちらはbinding 1として全ノードのbindGroupが
    // 同じバッファを参照している)。
    const colorSettingsData = new Float32Array(COLOR_SETTINGS_UNIFORM_FLOATS);
    colorSettingsData[0] = COLOR_MODE_INDEX[options.colorMode];
    colorSettingsData[1] = options.elevationRange.min;
    colorSettingsData[2] = options.elevationRange.max;
    colorSettingsData[3] = options.intensityRange.min;
    colorSettingsData[4] = options.intensityRange.max;
    device.queue.writeBuffer(colorSettingsBuffer, 0, colorSettingsData.buffer, colorSettingsData.byteOffset, colorSettingsData.byteLength);

    const encoder = device.createCommandEncoder();

    if (options.edlEnabled) {
      // --- パス1: 点群だけをオフスクリーンへ描く ---
      // 色はクリア時にalpha=0にしておく(「まだ点が描かれていない」の目印。ただし
      // EDL合成側の判定は深度のクリア値で行っており、このalphaは直接は使っていない。
      // 深度のほうを判定に使う理由: 頂点シェーダが円形マスクの外側をdiscardしても
      // 深度は必ずクリア値のまま残るため、"点が1つも無い"ことをより確実に表す)。
      const pointsPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: offscreenColorView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: offscreenDepthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      const pointsPipeline = options.pointShape === "square" ? this.pipelineOffscreenSquare : this.pipelineOffscreenRound;
      this.drawPoints(device, pointsPass, pointsPipeline, viewProj, width, height, nodes, options.renderScale);
      pointsPass.end();

      // --- パス2: 背景(空/グリッド/単色)を描いてから、EDL陰影付きの点群を合成する ---
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            // "sky"のときは全画面がSkyBackgroundで上書きされるので、このclearValueは
            // 実質使われない。単色モードのときだけ見えるので、そちらの色にしておく。
            clearValue: clearColorForMode(options.backgroundMode),
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      this.drawBackground(device, pass, options, width, height);

      // EDL合成(M2-1): パス1でオフスクリーンに描いた点群の色+深度を読み、隣接
      // ピクセルとの深度差から陰影を作って合成する。空・グリッドを描いた
      // 直後・最後に呼ぶことで、点群を空・グリッドの手前に不透明合成する
      // (discardしたピクセルは背景がそのまま残る)。このブランチは
      // options.edlEnabled===trueのときだけ通るので、強さは常にそのまま渡す
      // (以前あった「オフなら0を渡す」ためのif文は、EDLオフ側が下のelseへ
      // 完全に分かれたことで不要になった)。
      this.edl.draw(
        device,
        pass,
        options.edlStrength,
        options.edlRadiusPx * options.renderScale,
        NEAR,
        FAR,
        width,
        height,
      );

      pass.end();
    } else {
      // --- 1パス(M3-8): 背景→点群を同じパスでスワップチェーンへ直接描く ---
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: clearColorForMode(options.backgroundMode),
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      this.drawBackground(device, pass, options, width, height);
      const pointsPipeline = options.pointShape === "square" ? this.pipelineSwapchainSquare : this.pipelineSwapchainRound;
      this.drawPoints(device, pass, pointsPipeline, viewProj, width, height, nodes, options.renderScale);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  }

  /**
   * 空・グリッドを描く（M2-0c）。EDLオン(2パス)のパス2・EDLオフ(1パス、M3-8)の
   * どちらのスワップチェーンパスからも同じ内容で呼べるよう共通化してある
   * （元はdrawFrame()に直書きだった。ロジックは変えていない）。
   *
   * 空・グリッドは点より必ず奥に描く（M2-0c）。どちらも深度を書かない
   * (depthWriteEnabled=false, depthCompare="always")ので、この後に描く点群は
   * 常に手前に残る。
   */
  private drawBackground(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    options: DrawFrameOptions,
    width: number,
    height: number,
  ): void {
    if (options.backgroundMode !== "sky" && !options.gridEnabled) return;

    const upAxis = options.upAxis;
    const eye = options.cameraEye;

    // 実機不具合の修正（2回。TaskSheets/M2-shading-and-ui.md M2-0c、
    // scripts/diag-sky-ray.ts参照）:
    // 1回目 - ワールド空間のinvViewProjをそのままf32でGPUに渡すと、NEAR/FAR
    //         (0.01/1e7)のダイナミックレンジとautzenのような大きなワールド座標が
    //         重なってwが桁落ちし、全ピクセルNaNになっていた
    // 2回目 - 1回目の対策（全画面三角形の3頂点のレイ方向を線形補間する方式）も
    //         壊れていた。NDC=3（三角形の頂点）は画面中心から70度以上離れており、
    //         正規化済みの単位ベクトルをこの角度で線形補間すると弦を取ることに
    //         なって長さが縮み、条件によってはNaNに戻っていた
    //         （sky.tsファイル冒頭のコメント参照）
    //
    // 対策: 行列もレイ方向の補間も使わない。カメラ基底(forward/right/up)と
    // FOV/アスペクト比から、画素ごとに`dir = normalize(forward + ndc.x*rightScaled
    // + ndc.y*upScaled)`でレイ方向を組み立てる（sky.ts/ground-grid.tsのフラグメント
    // シェーダ参照）。ここではその基底をf64で計算するだけ。扱う数値はどれも
    // 大きさ~1で、f32にキャストしても精度は落ちない。
    const { forward, right, up } = cameraBasis(eye, options.cameraTarget, upAxis);
    const aspect = width / Math.max(height, 1);
    const tanHalfFovY = Math.tan(FOV_Y_RADIANS / 2);
    const rightScaled: Vec3 = [right[0] * aspect * tanHalfFovY, right[1] * aspect * tanHalfFovY, right[2] * aspect * tanHalfFovY];
    const upScaled: Vec3 = [up[0] * tanHalfFovY, up[1] * tanHalfFovY, up[2] * tanHalfFovY];

    if (options.backgroundMode === "sky") {
      this.sky.draw(device, pass, forward, rightScaled, upScaled, upAxis);
    }
    if (options.gridEnabled) {
      // グリッドは空を描いた後（or 単色クリアの後）に、半透明で重ねる。
      // ここから先もすべてカメラ相対（ワールド座標の絶対値をf32で渡さない。
      // ground-grid.tsのdraw()コメント参照）。gridRight/gridForwardは
      // カメラ基底(right/up)とは別物で、シーンのupAxisに直交する水平基底
      // （グリッド平面に沿った2D座標を作るためのもの）。
      const { right: gridRight, forward: gridForward } = horizontalBasis(upAxis);
      const eyeHeight = eye[0] * upAxis[0] + eye[1] * upAxis[1] + eye[2] * upAxis[2];
      const eyeGridRight = eye[0] * gridRight[0] + eye[1] * gridRight[1] + eye[2] * gridRight[2];
      const eyeGridForward = eye[0] * gridForward[0] + eye[1] * gridForward[1] + eye[2] * gridForward[2];
      this.grid.draw(
        device,
        pass,
        forward,
        rightScaled,
        upScaled,
        upAxis,
        gridRight,
        gridForward,
        options.gridGroundHeight - eyeHeight,
        options.gridCellSize,
        options.gridFadeDistance,
        floorMod(eyeGridRight, options.gridCellSize),
        floorMod(eyeGridForward, options.gridCellSize),
      );
    }
  }

  /**
   * 点群ノードの一覧を1つのレンダーパスへ描く。EDLオン(2パス)のパス1・
   * EDLオフ(1パス、M3-8)のどちらからも呼べるよう共通化してある（元は
   * drawFrame()に直書きだった。ノードの描画ロジック自体は変えていない）。
   *
   * `renderScale`で`POINT_SIZE_PX`を補正する理由（M3-8）: 頂点シェーダは
   * `pointSizePx / viewportWidth`でNDC上の半径を決める(SHADER_SRCのvs_main
   * 参照)。`viewportWidth`はここでは内部バッファの解像度(width引数、
   * `renderScale`だけ縮小済み)なので、`POINT_SIZE_PX`をそのまま渡すと、
   * CSSで表示サイズへ引き伸ばされたときに`1/renderScale`倍だけ大きく見えて
   * しまう(バッファを半分に縮小すると、引き伸ばし倍率が2倍になるため)。
   * `POINT_SIZE_PX * renderScale`を渡せば、引き伸ばし後の見た目のピクセル
   * サイズが`renderScale`の値によらず一定になる。デスクトップの既定値
   * renderScale=1.0では`POINT_SIZE_PX`のまま、つまり変更前と同じになる。
   */
  private drawPoints(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    viewProj: Mat4,
    width: number,
    height: number,
    nodes: CachedNode[],
    renderScale: number,
  ): void {
    pass.setPipeline(pipeline);
    const scaledPointSizePx = POINT_SIZE_PX * renderScale;
    const uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    for (const node of nodes) {
      const model = translation(node.origin[0], node.origin[1], node.origin[2]);
      const mvp = multiply(viewProj, model);
      uniformData.set(mvp, 0);
      uniformData[16] = scaledPointSizePx;
      uniformData[17] = width;
      uniformData[18] = height;
      // M2-2: 標高着色のため、ノード原点のワールドZをそのまま渡す
      // (SHADER_SRCのUniforms.originZ、colorForVertex()参照)。
      uniformData[19] = node.origin[2];
      device.queue.writeBuffer(
        node.uniformBuffer,
        0,
        uniformData.buffer,
        uniformData.byteOffset,
        uniformData.byteLength,
      );

      pass.setBindGroup(0, node.bindGroup);
      pass.setVertexBuffer(0, node.vertexBuffer);
      pass.draw(6, node.pointCount);
    }
  }

  dispose(): void {
    // M3-8追加: 破棄後は`handleDeviceLost()`が復帰を試みない(もう誰も見ていない
    // canvasに対して非同期の復帰処理を続けさせないため)。
    this.disposed = true;
    this.depthTexture?.destroy();
    this.offscreenColorTexture?.destroy();
    this.offscreenDepthTexture?.destroy();
    this.colorSettingsBuffer?.destroy();
  }
}
