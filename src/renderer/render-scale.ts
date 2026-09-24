// M3-8: キャンバスの描画バッファ(internal resolution)のサイズ計算。
//
// レンダースケールは「内部の描画解像度 = 表示サイズ(CSS px) × devicePixelRatio ×
// 倍率」という式で決める(タスクシートの指定通り)。キャンバスの`width`/`height`
// 属性(描画バッファ)だけをこの式で小さくし、CSS側の表示サイズ(`width: 100%`等)は
// そのまま保つ。ブラウザがバッファを表示サイズへ自動で引き伸ばすので、
// 「小さい解像度で描いて、大きく引き伸ばして表示する」が実現できる
// (`src/ui/ViewerPanel.tsx`のcanvasが`className="... h-full w-full"`で
// CSSサイズを完全に制御しているため、`canvas.width`/`height`を変えても
// レイアウト上の表示サイズは変わらないことを確認済み)。
//
// WebGPU・DOMのどちらにも依存しない純粋関数として切り出し、端数の丸め・
// 最小1pxの扱いをvitestで検証できるようにする(render-scale.test.ts)。

export interface CanvasBackingSize {
  width: number;
  height: number;
}

/**
 * 表示サイズ(CSS px)・devicePixelRatio・レンダースケールから、キャンバスの
 * 描画バッファのサイズ(整数, デバイスピクセル)を計算する。
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
  devicePixelRatio: number,
  renderScale: number,
): CanvasBackingSize {
  const width = Math.max(1, Math.round(displayWidthCss * devicePixelRatio * renderScale));
  const height = Math.max(1, Math.round(displayHeightCss * devicePixelRatio * renderScale));
  return { width, height };
}
