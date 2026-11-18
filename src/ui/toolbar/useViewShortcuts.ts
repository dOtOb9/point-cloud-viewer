import { useEffect } from "react";
import { runViewAction, syncViewEnabled, viewActionForKey, type ViewContext } from "../../app/view";
import type { ViewerLayer } from "../../state/layers";

export function useViewShortcuts(ctx: ViewContext, layers: readonly ViewerLayer[]): void {
  useEffect(() => {
    syncViewEnabled(ctx, layers);
  }, [ctx, layers]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!ctx.pointCloud.get()) return;
      const action = viewActionForKey(event);
      if (!action) return;
      event.preventDefault();
      runViewAction(ctx, action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctx]);
}
