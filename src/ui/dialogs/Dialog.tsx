import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { defaultRenderSettings, readDeviceProfileInput } from "../../renderer/device-profile";
import { glassSurfaceClass } from "../common/glass";
import { useTransitionMount } from "../common/useTransitionMount";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string;
  fitContent?: boolean;
  placement?: "center" | "side";
  layer?: "normal" | "top";
  tone?: "normal" | "error";
  accent?: "primary" | "secondary" | "error";
}

const ACCENT_BORDER = { primary: "border-t-primary", secondary: "border-t-secondary", error: "border-t-error" } as const;

const EXIT_MS = 120;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, title, onClose, children, footer, widthClass = "max-w-lg", fitContent = false, layer = "normal", tone = "normal", accent = "primary", placement = "center" }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const pressStartedOnBackdrop = useRef(false);
  const [blurEnabled] = useState(() => defaultRenderSettings(readDeviceProfileInput()).glassEnabled);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      const body = panel.querySelector<HTMLElement>("[data-dialog-body]");
      const first = body?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      (first ?? panel).focus();
    }
    return () => {
      previouslyFocused?.focus();
    };
  }, [open]);

  const { mounted, shown } = useTransitionMount(open, EXIT_MS);
  if (!mounted) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const headerTone = tone === "error" ? "bg-error text-on-error" : "border-b border-black/10 dark:border-white/10";

  const motionStyle: CSSProperties = {
    transitionProperty: "opacity, transform",
    transitionDuration: shown ? "var(--motion-dialog-in)" : "var(--motion-dialog-out)",
    transitionTimingFunction: shown ? "var(--motion-ease-out)" : "var(--motion-ease-in)",
  };
  const backdropStyle: CSSProperties = { ...motionStyle, opacity: shown ? 1 : 0 };
  const panelStyle: CSSProperties = { ...motionStyle, opacity: shown ? 1 : 0, transform: shown ? "scale(1)" : "scale(0.96)" };

  const onBackdropMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    pressStartedOnBackdrop.current = e.target === e.currentTarget;
  };
  const onBackdropClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const startedOnBackdrop = pressStartedOnBackdrop.current;
    pressStartedOnBackdrop.current = false;
    if (startedOnBackdrop && e.target === e.currentTarget) onClose();
  };

  return (
    <div
      style={backdropStyle}
      onMouseDown={onBackdropMouseDown}
      onClick={onBackdropClick}
      className={`fixed inset-0 ${layer === "top" ? "z-50" : "z-40"} flex ${placement === "side" ? "items-end justify-center pb-14 md:items-start md:justify-end md:pt-28" : `items-center justify-center ${blurEnabled ? "bg-black/10 backdrop-blur-sm" : "bg-black/30"}`} p-3 md:p-4 ${shown ? "" : "pointer-events-none"}`}
    >
      <div
        style={panelStyle}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex ${placement === "side" ? "max-h-[45vh] md:max-h-[85vh]" : "max-h-[85vh]"} w-full ${fitContent ? "md:w-fit" : ""} ${widthClass} flex-col overflow-hidden rounded-2xl ${glassSurfaceClass(blurEnabled)} border-t-[3px] ${ACCENT_BORDER[accent]} shadow-2xl outline-none`}
      >
        <div className={`px-4 ${placement === "side" ? "py-2 md:py-3" : "py-3"} text-center ${headerTone}`}>
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
        </div>
        <div data-dialog-body className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${placement === "side" ? "gap-2 p-3 md:gap-4 md:p-4" : "gap-4 p-4"}`}>
          {children}
        </div>
        {footer && (
          <div className={`flex flex-wrap items-center justify-center gap-2 border-t border-black/10 px-4 ${placement === "side" ? "py-2 md:py-3" : "py-3"} dark:border-white/10`}>{footer}</div>
        )}
      </div>
    </div>
  );
}
