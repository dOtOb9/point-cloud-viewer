import { X } from "lucide-react";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} className={`${DIALOG_TERTIARY_BUTTON_CLASS} flex items-center gap-1`}>
      <X size={16} aria-hidden="true" />
      閉じる
    </button>
  );
}
