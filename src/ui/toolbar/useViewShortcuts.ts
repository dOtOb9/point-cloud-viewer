import { useEffect } from "react";
import { runViewAction, viewActionForKey, type ViewContext } from "../../app/view";

/**
 * TP-1 (UX-4): the view keys (F, 1 to 7; the table is `VIEW_SHORTCUTS` in src/app/view.ts). Which key does what, and
 * when a key is ignored (typing in a field, Ctrl / Meta / Alt), is decided by `viewActionForKey`; this hook only
 * listens to the window and calls `runViewAction`. `enabled` is false while there is no point cloud (the keys do nothing then).
 * Mounted once by AppShell; `ctx` is the app's one view context, so the listener is attached once.
 */
export function useViewShortcuts(ctx: ViewContext, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = viewActionForKey(event);
      if (!action) return;
      event.preventDefault();
      runViewAction(ctx, action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctx, enabled]);
}
