import { useEffect } from "react";
import { runViewAction, viewActionForKey, type ViewContext } from "../../app/view";

/**
 * TP-1 (UX-4): the view keys (F, 1 to 7; the table is `VIEW_SHORTCUTS` in src/app/view.ts). Which key does what, and
 * when a key is ignored (typing in a field, Ctrl / Meta / Alt), is decided by `viewActionForKey`; this hook only
 * listens to the window and calls `runViewAction`. `enabled` (a point cloud is open) goes into the context, where the view functions check it, so the keys and the button agree.
 * Mounted once by AppShell; `ctx` is the app's one view context, so the listener is attached once.
 */
export function useViewShortcuts(ctx: ViewContext, enabled: boolean): void {
  useEffect(() => {
    ctx.pointCloud.set(enabled);
  }, [ctx, enabled]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = viewActionForKey(event);
      if (!action) return;
      event.preventDefault();
      runViewAction(ctx, action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctx]);
}
