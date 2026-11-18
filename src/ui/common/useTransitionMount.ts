import { useEffect, useState } from "react";
import { shouldSkipExitWait } from "../../state/motion-setting";

export function useTransitionMount(open: boolean, exitMs: number): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(open);

  if (open && !mounted) setMounted(true);
  if (!open && entered) setEntered(false);

  useEffect(() => {
    if (!open || entered) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, entered]);

  useEffect(() => {
    if (open || !mounted) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const skip = shouldSkipExitWait(typeof document === "undefined" ? undefined : document.documentElement, reduce);
    const timer = setTimeout(() => setMounted(false), skip ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted, shown: open && entered };
}
