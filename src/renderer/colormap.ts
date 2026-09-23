// カラーマップ切替（M2-2）。
//
// なぜ要るか（TaskSheets/M2-shading-and-ui.md M2-2参照）: `sofi.copc.laz`のように
// RGBを持たない点群を読む手段。EDL(M2-1、edl.ts)は深度の不連続から陰影を作るだけで
// 色そのものは作らないため、「色を持たない点群でも何らかの色を割り当てる」役目は
// こちらが担う。EDLとカラーマップは掛け合わせて使う想定（陰影×色）で、互いに独立
// している（このファイルは深度を一切見ない。EDLは深度だけを見て色を見ない。
// 合成の順序はrenderer側で、着色パスの後にEDLの陰影係数を色へ掛ける形になる）。
//
// ここに置くのはGPUに依存しない純粋な計算だけ（値→色のランプ補間、標高/強度の
// 正規化、分類コード→色の表）。GPU側のバインド・パイプライン結線は
// point-cloud-renderer.tsの担当（このファイルはedl.tsと同じ形で、WGSL側に同じ式を
// 手で再実装したものを置き、こちらはvitestで直接検証する）。
//
// ## ノードのバイナリ形式との対応
//
// `crates/pcv-core/src/node_format.rs`が運ぶ属性のうち、着色に使うのは次の3つ
// （形式は変えていない）。
// - RGBA (u8×4): 色を持つファイル（format 2/3/5/7/8/10）でのみ意味を持つ。
//   `flags & FLAG_COLOR`が立っていない場合、値は全点`[255,255,255,255]`で埋まる
//   （`node_format.rs`の`encode_node`参照）ため、判別には`FLAG_COLOR`
//   （`src/datasource/node-format.ts`の`hasColor`、`CloudInfo.hasColor`）を使う
//   必要がある。RGBAの値そのものからは「本当に無色か、たまたま白か」を区別できない。
// - intensity (u16): ほぼ全ての点群が持つ。COPCが要求するLASフォーマット6-8では
//   常に有効（`FLAG_INTENSITY`は常に立つ）。
// - classification (u8): 分類済みデータでのみ意味を持つ。同上、フラグは常に立つが、
//   分類されていないデータでは全点が0（未分類）になりうる。

/** 着色モード。少なくともこの4つを左パネルから切り替えられることが受け入れ条件。 */
export type ColorMode = "rgb" | "elevation" | "intensity" | "classification";

export const COLOR_MODES: readonly ColorMode[] = ["rgb", "elevation", "intensity", "classification"];

/**
 * 既定の着色モードはRGB。ファイルが実際にRGBを持つ場合、それが最も素直な見た目
 * になるため。
 */
export const DEFAULT_COLOR_MODE: ColorMode = "rgb";

/**
 * RGBを持たない点群（`sofi.copc.laz`など）を開いたときのフォールバック先。
 *
 * **なぜ標高か（所有者の体験に直結するため理由を残す）:**
 * - 標高はCOPCの全点が必ず持つ連続値で、`CloudInfo`のバウンディングボックス
 *   （min/maxのz成分）から即座にレンジが決まる。強度と違い「実際のデータに
 *   意味のある値が入っているか」をファイルごとに気にする必要が無い
 *   （強度はセンサー依存で、まれに全点0のような無意味なデータもありうる）。
 * - 分類は「分類済みデータでのみ意味を持つ」（タスクシート）。分類されていない
 *   点群では全点が同じ色（未分類）になり、構造が全く見えない。標高はどんな
 *   点群でも地形の起伏に沿った変化が必ず出る。
 * - EDL（既定オン、M2-1）は深度差から陰影は作るが色そのものは作らない。
 *   標高を重ねることで「どの高さにいるか」という、陰影だけでは分からない
 *   情報が追加される。RGB無し点群を開いた直後の一番最初の見た目として、
 *   構造(EDL)+高さ(標高色)の組み合わせが最も情報量が多いと判断した。
 *
 * 強度をフォールバック先にしなかった理由: 強度はセンサー・取得条件によって
 * 実際の値域が大きく異なり（0-255しか使っていない、大部分が同じ値、など）、
 * 標高ほど「開いた瞬間に必ず意味のある絵になる」保証が無い。
 */
export const FALLBACK_COLOR_MODE_WITHOUT_RGB: ColorMode = "elevation";

