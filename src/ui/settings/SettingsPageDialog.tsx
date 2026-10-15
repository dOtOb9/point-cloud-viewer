import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";

// L1-E (ADR-0017 追記2): 設定の項目ごとの専用ダイアログ。
// フッターは「戻る」(設定の一覧へ)だけ(灰色=tertiary)。閉じるのは外側クリック・Esc(L2-A: 閉じるボタンは置かない)。
// 値はその場で viewer などの setter に流す(適用ボタンは無い)。ここには状態を持たない。

export interface PageProps {
  open: boolean;
  /** 設定の一覧へ戻る。 */
  onBack: () => void;
  /** 設定を閉じる。 */
  onClose: () => void;
}

/** 専用ダイアログの枠。フッターの「戻る」「閉じる」を共通にする。 */
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
