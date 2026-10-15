import { X } from "lucide-react";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

/** フッターの「閉じる」ボタン(アイコン+ラベル。ADR-0017の約束)。 */
export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} className={`${DIALOG_TERTIARY_BUTTON_CLASS} flex items-center gap-1`}>
      <X size={16} aria-hidden="true" />
      閉じる
    </button>
  );
}
