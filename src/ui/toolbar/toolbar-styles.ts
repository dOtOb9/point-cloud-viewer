// ADR-0017: class strings shared by the toolbar buttons.
//
// Same idea as `glass.ts`: keep the look in one place so the buttons (and the layer-list
// action buttons and the settings modal that reuse it) do not drift apart.

/**
 * A toolbar button: icon on top, short text label below (owner requirement).
 * The disabled style makes it obvious that the button cannot be pressed.
 * min-h-14 (56px) and min-w-14 keep the touch target above 44px.
 */
export const TOOLBAR_BUTTON_CLASS =
  "relative flex min-h-14 min-w-14 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-[11px] leading-tight whitespace-nowrap " +
  // AN-3: lifts 1px on hover and scales to 0.97 on press (transform only; timing and easing are the --motion-* values in index.css).
  "transition-transform duration-(--motion-press) ease-(--motion-ease-out) hover:-translate-y-px active:translate-y-0 active:scale-[0.97] " +
  "hover:bg-black/5 dark:hover:bg-white/10 " +
  "disabled:cursor-not-allowed disabled:bg-tertiary/20 disabled:opacity-50 disabled:pointer-events-none";

/** Filled emphasis button (the main action, "開く"). */
export const TOOLBAR_BUTTON_PRIMARY_CLASS =
  "bg-primary text-on-primary hover:!bg-primary hover:opacity-90";
