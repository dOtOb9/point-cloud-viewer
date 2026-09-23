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
 * 標高用の色ランプ。**明度が単調に増加するviridis風の配色**を採用した
 * （タスクシート「配色は明度が単調に変化するものを選ぶこと。虹色(jet)は明度が
 * 非単調で、実際には無い構造が見えてしまう」に対応）。viridisは科学可視化で
 * 標準的に使われる、明度単調増加かつ色覚多様性に配慮した配色。ここでは
 * 公開されているviridisのサンプル値をt=0, 0.25, 0.5, 0.75, 1.0の5点に間引いて
 * 埋め込んでいる（完全な256段のテーブルを持つ必要は無く、5点の線形補間で
 * 十分滑らかに見える）。
 */
export const ELEVATION_RAMP: readonly RampStop[] = [
  { t: 0.0, color: [0.267, 0.005, 0.329] }, // 濃い紫（低い）
  { t: 0.25, color: [0.253, 0.265, 0.53] }, // 青紫
  { t: 0.5, color: [0.164, 0.471, 0.558] }, // 青緑
  { t: 0.75, color: [0.478, 0.821, 0.318] }, // 黄緑
  { t: 1.0, color: [0.993, 0.906, 0.144] }, // 黄（高い）
];

/** `z`を`range`（開いたファイルのバウンディングボックスのz成分）で正規化し、`ELEVATION_RAMP`から色を引く。 */
export function elevationToColor(z: number, range: ValueRange): RGB {
  return sampleRamp(ELEVATION_RAMP, normalizeValue(z, range));
}

/**
 * 強度用の色ランプ。グレースケール（暗い灰色→白）。標高と見た目をはっきり
 * 区別できるよう、あえて無彩色にした（両方をviridisにすると「今どちらの
 * モードを見ているか」が紛らわしくなる。強度は昔ながらのモノクロ強度画像に
 * 近い見た目が直感的でもある）。
 *
 * 下端を純黒(0,0,0)ではなく暗い灰色(0.08)にしてあるのは、このプロジェクトの
 * 既定の背景（`sky.ts`の単色(暗) = およそ(0.05, 0.05, 0.08)）に対して、
 * 強度最小の点が背景と見分けられなくなることを避けるため。単調増加という
 * 要件は保ったまま、最小値でも背景から視認できるようにしている。
 */
export const INTENSITY_RAMP: readonly RampStop[] = [
  { t: 0.0, color: [0.08, 0.08, 0.08] },
  { t: 1.0, color: [1.0, 1.0, 1.0] },
];

/** `intensity`を`range`（`extendRange`で実データから求めたレンジ）で正規化し、`INTENSITY_RAMP`から色を引く。 */
export function intensityToColor(intensity: number, range: ValueRange): RGB {
  return sampleRamp(INTENSITY_RAMP, normalizeValue(intensity, range));
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
