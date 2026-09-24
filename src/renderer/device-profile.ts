// M3-8: モバイル判定と、各最適化手段の既定値をまとめて決める。
//
// 背景（詳細はTaskSheets/M3-release-and-update.md M3-8「実施計画」・
// TaskSheets/ADR-0009-adaptive-render-settings.md参照）: 所有者の実機
// (OPPO Pad Air / Snapdragon 680 / Adreno 610 / RAM 4GB)では、点予算を
// 20,000点程度まで下げないとアプリが落ちる。原因はまだ確定していないが、
// 所有者はGPU負荷が原因と見て最適化を進める判断をした。ただし「1つの原因を
// 決め打ちで直す」のではなく、**各最適化手段を個別に切り替えられるようにし、
// 実機で1つずつ試すことで最適化と原因の切り分けを同時に行う**という
// 進め方を取っている。このファイルはその「モバイルでは何を既定にするか」の
// 判断を1箇所にまとめた純粋関数群で、WebGPUもReactも知らない
// (vitestだけで検証できる。device-profile.test.ts参照)。
//
// ## モバイル判定の方針（ADR-0009を踏襲）
//
// ADR-0009は「GPU名(adapter.info)に依存した分岐を増やさない」と明記している。
// 理由はADR-0009参照(adapter.infoは意図的に粗く、GPU名から性能表を引く方式は
// 引くべき名前が手に入らない)。この方針をモバイル判定にもそのまま適用し、
// **GPUベンダ名やUAのモデル名は一切見ない。** 代わりに、ブラウザ横断で
// 取得できる2つの信号だけを使う:
//
// - `navigator.deviceMemory`（Chromium系のブラウザ・WebViewで取得できる、
//   0.25/0.5/1/2/4/8 GiBの粗い刻み。取れない環境ではundefined）
// - タッチ主体の入力デバイスかどうか（`matchMedia("(pointer: coarse)")`）
//
// どちらか一方だけでも判定できる設計にしてある(下の`isMobileDevice`参照)。
// タッチ主体は「操作方法」の観点でモバイル的な最適化(四角い点・EDLオフ等)が
// 効くはずという判断、低いdeviceMemoryは「メモリに余裕が無い」という直接の
// 判断で、それぞれ独立に「モバイル寄りの既定値にすべき」根拠になるため、
// OR条件にした（所有者の実機のように両方が真の場合はもちろんモバイル判定になる）。

import { NODE_POINT_STRIDE } from "../datasource/node-format";
import { CACHE_BUDGET_MULTIPLIER, pointBudgetMaxFromMemoryBudget } from "./point-budget";

/** 点の形。丸は`discard`による円形マスク、四角は`discard`なし。
 *  なぜ四角が軽いか・なぜ2つのパイプラインに分けたかは`gpu-resources.ts`の
 *  WGSL側コメント(fs_main_round/fs_main_square)を参照。 */
export type PointShape = "round" | "square";

/**
 * モバイル判定に使う生の入力。ブラウザAPIを直接ここに書かず、呼び出し側
 * (`readDeviceProfileInput`)が値を取り出してから渡す設計にしてある。
 * こうすることで、この後の判定ロジック(`isMobileDevice`/
 * `defaultRenderSettings`)はブラウザ環境が無くてもテストできる。
 */
export interface DeviceProfileInput {
  /** `navigator.deviceMemory`の値(GiB)。ブラウザが対応していない場合はundefined。 */
  deviceMemoryGiB: number | undefined;
  /** タッチ主体の入力デバイスかどうか(`matchMedia("(pointer: coarse)").matches`)。 */
  pointerCoarse: boolean;
}

/** モバイル判定の閾値。所有者の実機(4GB)を基準にした判断で、実測して
 *  決めた値ではない。「タッチ主体でなくても、4GB以下は低メモリ端末として
 *  軽い側の既定値にしておく」という保守的な側に倒す判断。 */