/**
 * 要求されたモードとファイルの実際の色の有無から、実際に使うモードを決める。
 * RGBが無いファイルで"rgb"が要求された場合だけ、`FALLBACK_COLOR_MODE_WITHOUT_RGB`
 * に落とす（受け入れ条件「RGBを持たない点群ではRGBが選べないか、選んだときに
 * 分かる形で別モードに落ちる」）。UI側はこの関数の戻り値を実際のモードとして表示し、
 * 「RGBを選んだつもりが標高になっている」ことが分かるようにする
 * （`LayerPanel`はRGBの選択肢自体もdisabledにするので、両対策になっている）。
 */
export function resolveColorMode(mode: ColorMode, hasColor: boolean): ColorMode {
  if (mode === "rgb" && !hasColor) return FALLBACK_COLOR_MODE_WITHOUT_RGB;
  return mode;
}

/** 0..1にクランプする。 */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** 連続値のレンジ。標高・強度の正規化に使う。 */
export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/**
 * 値をレンジに対して0..1へ正規化し、範囲外はクランプする。
 * `range.max <= range.min`（レンジが縮退している。例えば点群が1点しかない、
 * または強度がまだ1回も観測されていない）の場合は0を返す
 * （0除算やNaNの伝播を避けるための安全側の既定値）。
 */
export function normalizeValue(value: number, range: ValueRange): number {
  if (!(range.max > range.min)) return 0;
  return clamp01((value - range.min) / (range.max - range.min));
}

/**
 * 観測した値からレンジを広げていくヘルパー。強度(intensity)はセンサー・
 * ファイルごとに実際の値域が大きく異なり（u16のフルレンジ0-65535を使うとは
 * 限らない）、`CloudInfo`のような固定のメタデータからは分からないため、
 * 実際に読み込んだ点の最小/最大から動的にレンジを決める
 * （タスクシート「レンジの決め方（実データの分布に合わせる）が要点になる」）。
 * 呼び出し側(renderer)がノードを読み込むたびに、そのノードの強度の最小/最大を
 * ここへ渡してレンジを広げていく想定（1点ずつではなくノード単位でまとめて
 * 呼べるよう、値は1つだけ受け取るシンプルな形にしてある。ノード内の最小/最大を
 * 求める処理自体は呼び出し側が行う）。
 *
 * 標高はこの関数を使わない。`CloudInfo`のバウンディングボックス(min/maxのz成分)が
 * 開いた時点で分かっているため、動的な拡張が要らない
 * （`FALLBACK_COLOR_MODE_WITHOUT_RGB`のコメント参照）。
 */
export function extendRange(range: ValueRange | null, value: number): ValueRange {
  if (range === null) return { min: value, max: value };
  return { min: Math.min(range.min, value), max: Math.max(range.max, value) };
}

/** RGB色。各成分0..1（WGSLのvec3<f32>の色表現に合わせる。edl.tsのcolor.rgbと同じ流儀）。 */
export type RGB = readonly [number, number, number];

/** 色ランプの制御点。`t`は0..1、`sampleRamp`が線形補間する。 */
export interface RampStop {
  readonly t: number;
  readonly color: RGB;
}

/**
 * 色ランプをtで補間してサンプルする。`stops`は`t`の昇順であること
 * （呼び出し側の定数はすべて昇順で書いてある）。範囲外の`t`は両端の色にクランプする。
 */
export function sampleRamp(stops: readonly RampStop[], t: number): RGB {
  if (stops.length === 0) {
    throw new Error("sampleRamp: stops must not be empty");
  }
  const tc = clamp01(t);
  const first = stops[0];
  if (tc <= first.t) return first.color;
  const last = stops[stops.length - 1];
  if (tc >= last.t) return last.color;

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (tc >= a.t && tc <= b.t) {
      const localT = b.t === a.t ? 0 : (tc - a.t) / (b.t - a.t);
      return [
        a.color[0] + (b.color[0] - a.color[0]) * localT,
        a.color[1] + (b.color[1] - a.color[1]) * localT,
        a.color[2] + (b.color[2] - a.color[2]) * localT,
      ];
    }
  }
  // tがstopsの最初と最後の間にあり、かつstopsが昇順である限りここには来ない。
  return last.color;
}

