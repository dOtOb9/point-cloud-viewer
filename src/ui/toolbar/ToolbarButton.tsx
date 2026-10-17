import type { LucideIcon } from "lucide-react";
import { TOOLBAR_BUTTON_CLASS, TOOLBAR_BUTTON_PRIMARY_CLASS } from "./toolbar-styles";

interface Props {
  icon: LucideIcon;
  /** Short text label (shown under the icon). */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Tooltip shown on hover (defaults to the label). */
  title?: string;
  primary?: boolean;
  /** Selected / ON button: draws a 3px primary (green) line along the bottom edge (ADR-0017). Used by the running tool buttons. */
  active?: boolean;
}

/**
 * ADR-0017: ツールバーのボタン1つ。アイコンが上、文字ラベルが下(所有者の要件)。
 * アイコンは`lucide-react`(ADR-0017に選定理由とライセンスを記録)。アイコンは
 * 飾りなので`aria-hidden`にし、ボタンの名前は下の文字ラベルが担う。
 */
export function ToolbarButton({ icon: Icon, label, onClick, disabled = false, title, primary = false, active = false }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      title={title ?? label}
      className={`${TOOLBAR_BUTTON_CLASS} ${primary ? TOOLBAR_BUTTON_PRIMARY_CLASS : ""}`}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
      {/* 選択中の下線。scaleXで中央から伸び縮みする(transformだけ。AN-3)。 */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-2 bottom-0 h-[3px] origin-center rounded bg-primary transition-transform duration-(--motion-panel) ease-(--motion-ease-out) ${active ? "scale-x-100" : "scale-x-0"}`}
      />
    </button>
  );
}