export const MOBILE_LOW_MEMORY_THRESHOLD_GIB = 4;

/**
 * モバイル(=軽い側の既定値を使うべき端末)かどうかを判定する。
 *
 * - タッチ主体の入力デバイスなら常にモバイル扱いにする(操作方法からの判断)
 * - `deviceMemory`が取得でき、かつ`MOBILE_LOW_MEMORY_THRESHOLD_GIB`以下なら
 *   （タッチかどうかに関わらず）モバイル扱いにする(メモリからの判断。
 *   低メモリのデスクトップ環境を誤って重い既定値のままにしないための保険)
 * - `deviceMemory`が取れない(undefined)場合は、メモリ側の判断は「分からない」
 *   として無視する(モバイルとは判定しない)。取れない=モバイルと決めつけると、
 *   単にdeviceMemory未対応のブラウザ(例: Firefox)を使うデスクトップ利用者が
 *   不必要に軽い既定値に落とされてしまうため
 */
export function isMobileDevice(input: DeviceProfileInput): boolean {
  if (input.pointerCoarse) return true;
  if (input.deviceMemoryGiB !== undefined && input.deviceMemoryGiB <= MOBILE_LOW_MEMORY_THRESHOLD_GIB) {
    return true;
  }
  return false;
}

/** デスクトップのレンダースケール既定値。**変更前と同じ1.0。** */
export const DESKTOP_RENDER_SCALE = 1.0;
/** モバイルのレンダースケール既定値。**未検証の初期値。** タスクシートの
 *  指定通り0.5。 */
export const MOBILE_RENDER_SCALE = 0.5;

/**
 * デスクトップの点キャッシュメモリ予算(バイト)。**既存の値(1GiB)をそのまま
 * 流用する。** ADR-0010で「開発機(RTX 4070)基準の値」として導入された定数で、
 * デスクトップの挙動を変えないことがこのタスクの必須要件のため、値も
 * 計算方法もここでは一切変えない。
 */
export const DESKTOP_POINT_CACHE_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

/**
 * モバイルで`deviceMemory`から点キャッシュのメモリ予算を逆算する際の割合。
 *
 * **未検証の初期値。** 端末の総メモリのうち、点群キャッシュ(GPUバッファ)に
 * 割ける分をごく保守的に見積もった値。4GB端末のRAMは点群キャッシュだけでなく
 * OS・WebView・UIの合成・その他のGPUリソースとも共有される(SoCの統合メモリ)。
 * 1/64を選んだ理由:
 * - 所有者の実機(4GiB, `MOBILE_FALLBACK_DEVICE_MEMORY_GIB`参照)で計算すると
 *   64MiB(=4GiB/64)になり、そこから逆算した点予算上限は約168万点
 *   (`pointBudgetMaxFromMemoryBudget`参照)。デスクトップの上限(約2,684万点)の
 *   1/16程度で、所有者が「形状の把握もできない」と報告した20,000点よりは
 *   十分大きく、かつ現在の不具合(起動直後に上限=2,684万点をいきなり要求して
 *   落ちる)を避けられる規模として選んだ
 * - 実機での検証(所有者に依頼する。TaskSheets/M3-release-and-update.md M3-8
 *   「実施記録」の確認手順参照)を経て調整することを前提にした、あくまで
 *   最初の一歩の値
 */
export const MOBILE_POINT_CACHE_MEMORY_FRACTION = 1 / 64;

/**
 * `deviceMemory`が取得できないモバイル端末（`isMobileDevice`がタッチ主体の
 * 判定だけでtrueになったケース）で使う、フォールバックのデバイスメモリ想定値
 * (GiB)。**未検証の初期値。** 所有者の実機(OPPO Pad Air, RAM 4GB)に合わせた、
 * 「分からなければ所有者の実機と同程度を仮定する」という保守的な判断。
 */
export const MOBILE_FALLBACK_DEVICE_MEMORY_GIB = 4;

