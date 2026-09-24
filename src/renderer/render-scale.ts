// M3-8: キャンバスの描画バッファ(internal resolution)のサイズ計算。
//
// レンダースケールは「内部の描画解像度 = 表示サイズ(CSS px) × 倍率」という式で
// 決める。キャンバスの`width`/`height`属性(描画バッファ)だけをこの式で小さくし、
// CSS側の表示サイズ(`width: 100%`等)はそのまま保つ。ブラウザがバッファを
// 表示サイズへ自動で引き伸ばすので、「小さい解像度で描いて、大きく引き伸ばして
// 表示する」が実現できる(`src/ui/ViewerPanel.tsx`のcanvasが
// `className="... h-full w-full"`でCSSサイズを完全に制御しているため、
// `canvas.width`/`height`を変えてもレイアウト上の表示サイズは変わらないことを
// 確認済み)。
//
// ## devicePixelRatioをこの式に含めない理由（2026-09-24追記、コーディネーターの
// 指摘を受けて修正）
//
// 当初は「表示サイズ × devicePixelRatio × 倍率」にしていたが、これは2つの
// 問題を引き起こしていた。
//
// 1. **モバイルの既定値(0.5倍)が所有者の実機で実質効かない。** OPPO Pad Airの
//    devicePixelRatioは2前後の見込み(未確認)で、2 × 0.5 = 1.0倍になり、
//    devicePixelRatioを掛けていなかった変更前(v0.1.0)と同じ内部解像度に
//    なってしまう。所有者の実機の症状は`VK_ERROR_DEVICE_LOST`(GPUのハング)
//    で、「1フレームのGPUの仕事を減らす」ことが本命の対策なのに、その本命の
//    手段が既定値では何も軽くしていなかった
// 2. **デスクトップの見た目・負荷が変わってしまう。** 変更前はdevicePixelRatio
//    を一切考慮していなかった(`useCopcViewer.ts`が`canvas.clientWidth`を
//    そのまま使っていた)。表示スケール125%/150%等の環境
//    (devicePixelRatio>1)では、レンダースケール1.0(デスクトップの既定)でも
//    以前より内部解像度が上がり、GPU負荷が増え、点も相対的に小さく見える。
//    これは「デスクトップの見た目と挙動を変えない」というタスクシートの
//    必須要件に反する
//
// 対処: **devicePixelRatioをこの計算から外し、「表示サイズ × 倍率」だけに
// する。** こうすると:
// - デスクトップの既定(倍率1.0) → 変更前の`canvas.clientWidth`そのままと
//   完全に一致する(devicePixelRatioが1でない環境でも、以前と同じくCSS
//   ピクセル解像度のまま。副作用が無くなる)
// - モバイルの既定(倍率0.5) → devicePixelRatioの値に関わらず、v0.1.0に
//   比べて画素数が確実に1/4になる(縦横それぞれ1/2)。所有者の実機で
//   devicePixelRatioがいくつであっても、必ず軽くなる
//
// **高DPR画面での高精細表示(devicePixelRatioを使った鮮明な描画)は、今回は
// 入れない。** 「1フレームのGPU負荷を減らす」という今回の目的とは逆方向
// (解像度を上げる方向)の要求であり、混ぜると「レンダースケールが常に効く」
// という単純さが崩れる。欲しくなったら、`renderScale`とは別の設定
// (例えば「高精細表示」のような独立したON/OFF)として後で足す方が、
// 「レンダースケールを下げれば必ず軽くなる」という今回の主目的を守れる。
//
// WebGPU・DOMのどちらにも依存しない純粋関数として切り出し、端数の丸め・
// 最小1pxの扱いをvitestで検証できるようにする(render-scale.test.ts)。

export interface CanvasBackingSize {
  width: number;
  height: number;
}

/**
 * 表示サイズ(CSS px)・レンダースケールから、キャンバスの描画バッファの
 * サイズ(整数, CSSピクセル基準)を計算する。**devicePixelRatioはここでは
 * 使わない**(ファイル冒頭のコメント参照。倍率1.0のとき、変更前の挙動
 * ＝表示サイズそのままと完全に一致させるため)。
 *
 * - 丸めは`Math.round`。切り捨てだと縮小方向に一貫して寄り、切り上げだと
 *   逆に寄る。四捨五入がどちらにも偏らない素直な選択。
 * - 結果は必ず1px以上にする（`renderScale`をごく小さくした場合や、
 *   パネルが折りたたまれて表示サイズが0になった場合でも、WebGPUの
 *   `createTexture`にサイズ0を渡すと失敗するため）。
 */
export function computeCanvasBackingSize(
  displayWidthCss: number,
  displayHeightCss: number,
  renderScale: number,
): CanvasBackingSize {
  const width = Math.max(1, Math.round(displayWidthCss * renderScale));
  const height = Math.max(1, Math.round(displayHeightCss * renderScale));
  return { width, height };
}
