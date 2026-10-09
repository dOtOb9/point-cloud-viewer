import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** フッターの右寄せボタン列。省略するとフッターを出さない。 */
  footer?: ReactNode;
  /** パネルの最大幅のTailwindクラス。既定は`max-w-lg`(設定画面は広めに指定する)。 */
  widthClass?: string;
  /** "top"は他のダイアログ(設定など)より前面に出す(エラー用)。 */
  layer?: "normal" | "top";
  /** "error"はタイトルバーを警告色にする(エラー用)。 */
  tone?: "normal" | "error";
  /** 上端の3pxのアクセント線の役割色(設定・URL=primary、変換=secondary、エラー=error。ADR-0017)。 */
  accent?: "primary" | "secondary" | "error";
}

/** 役割色トークン(index.css)の名前で上端線を引く。クラス名は文字列のまま書く(Tailwindが検出できるように)。 */
const ACCENT_BORDER = { primary: "border-t-primary", secondary: "border-t-secondary", error: "border-t-error" } as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * ADR-0017 (UIシェル再構築): 設定・変換の進捗・エラーが共通で使う、中央に出る
 * ダイアログ。上にタイトルバー(閉じるボタン付き)、真ん中に本文、下に右寄せの
 * ボタン列、という構成。
 *
 * - **不透明。** ADR-0005の決定どおり(密な入力・長文は安定したコントラストが要る)。
 *   ガラス(`glass.ts`)は使わない。
 * - **Esc・✕で閉じる。** Escはダイアログ内にフォーカスがあるときだけ効く
 *   (`onKeyDown`をパネルに付けている)ので、設定の上にエラーが重なっても
 *   最前面の1枚だけが閉じる。
 * - **フォーカス:** 開いたら本文の最初の操作要素(無ければパネル自身)へ移し、
 *   閉じたら開く前にフォーカスがあった要素へ戻す。Tabはダイアログ内で循環させる。
 * - **狭幅(<768px):** 外枠の余白を小さくして、ほぼ全幅の中央ダイアログにする。
 *
 * 外側の暗幕クリックでは閉じない(変換中・エラーの本文を読んでいる最中に
 * 誤って閉じるのを避けるため)。
 */
export function Dialog({ open, title, onClose, children, footer, widthClass = "max-w-lg", layer = "normal", tone = "normal", accent = "primary" }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      // タイトルバーの✕より先に本文の操作要素へ。無ければパネル自身。
      const body = panel.querySelector<HTMLElement>("[data-dialog-body]");
      const first = body?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      (first ?? panel).focus();
    }
    return () => {
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

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

  const headerTone = tone === "error" ? "bg-error text-on-error" : "border-b border-slate-200 dark:border-slate-700";
  const closeTone = tone === "error" ? "hover:bg-black/20" : "hover:bg-black/5 dark:hover:bg-white/10";

  return (
    <div className={`fixed inset-0 ${layer === "top" ? "z-50" : "z-40"} flex items-center justify-center bg-black/50 p-3 md:p-4`}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[85vh] w-full ${widthClass} flex-col overflow-hidden rounded-2xl border-t-[3px] ${ACCENT_BORDER[accent]} bg-white text-slate-900 shadow-2xl outline-none dark:bg-slate-900 dark:text-slate-100`}
      >
        <div className={`flex items-center justify-between gap-2 px-4 py-2 ${headerTone}`}>
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded text-lg ${closeTone}`}
          >
            ✕
          </button>
        </div>
        <div data-dialog-body className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700">{footer}</div>
        )}
      </div>
    </div>
  );
}
