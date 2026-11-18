import type { LucideIcon } from "lucide-react";
import { TOOLBAR_BUTTON_CLASS, TOOLBAR_BUTTON_PRIMARY_CLASS } from "./toolbar-styles";

interface Props {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  active?: boolean;
  testId?: string;
}

export function ToolbarButton({ icon: Icon, label, onClick, disabled = false, title, primary = false, active = false, testId }: Props) {
  return (
    <button
      data-testid={testId}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      title={title ?? label}
      className={`${TOOLBAR_BUTTON_CLASS} ${primary ? TOOLBAR_BUTTON_PRIMARY_CLASS : ""}`}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-2 bottom-0 h-[3px] origin-center rounded bg-primary transition-transform duration-(--motion-panel) ease-(--motion-ease-out) ${active ? "scale-x-100" : "scale-x-0"}`}
      />
    </button>
  );
}
