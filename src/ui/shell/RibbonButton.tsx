import type { LucideIcon } from "lucide-react";
import { RIBBON_BUTTON_CLASS, RIBBON_BUTTON_PRIMARY_CLASS } from "./ribbon-styles";

interface Props {
  icon: LucideIcon;
  /** 短い文字ラベル(アイコンの下に出す)。 */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** ホバーで出す説明。未実装ツールは「未実装（予定）」を渡す。 */
  title?: string;
  primary?: boolean;
  /** 選択中・ON状態のボタン。下端に3pxのprimary(緑)の線を引く(ADR-0017)。現状、リボンにトグル/タブ型のボタンは無く未使用(将来のため)。 */
  active?: boolean;
}

/**
 * ADR-0017: リボンのボタン1つ。アイコンが上、文字ラベルが下(所有者の要件)。
 * アイコンは`lucide-react`(ADR-0017に選定理由とライセンスを記録)。アイコンは
 * 飾りなので`aria-hidden`にし、ボタンの名前は下の文字ラベルが担う。
 */
export function RibbonButton({ icon: Icon, label, onClick, disabled = false, title, primary = false, active = false }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      title={title ?? label}
      className={`${RIBBON_BUTTON_CLASS} ${primary ? RIBBON_BUTTON_PRIMARY_CLASS : ""} ${active ? "border-b-[3px] border-b-primary" : ""}`}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
