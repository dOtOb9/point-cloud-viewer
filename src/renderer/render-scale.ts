export interface CanvasBackingSize {
  width: number;
  height: number;
}

export function computeCanvasBackingSize(
  displayWidthCss: number,
  displayHeightCss: number,
  renderScale: number,
): CanvasBackingSize {
  const width = Math.max(1, Math.round(displayWidthCss * renderScale));
  const height = Math.max(1, Math.round(displayHeightCss * renderScale));
  return { width, height };
}
