import type { RefObject } from "react";

export function ViewerPanel({ canvasRef }: { canvasRef: RefObject<HTMLCanvasElement | null> }) {
  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full bg-black" />;
}
