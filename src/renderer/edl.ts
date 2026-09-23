// EDL（Eye-Dome Lighting）: M2-1。
//
// なぜ要るか（TaskSheets/M2-shading-and-ui.md M2-1参照）: `sofi.copc.laz`はRGBを
// 持たない点群で、単色で描くと真っ白な塊にしか見えない。EDLは隣接ピクセルとの
// 深度差から陰影を作り、色が無くても凹凸構造を読めるようにする（Potreeが採用している
// 手法）。
//
// アルゴリズムそのもの（Potreeのedl.fragが元ネタ。考え方は同じで、このプロジェクトの
// 深度レンジ・命名に合わせて書き直した）:
//   1. 各ピクセルの深度を、NDCの[0,1]から「カメラからの実距離」に戻す(linearizeDepth)
//   2. 8方向の近傍ピクセルと比べ、「自分のほうが奥にある」ぶんだけ(max(0, 自分-近傍))
//      差を足し合わせ、平均する(response)
//   3. shade = exp(-response * スケール定数 * strength) を色に掛ける
//      （自分が近傍より手前にある＝画面から見て手前に飛び出している場合は
//      差が0にクリップされるので暗くならない。奥まった場所だけが暗くなる）
//
// **色に依存する計算をせず、深度だけを見る。** これによりRGBを持たない点群
// （sofi.copc.laz）でも問題なく機能する。
//
// ## 空・グリッドとの分離（タスクシートの必須要件）
//
// EDLの陰影は点群にだけ掛かるべきで、空やグリッドが陰影で汚れてはいけない。
// 既存の描画は空・グリッド・点群を同じレンダーパス内に順番に描いていた
// （point-cloud-renderer.tsのdrawFrame()参照）。この構成のまま点群にだけ
// EDLを掛けようとすると、「フラグメントシェーダの中でこのピクセルが点由来か
// 背景由来か」を区別する手段が無い。
//
// 採用した方式: **点群を独立したオフスクリーンの色+深度テクスチャに先に描き、
// EDLの合成パスでそのテクスチャだけを読む。** 空・グリッドは今まで通り
// スワップチェーンへ直接描く。合成パスは、オフスクリーンの深度が
// 「クリア値のまま(=点が1つも描かれなかった)」のピクセルを`discard`する
// ことで、そのピクセルの書き込みを一切行わない。WebGPUの`discard`は
// 「そのフラグメントを完全に捨てる」動作なので、そのピクセルには既に
// 描かれている空・グリッド・単色の背景がそのまま残る。
//
// 検討した他の案:
// - **深度バッファのビットやステンシルバッファで「点かどうか」を区別する**:
//   実装できるが、深度/ステンシルの1ビットに意味を持たせる分、後から読む人が
//   「このビットは何のためにあるか」を深度バッファの外から探す必要が生まれる。
//   別テクスチャに分けたほうが「オフスクリーンに何が入っているか」がテクスチャの
//   宣言そのものから読み取れる（所有者の「実装を追えること」を優先）。
// - **1本のレンダーパスの中でシェーダを工夫し、空/グリッドを描く前に点群の深度だけ
//   先に用意する**: 空・グリッドのシェーダ自体にEDL用の深度参照を混ぜる必要が
//   生まれ、sky.ts/ground-grid.tsの見通しが悪くなる。パスを分けたほうが
//   「どのパスが何をするか」が既存の空・グリッドのコードに触れずに済む。
//
// ## 深度の線形化（linearizeDepth）
//
// `mat4.ts`の`perspective()`はWebGPU向けのNDC(z: 0..1)の透視投影行列を作る。
// この行列に対応する、NDC深度から「カメラからの実距離(view空間の-z)」への
// 変換式は次の通り（`near`/`far`は`point-cloud-renderer.ts`のNEAR/FARと同じ値を
// 渡すこと）。
//
//   linearDepth = (near * far) / (far - ndcDepth * (far - near))
//
// 検算: ndcDepth=0(近クリップ)でlinearDepth=near、ndcDepth=1(遠クリップ)で
// linearDepth=farになる。下のテストで確認している。

export type Vec3 = readonly [number, number, number];

/** EDLの既定のオン/オフ。既定はオン（タスクシートの指示通り）。 */
export const DEFAULT_EDL_ENABLED = true;