/**
 * 標高・強度の両方に使う色ランプ。**CloudCompareの既定配色（青→緑→黄→赤）に
 * ならった。** 所有者の要望は「CloudCompareのように、青→緑→赤で標高とIntensity
 * は表示しよう」（標高と強度を同じランプにする、CloudCompareに寄せる）。
 *
 * **なぜ黄色を挟むか（所有者の「青→緑→赤」をそのまま3点にしなかった理由）:**
 * 緑(0,1,0)と赤(1,0,0)をRGB空間でそのまま線形補間すると、中間点は
 * (0.5, 0.5, 0)になる。これは彩度の高い黄色ではなく、**暗く濁ったオリーブ色
 * (茶色がかった黄緑)**に見える（緑と赤という正反対の原色を直線でつなぐと、
 * 通過点が両方の性質を弱め合った濁った色になるため）。CloudCompareの既定配色も
 * 実際には青→緑→黄→赤の4点で、緑と赤の間に彩度の高い黄色(1,1,0)を挟むことで
 * この濁りを避けている。所有者の要望（CloudCompareのように、かつ青→緑→赤）を
 * 両立させるため、CloudCompareの実際の配色（黄色を挟んだ4点）をそのまま採用した。
 *
 * かつては標高にviridis風、強度にグレースケールという別々のランプを使っていたが、
 * 所有者の要望により統合した（「標高とIntensityは表示しよう」＝同じ見た目で
 * 統一する）。
 *
 * **明度は単調ではない**（黄(1,1,0)の相対輝度≈0.93に対し、赤(1,0,0)は≈0.21で、
 * 黄→赤の間で暗くなる）。これは以前のタスク（M2-1/M2-2着手当初）で立てていた
 * 「配色は明度が単調に変化するものを選ぶこと（虹色/jetは避ける）」という指針とは
 * 厳密には矛盾するが、所有者が実機の使用経験から名指しで要望した配色であり、
 * 所有者自身の判断を優先した。CloudCompare自体もこの配色を既定にしており、
 * 点群業界で広く使われている実績のある配色でもある。
 */
export const ELEVATION_INTENSITY_RAMP: readonly RampStop[] = [
  { t: 0, color: [0, 0, 1] }, // 青（低い/弱い）
  { t: 1 / 3, color: [0, 1, 0] }, // 緑
  { t: 2 / 3, color: [1, 1, 0] }, // 黄
  { t: 1, color: [1, 0, 0] }, // 赤（高い/強い）
];

/** `z`を`range`（LASヘッダーの実データ範囲。`src/renderer/scene-bounds.ts`の
 *  `elevationRangeFromCloudBounds`参照）で正規化し、`ELEVATION_INTENSITY_RAMP`から色を引く。 */
export function elevationToColor(z: number, range: ValueRange): RGB {
  return sampleRamp(ELEVATION_INTENSITY_RAMP, normalizeValue(z, range));
}

/** `intensity`を`range`（`extendRange`で実データから求めたレンジ）で正規化し、`ELEVATION_INTENSITY_RAMP`から色を引く。 */
export function intensityToColor(intensity: number, range: ValueRange): RGB {
  return sampleRamp(ELEVATION_INTENSITY_RAMP, normalizeValue(intensity, range));
}

/**
 * `stops`（`sampleRamp`と同じ形式、t昇順）から、同じ区分線形補間をするWGSLの
 * 関数定義を文字列として生成する。
 *
 * **なぜ生成するのか（TSとWGSLのランプが食い違わないようにする仕組み）:**
 * このプロジェクトはGPUに依存する処理をvitestで直接検証できないため、
 * WGSL側のロジックをTypeScript側の対応する純粋関数と手で一致させ、コメントで
 * 対応を明記する、という方針を採ってきた（`edl.ts`の`linearizeDepth`/
 * `edlShadingFactor`と`EDL_SHADER_SRC`内の同名ロジックが先例）。しかし色の
 * ランプについては、コメントによる対応だけでは「片方だけ値を変えて
 * もう片方を直し忘れる」事故を防げない（実際、この関数を作る前は
 * `gpu-resources.ts`のWGSL文字列に色の数値を手で書き写しており、値の
 * 食い違いを検出する手段が無かった）。そこで**制御点の定義をこのファイル
 * 側に1つだけ持ち、WGSLのコードはその定義から生成する**ことで、
 * 「2箇所に同じランプがあるが、生成元は1つ」という構造にした
 * （`gpu-resources.ts`の`SHADER_SRC`はこの関数の戻り値をテンプレートリテラル内へ
 * 直接埋め込む。`colormap.test.ts`の`rampToWgslFunction`のテストも参照）。
 *
 * 生成されるWGSL関数のロジックは`sampleRamp`と等価（両端はクランプ、
 * 区間ごとに`mix`で線形補間）。
 */