/** 各最適化手段の既定値一式。`PointCloudRenderer`とUI(state層)の両方が、
 *  同じ入力に対して`defaultRenderSettings()`を呼ぶことで独立に同じ結果を
 *  得る(ハンドシェイク不要。詳細はpoint-cloud-renderer.ts/useCopcViewer.tsの
 *  呼び出し箇所のコメント参照)。 */
export interface RenderDefaults {
  isMobile: boolean;
  renderScale: number;
  pointShape: PointShape;
  edlEnabled: boolean;
  glassEnabled: boolean;
  /** 自動調整(point-budget.ts)が動ける点予算の上限。 */
  pointBudgetMax: number;
  /** 起動直後の点予算。ADR-0010追記2の設計（楽観的に上限から始め、外したら
   *  即座に大きく下げる）をモバイルでも踏襲し、`pointBudgetMax`と同じ値にする。
   *  モバイルでは`pointBudgetMax`自体が`deviceMemory`から保守的に算出される
   *  ため、デスクトップと違って「上限から始める」ことが危険にならない
   *  (`MOBILE_POINT_CACHE_MEMORY_FRACTION`のコメント参照)。 */
  pointBudgetStart: number;
}

/**
 * モバイル判定と、各最適化手段の既定値をまとめて返す。
 *
 * **デスクトップ側はすべて「変更前と同じ値」。** レンダースケール1.0・
 * 点の形は丸・EDLオン・ガラスあり・点予算上限は既存のADR-0010の1GiB計算式
 * そのまま。この関数を通しても、モバイル判定がfalseである限り既存の
 * デスクトップの挙動は一切変わらない(device-profile.test.tsで
 * 具体的な数値を固定して確認している)。
 */
export function defaultRenderSettings(input: DeviceProfileInput): RenderDefaults {
  const isMobile = isMobileDevice(input);

  if (!isMobile) {
    const pointBudgetMax = pointBudgetMaxFromMemoryBudget(
      DESKTOP_POINT_CACHE_MEMORY_BUDGET_BYTES,
      NODE_POINT_STRIDE,
      CACHE_BUDGET_MULTIPLIER,
    );
    return {
      isMobile: false,
      renderScale: DESKTOP_RENDER_SCALE,
      pointShape: "round",
      edlEnabled: true,
      glassEnabled: true,
      pointBudgetMax,
      pointBudgetStart: pointBudgetMax,
    };
  }

  const deviceMemoryGiB = input.deviceMemoryGiB ?? MOBILE_FALLBACK_DEVICE_MEMORY_GIB;
  const memoryBudgetBytes = deviceMemoryGiB * 1024 * 1024 * 1024 * MOBILE_POINT_CACHE_MEMORY_FRACTION;
  const pointBudgetMax = pointBudgetMaxFromMemoryBudget(memoryBudgetBytes, NODE_POINT_STRIDE, CACHE_BUDGET_MULTIPLIER);
  return {
    isMobile: true,
    renderScale: MOBILE_RENDER_SCALE,
    pointShape: "square",
    edlEnabled: false,
    glassEnabled: false,
    pointBudgetMax,
    pointBudgetStart: pointBudgetMax,
  };
}

/**
 * ブラウザから`DeviceProfileInput`を読み取る。ブラウザAPI(`navigator`/
 * `matchMedia`)に直接触れる、このファイルで唯一の関数。DOM環境が無い
 * vitestでは呼べない(このプロジェクトにjsdom等は導入されていない。
 * TaskSheets/M3-release-and-update.md M3-6の実施記録参照)ため、ここだけは
 * 単体テストの対象外にし、判定・既定値ロジック本体(`isMobileDevice`/
 * `defaultRenderSettings`)を薄いこの関数から分離してテスト可能にしてある。
 */
export function readDeviceProfileInput(): DeviceProfileInput {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const pointerCoarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return { deviceMemoryGiB: nav.deviceMemory, pointerCoarse };
}