/**
 * EDLの強さの既定値。**未検証の初期値。** Potreeの既定値(edlStrength、
 * バージョンにより0.4〜1.0)を参考にしたが、本プロジェクトの深度レンジ
 * (NEAR=0.01, FAR=1e7、point-cloud-renderer.ts参照)やsofi.copc.lazでの
 * 見え方は実測していない。強すぎる/弱すぎる場合はUIのスライダーで
 * その場で調整できる。
 */
export const DEFAULT_EDL_STRENGTH = 1.0;

/**
 * EDLが近傍として見る距離（スクリーンピクセル単位）の既定値。**未検証の初期値。**
 * Potreeの既定値(edlRadius、バージョンにより1.0〜1.4)を参考にした。
 */
export const DEFAULT_EDL_RADIUS_PX = 1.4;

/**
 * 深度差(response)を陰影に変換する際のスケール定数。Potreeのedl.fragが使っている
 * 値(300.0)をそのまま借りている。**この値の妥当性はこのプロジェクトの深度レンジで
 * 実測していない。** 深度差がどれだけの暗さになるかはシーンのスケールにも依存する
 * ため、実際の効き具合はUIのstrengthスライダーで調整することを想定している。
 */
export const EDL_RESPONSE_SCALE = 300.0;

/**
 * NDC深度(0..1、WebGPUの深度バッファの値そのもの)を、カメラからの実距離に戻す。
 * `mat4.ts`の`perspective()`が作る投影行列に対応する式（ファイル冒頭のコメント参照）。
 *
 * GPU上のWGSL版（edl.tsのEDL_SHADER_SRC内`linearizeDepth`）は同じ式を手で
 * 再実装したもの。WGSL側はGPUが無いとテストできないため、ここで純粋関数として
 * 切り出したこちらをテストで担保し、シェーダ側は目視でも式が一致していることを
 * 確認できるようコメントで対応を明記してある。
 */
export function linearizeDepth(ndcDepth: number, near: number, far: number): number {
  return (near * far) / (far - ndcDepth * (far - near));
}

/**
 * EDLの陰影係数(shade)を計算する。1.0で無変化、小さいほど暗くなる。
 *
 * - `ownDepth`: このピクセルの線形化済み深度（`linearizeDepth`の戻り値）
 * - `neighbourDepths`: 近傍ピクセルの線形化済み深度の配列（背景など「点が無い」
 *   近傍は呼び出し側で除外して渡すか、`ownDepth`より確実に大きい値にしておけば
 *   自動的に寄与0になる。GPU側の実装では除外する方式を使っている）
 * - `strength`: UIから渡される強さ。0のとき常に1.0を返す（EDL無効=元の色のまま、
 *   タスクシートの受け入れ条件「強さ0でM1と同じ見た目になる」を満たす）
 *
 * 自分が近傍より「奥にある」(ownDepth > neighbourDepth)ぶんだけ暗くなり、
 * 自分が近傍より「手前にある」(ownDepthが小さい)場合は寄与が0にクリップされ
 * 暗くならない。これにより、奥まった場所（近傍に囲まれた凹み）だけが暗くなり、
 * 手前に飛び出した部分は明るいまま残る（Eye-Dome Lightingの見た目の根拠）。
 */
export function edlShadingFactor(ownDepth: number, neighbourDepths: readonly number[], strength: number): number {
  if (neighbourDepths.length === 0 || strength === 0) return 1.0;

  let sum = 0;
  for (const neighbourDepth of neighbourDepths) {
    sum += Math.max(0, ownDepth - neighbourDepth);
  }
  const response = sum / neighbourDepths.length;

  return Math.exp(-response * EDL_RESPONSE_SCALE * strength);
}

/** EDL合成パス用のuniformバッファのレイアウト。フィールドはすべてf32のスカラーで、
 *  point-cloud-renderer.tsのUniforms構造体と同じ流儀（vec4に詰め替えない）。 */
const EDL_UNIFORM_FLOATS = 8; // strength, radiusPx, near, far, viewportWidth, viewportHeight, pad, pad
const EDL_UNIFORM_BYTES = EDL_UNIFORM_FLOATS * 4;