export function rampToWgslFunction(fnName: string, stops: readonly RampStop[]): string {
  if (stops.length < 2) {
    throw new Error("rampToWgslFunction: stops must have at least 2 entries");
  }

  // WGSLの浮動小数点リテラルは小数点を要求する("1"ではなく"1.0")。
  const fmt = (n: number): string => {
    const rounded = Number(n.toFixed(6));
    const s = rounded.toString();
    return s.includes(".") || s.includes("e") ? s : `${s}.0`;
  };
  const colorLiteral = (c: RGB): string => `vec3<f32>(${fmt(c[0])}, ${fmt(c[1])}, ${fmt(c[2])})`;

  const lines: string[] = [`fn ${fnName}(t: f32) -> vec3<f32> {`];
  stops.forEach((stop, i) => {
    lines.push(`  let c${i} = ${colorLiteral(stop.color)};`);
  });
  lines.push(`  let tc = clamp(t, 0.0, 1.0);`);
  // sampleRampと同じ順序で区間を試す。最後の区間の条件が外れた場合
  // (tc >= 最後の制御点のt)は最後の色を返す(sampleRampの「上端はクランプ」と同じ)。
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    lines.push(`  if (tc < ${fmt(b.t)}) { return mix(c${i}, c${i + 1}, (tc - ${fmt(a.t)}) / ${fmt(b.t - a.t)}); }`);
  }
  lines.push(`  return c${stops.length - 1};`);
  lines.push(`}`);
  return lines.join("\n");
}

/**
 * ASPRS LAS標準分類コードへの配色。地表(2)・植生(3-5)・建物(6)のような
 * 素直な対応を中心に、代表的なコード0-18を割り当てた
 * （タスクシート「分類コードの色はASPRS LASの標準分類に沿うのが素直」）。
 *
 * 色は「似た意味を持つコードは近い色相にする」方針で選んだ（低/中/高植生は
 * すべて緑系で明度だけ変える、ワイヤー関連(13/14/16)は黄土色系でまとめる、等）。
 * ノイズ系(7=低ノイズ点, 18=高ノイズ)は彩度の高い赤系にして「異常値」として
 * 目に付くようにしてある。
 */
const ASPRS_CLASSIFICATION_COLORS: ReadonlyMap<number, RGB> = new Map<number, RGB>([
  [0, [0.6, 0.6, 0.6]], // Created, never classified
  [1, [0.78, 0.78, 0.78]], // Unclassified
  [2, [0.55, 0.4, 0.22]], // Ground（地表。茶色）
  [3, [0.62, 0.82, 0.35]], // Low Vegetation
  [4, [0.32, 0.66, 0.28]], // Medium Vegetation
  [5, [0.1, 0.42, 0.16]], // High Vegetation
  [6, [0.85, 0.32, 0.22]], // Building
  [7, [1.0, 0.0, 1.0]], // Low Point (noise) — 異常値として目立つマゼンタ
  [8, [0.5, 0.5, 0.5]], // Reserved (旧仕様のModel Key-point相当)
  [9, [0.15, 0.4, 0.85]], // Water
  [10, [0.4, 0.4, 0.45]], // Rail
  [11, [0.25, 0.25, 0.28]], // Road Surface
  [12, [0.58, 0.58, 0.58]], // Reserved (旧仕様のOverlap Points相当。8と区別できるよう明度をわずかにずらした)
  [13, [0.8, 0.6, 0.1]], // Wire Guard
  [14, [0.9, 0.72, 0.2]], // Wire Conductor
  [15, [0.7, 0.42, 0.12]], // Transmission Tower
  [16, [0.82, 0.55, 0.32]], // Wire-Structure Connector
  [17, [0.62, 0.32, 0.7]], // Bridge Deck
  [18, [1.0, 0.15, 0.15]], // High Noise — 異常値として目立つ赤
]);

/**
 * 未知の分類コード（上記の表に無いコード。LAS仕様の予約領域やベンダー拡張）用の色。
 * 表中のどの色とも被らないシアンにし、「表に定義が無いコードが来ている」ことが
 * 一目で分かるようにした（表中の色はどれも彩度の高いシアン系を使っていない）。
 */
export const UNKNOWN_CLASSIFICATION_COLOR: RGB = [0.0, 0.9, 0.9];

/** 分類コードから色を引く。表に無いコードは`UNKNOWN_CLASSIFICATION_COLOR`にフォールバックする。 */
export function classificationToColor(code: number): RGB {
  return ASPRS_CLASSIFICATION_COLORS.get(code) ?? UNKNOWN_CLASSIFICATION_COLOR;
}
