import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";

export interface PageProps {
  open: boolean;
  onBack: () => void;
  onClose: () => void;
}

export function SettingsPageDialog({ open, onBack, onClose, title, widthClass, children }: PageProps & { title: string; widthClass?: string; children: ReactNode }) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      accent="primary"
      widthClass={widthClass}
      footer={
        <>
          <button type="button" onClick={onBack} className={`${DIALOG_TERTIARY_BUTTON_CLASS} flex items-center gap-1`}>
            <ArrowLeft size={16} aria-hidden="true" />
            戻る
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">{children}</div>
    </Dialog>
  );
}