const EDL_SHADER_SRC = /* wgsl */ `
struct EdlUniforms {
  strength: f32,        // 強さ。0で無効(元の色のまま)
  radiusPx: f32,        // 近傍として見る距離(スクリーンピクセル)
  near: f32,
  far: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(0) var<uniform> u: EdlUniforms;
// 点群だけをオフスクリーンに描いた色と深度（sky.ts/ground-grid.tsのファイル冒頭
// コメント、およびこのファイル冒頭の「空・グリッドとの分離」参照）。
// textureLoadで整数ピクセル座標を直接読むので、サンプラーは要らない
// (フィルタリングをしない=補間による誤差が入らない、というメリットもある)。
@group(0) @binding(1) var pointColor: texture_2d<f32>;
@group(0) @binding(2) var pointDepth: texture_depth_2d;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  // 画面全体を覆う巨大三角形（頂点バッファ不要。sky.ts/ground-grid.tsと同じ手法）。
  // このパスはNDC位置以外何も要らない(方向ベクトルの復元は不要)ので、
  // sky.ts/ground-grid.tsが踏んだ「方向ベクトルの線形補間」の罠はそもそも関係ない。
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VertexOut;
  out.clipPosition = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return out;
}

// NDC深度(0..1)をカメラからの実距離に戻す。edl.tsのlinearizeDepth()と同じ式
// （TypeScript版はvitestで検証済み。WGSL側は手での再実装であり、GPUが無いと
// 直接はテストできない。式が一致していることは目視で保つ）。
fn linearizeDepth(ndcDepth: f32) -> f32 {
  return (u.near * u.far) / (u.far - ndcDepth * (u.far - u.near));
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(pointDepth));
  let coord = vec2<i32>(i32(fragCoord.x), i32(fragCoord.y));

  let ownDepthNdc = textureLoad(pointDepth, coord, 0);
  if (ownDepthNdc >= 1.0) {
    // このピクセルには点が1つも描かれていない(オフスクリーンパスのクリア値=
    // 遠クリップのまま)。discardして何も書かない＝空・グリッド・単色の背景が
    // そのまま残る。EDLの陰影が点群にしか掛からないのはこの判定による
    // (タスクシートの必須要件。ファイル冒頭の「空・グリッドとの分離」参照)。
    discard;
  }

  let color = textureLoad(pointColor, coord, 0);
  let ownDepth = linearizeDepth(ownDepthNdc);

  // 8方向の近傍と比べる(Potreeと同じ本数)。近傍座標は画面端でクランプし、
  // 範囲外アクセス（textureLoadの範囲外は0を返す仕様で、深度0=近クリップ=
  // 「異常に手前」という誤った値になってしまう）を避ける。
  var neighbourOffsets = array<vec2<f32>, 8>(
    vec2<f32>(1.0, 0.0), vec2<f32>(-1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(0.0, -1.0),
    vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, -1.0),
  );

  var responseSum: f32 = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let offset = vec2<i32>(round(neighbourOffsets[i] * u.radiusPx));
    let neighbourCoord = clamp(coord + offset, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
    let neighbourDepthNdc = textureLoad(pointDepth, neighbourCoord, 0);
    if (neighbourDepthNdc < 1.0) {
      // 近傍にも点がある場合だけ寄与を足す。近傍が背景(点が無い)場合は無視する
      // (edl.tsのedlShadingFactor()コメント参照。除外しない場合、背景の深度=遠方を
      // 「大きな凹み」と誤検出してしまう)。
      let neighbourDepth = linearizeDepth(neighbourDepthNdc);
      responseSum = responseSum + max(0.0, ownDepth - neighbourDepth);
    }
  }
  let response = responseSum / 8.0;

  // 300.0(EDL_RESPONSE_SCALE)はPotreeから借りた経験値。edl.ts冒頭のコメント参照。
  let shade = exp(-response * 300.0 * u.strength);

  return vec4<f32>(color.rgb * shade, 1.0);
}
`;

/**
 * EDLの合成パス。点群だけを描いたオフスクリーンの色+深度テクスチャを読み、
 * 陰影を掛けてからスワップチェーンへ合成する（discardで背景ピクセルには
 * 触れない。ファイル冒頭の「空・グリッドとの分離」参照）。
 *
 * sky.ts/SkyBackground・ground-grid.ts/GroundGridと同じ構造（全画面パス、
 * init()でパイプライン構築、draw()で毎フレーム呼ぶ）だが、入力がuniformの
 * 数値だけでなくテクスチャ(点群のオフスクリーン描画結果)にもなる点が違う。
 * テクスチャはウィンドウリサイズのたびに作り直されるため、そのつど
 * `updateInputTextures()`でバインドグループを作り直す必要がある
 * （point-cloud-renderer.tsのresize()参照）。
 */
