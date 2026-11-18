export const GLASS_SURFACE =
  "backdrop-blur-md bg-white/65 text-slate-900 border border-black/10 " +
  "dark:bg-slate-950/70 dark:text-slate-100 dark:border-white/10";

export const OPAQUE_GLASS_SURFACE =
  "bg-white text-slate-900 border border-black/10 " + "dark:bg-slate-950 dark:text-slate-100 dark:border-white/10";

export function glassSurfaceClass(glassEnabled: boolean): string {
  return glassEnabled ? GLASS_SURFACE : OPAQUE_GLASS_SURFACE;
}
