import { useEffect } from "react";
import { runViewAction, syncViewEnabled, viewActionForKey, type ViewContext } from "../../app/view";
import type { ViewerLayer } from "../../state/layers";

/**
 * TP-1 (UX-4): the view keys (F, 1 to 7; the table is `VIEW_SHORTCUTS` in src/app/view.ts). Which key does what, and
 * when a key is ignored (typing in a field, Ctrl / Meta / Alt), is decided by `viewActionForKey`; this hook only
 * listens to the window and calls `runViewAction`. It also tells the context which layers exist (`syncViewEnabled`
 * decides whether a point cloud is open), where the view functions check it, so the keys and the view button agree.
 * The keys are taken (preventDefault) only while a point cloud is open. Mounted once by AppShell; `ctx` is the app's
 * one view context, so the listener is attached once.
 */
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
