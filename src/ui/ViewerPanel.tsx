import type { RefObject } from "react";

/**
 * M2-3 (ADR-0005): 3Dビュー本体。「全面ビューア」を実現するため、canvasだけを
 * 絶対配置でウィンドウ全面に敷く。
 *
 * 以前はここにHUD(ファイルパス入力・点予算・背景/グリッド設定・統計表示)も
 * 直書きしていたが、UIシェル導入に伴い src/ui/shell/LayerPanel.tsx と
 * src/ui/shell/InfoPanel.tsx に移した(機能は削っていない。src/ui/shell/AppShell.tsx
 * 参照)。useCopcViewer()もAppShell側に引き上げたので、このコンポーネントは
 * canvasRefを受け取って描画するだけのdumbな部品になっている
 * (規約3は変わらず: rendererを直接触らずcanvasだけを見る)。
 */
export function ViewerPanel({ canvasRef }: { canvasRef: RefObject<HTMLCanvasElement | null> }) {
  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full bg-black" />;
}