export class EdlPass {
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private readonly uniformData = new Float32Array(EDL_UNIFORM_FLOATS);

  /**
   * スワップチェーンと同じフォーマットへ書き込む（このパスはスワップチェーンの
   * レンダーパスの中で、空・グリッドの後・最後に呼ばれる）。
   *
   * `depthFormat`は、このパスが実際に描き込まれるレンダーパス
   * （point-cloud-renderer.tsのdrawFrame()パス2）の`depthStencilAttachment`と
   * 同じフォーマット（`DEPTH_FORMAT`）を渡すこと。
   *
   * **実機不具合の修正:** 当初はこのパイプラインに`depthStencil`を一切
   * 指定していなかった。「深度を読むだけで書かないのだから、深度アタッチメントに
   * 関わる設定は不要のはず」という誤った理解によるもので、実際には
   * **画面が真っ黒になり何も描画されなくなる**不具合として現れた
   * （TaskSheets/M2-shading-and-ui.md M2-1参照）。
   *
   * 原因はWebGPUのパイプライン/レンダーパス互換性の要件にある。
   * レンダーパスが`depthStencilAttachment`を持つ場合、そのパス内で使う
   * すべてのパイプラインは、**同じdepth-stencilフォーマットの`depthStencil`を
   * 宣言していなければならない**（宣言しない＝そのパイプラインはdepth-stencil
   * 無しのパスとしか互換にならない）。EDLの合成パスは空・グリッドと同じ
   * レンダーパス（`depthStencilAttachment`を持つ、drawFrame()パス2）の中で
   * 呼ばれるため、`depthStencil`を宣言していないこのパイプラインは
   * そのパスと非互換になる。**非互換なパイプラインでdrawするとバリデーション
   * エラーになり、そのコマンドエンコーダ全体が無効になる**
   * （`encoder.finish()`が無効なコマンドバッファを返し、`submit()`で
   * そのフレームがまるごと捨てられる）。これが「画面が真っ黒」の直接の原因。
   *
   * 直し方は`sky.ts`/`ground-grid.ts`と同じ: 深度を書かないパイプラインでも
   * `depthStencil: { format, depthWriteEnabled: false, depthCompare: "always" }`を
   * 明示的に宣言する（「深度に触れない」ことと「depthStencilの宣言が要らない」
   * ことは別の話だった、という教訓）。
   */
  init(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: EDL_SHADER_SRC });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      // 深度は読むだけで書かないが、呼び出し元のレンダーパス（空・グリッドと
      // 同じ、depthStencilAttachmentを持つパス）と互換にするため、
      // sky.ts/ground-grid.tsと同じ「書かない・常に通す」設定を明示的に宣言する
      // 必要がある（init()のコメント参照。この宣言を省略すると、パスの深度
      // アタッチメントと非互換になりdrawがまるごと無効になる不具合があった）。
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "always" },
    });

    this.uniformBuffer = device.createBuffer({
      size: EDL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * ウィンドウリサイズなどでオフスクリーンの色/深度テクスチャが作り直されたら
   * 呼ぶこと。バインドグループはテクスチャビューを固定で参照するため、
   * テクスチャそのものが変わるたびに作り直す必要がある。
   */
  updateInputTextures(device: GPUDevice, colorView: GPUTextureView, depthView: GPUTextureView): void {
    if (!this.bindGroupLayout || !this.uniformBuffer) return;
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: colorView },
        { binding: 2, resource: depthView },
      ],
    });
  }

  /**
   * スワップチェーンのレンダーパスの中で、空・グリッドを描いた後の最後に呼ぶこと。
   * `strength`は呼び出し側(point-cloud-renderer.ts)が「EDLがオフなら0を渡す」
   * ことで無効化を表現する（シェーダ側にオン/オフの分岐を持たせず、
   * strength=0のとき常に無変化になる`edlShadingFactor`の性質だけで実現する）。
   */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    strength: number,
    radiusPx: number,
    near: number,
    far: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    this.uniformData[0] = strength;
    this.uniformData[1] = radiusPx;
    this.uniformData[2] = near;
    this.uniformData[3] = far;
    this.uniformData[4] = viewportWidth;
    this.uniformData[5] = viewportHeight;
    this.uniformData[6] = 0;
    this.uniformData[7] = 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1);
  }
}
