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

const POINT_SIZE_PX = 4;
/** WebGPUのFOV/near/far。orchestrator側（point-cloud-renderer.ts）が投影行列を
 *  組み立てる際にも同じ値が要るため、ここからexportする。 */
export const FOV_Y_RADIANS = Math.PI / 3;
export const NEAR = 0.01;
export const FAR = 1e7;
/** 深度バッファのフォーマット。点群パイプラインと空パイプライン(sky.ts)の両方が
 *  同じレンダーパスに参加するので、1箇所にまとめて食い違いを防ぐ。 */
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

const UNIFORM_BUFFER_SIZE = 80; // mat4(64) + pointSizePx(4) + viewportWidth(4) + viewportHeight(4) + pad(4)

const SHADER_SRC = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4<f32>,
  pointSizePx: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexIn {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
};

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
  out.color = in.color;
  out.uv = corner;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // 四角形を円形に抜く。
  if (dot(in.uv, in.uv) > 1.0) {
    discard;
  }
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
  cameraEye: readonly [number, number, number];
  cameraTarget: readonly [number, number, number];
  upAxis: Vec3;
}

export class GpuResources {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private pipeline: GPURenderPipeline | null = null;
  private uniformLayout: GPUBindGroupLayout | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

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

  /**
   * WebGPUのエラーを1件報告するための呼び出し先（呼び出し側=PointCloudRendererの
   * `reportGpuError`をそのまま渡してもらう）。console.errorへの出力やUIバナー用の
   * コールバック呼び出しは呼び出し側の責務なので、ここでは中身を知らずにただ渡す。
   */
  constructor(private readonly reportError: (message: string) => void) {}

  async init(canvas: HTMLCanvasElement): Promise<void> {
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

    // WebGPUのエラーを画面に出す仕組み（新設）。
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
    device.lost
      .then((info) => {
        this.reportError(`WebGPUデバイスが失われました (reason=${info.reason}): ${info.message}`);
      })
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
        ],
      });

      const shaderModule = device.createShaderModule({ code: SHADER_SRC });
      this.pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout] }),
        vertex: {
          module: shaderModule,
          entryPoint: "vs_main",
          buffers: [
            {
              arrayStride: NODE_POINT_STRIDE,
              stepMode: "instance",
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x3" },
                { shaderLocation: 1, offset: 12, format: "unorm8x4" },
              ],
            },
          ],
        },
        fragment: {
          module: shaderModule,
          entryPoint: "fs_main",
          // M2-1: 点群はもうスワップチェーンへ直接描かない。EDLの合成パス(edl.ts)が
          // 「点が描かれたピクセルだけ」を判定できるよう、点群専用のオフスクリーン
          // テクスチャへ描く（drawFrame()のパス1参照）。
          targets: [{ format: OFFSCREEN_COLOR_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
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
    return !!(this.device && this.context && this.pipeline && this.depthView);
  }

  resize(width: number, height: number): void {
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
    if (!this.device || !this.uniformLayout) return null;
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
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
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
   * M2-1: 点群・空・グリッドを2つのレンダーパスに分けて描く。
   *
   * なぜ分けたか（EDLの陰影を点群にだけ掛け、空・グリッドには掛けないという
   * タスクシートの必須要件のため）: EDLは「このピクセルと隣のピクセルの深度差」
   * から陰影を作る。空・グリッドと点群を同じ深度バッファに描いてしまうと、
   * フラグメントシェーダの中で「このピクセルは点由来か背景由来か」を区別する
   * 手段が無くなる。そこで点群だけを独立したオフスクリーンの色+深度テクスチャに
   * 先に描き(パス1)、その後スワップチェーンへ空・グリッド・EDL合成済みの点群を
   * 順に描く(パス2)。パス2の最後に呼ぶEDL合成(this.edl.draw())は、オフスクリーンの
   * 深度がクリア値のまま(=点が無い)のピクセルをdiscardするので、空・グリッドの
   * ピクセルには一切書き込まない(edl.tsファイル冒頭のコメント参照)。
   *
   * 他に検討した案: 深度バッファに1ビット立てて判定する/ステンシルバッファを
   * 使う、なども考えたが、色・深度を別テクスチャに分けたほうが「オフスクリーンに
   * 何が入っているか」がテクスチャの宣言から素直に読み取れ、既存のsky.ts/
   * ground-grid.tsのコードに一切手を入れずに済む（所有者の「実装を追えること」を
   * 優先）。
   */
  drawFrame(viewProj: Mat4, width: number, height: number, nodes: CachedNode[], options: DrawFrameOptions): void {
    const device = this.device;
    const context = this.context;
    const pipeline = this.pipeline;
    const depthView = this.depthView;
    const offscreenColorView = this.offscreenColorView;
    const offscreenDepthView = this.offscreenDepthView;
    if (!device || !context || !pipeline || !depthView || !offscreenColorView || !offscreenDepthView) return;

    const encoder = device.createCommandEncoder();

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

    pointsPass.setPipeline(pipeline);

    const uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    for (const node of nodes) {
      const model = translation(node.origin[0], node.origin[1], node.origin[2]);
      const mvp = multiply(viewProj, model);
      uniformData.set(mvp, 0);
      uniformData[16] = POINT_SIZE_PX;
      uniformData[17] = width;
      uniformData[18] = height;
      uniformData[19] = 0;
      device.queue.writeBuffer(
        node.uniformBuffer,
        0,
        uniformData.buffer,
        uniformData.byteOffset,
        uniformData.byteLength,
      );

      pointsPass.setBindGroup(0, node.bindGroup);
      pointsPass.setVertexBuffer(0, node.vertexBuffer);
      pointsPass.draw(6, node.pointCount);
    }

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

    // 空・グリッドは点より必ず奥に描く（M2-0c）。どちらも深度を書かない
    // (depthWriteEnabled=false, depthCompare="always")ので、この後に合成する点群
    // (EDL合成パスがdiscardしない限り必ず不透明に上書きする)は常に手前に残る。
    if (options.backgroundMode === "sky" || options.gridEnabled) {
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

    // EDL合成(M2-1): パス1でオフスクリーンに描いた点群の色+深度を読み、隣接
    // ピクセルとの深度差から陰影を作って合成する。「オフでも同じ見た目になる」
    // という受け入れ条件は、オフのときstrength=0を渡すことで満たす
    // (edlShadingFactor()がstrength=0で常に無変化を返すため。edl.ts参照)。
    // 空・グリッドを描いた直後・最後に呼ぶことで、点群を空・グリッドの手前に
    // 不透明合成する(discardしたピクセルは背景がそのまま残る)。
    this.edl.draw(
      device,
      pass,
      options.edlEnabled ? options.edlStrength : 0,
      options.edlRadiusPx,
      NEAR,
      FAR,
      width,
      height,
    );

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.depthTexture?.destroy();
    this.offscreenColorTexture?.destroy();
    this.offscreenDepthTexture?.destroy();
  }
}
