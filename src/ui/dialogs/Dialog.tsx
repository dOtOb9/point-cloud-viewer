import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { defaultRenderSettings, readDeviceProfileInput } from "../../renderer/device-profile";
import { glassSurfaceClass } from "../common/glass";
import { useTransitionMount } from "../common/useTransitionMount";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** フッターの中央ぞろえのボタン列。省略するとフッターを出さない。 */
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

/** 閉じるアニメーションの長さ(ms)。index.cssの`--motion-dialog-out`と同じ値にしておく(未検証の初期値)。 */
const EXIT_MS = 120;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * ADR-0017 (UIシェル再構築): 設定・変換の進捗・エラー・URLが共通で使う、中央に出る
 * ダイアログ。上に中央ぞろえのタイトル、真ん中に本文、下に中央ぞろえのボタン列、という構成。
 * 右上の✕ボタンは無い(所有者の判断で廃止。閉じる手段は下の3つ)。
 *
 * - **Glass (2026-10-15; reverses the earlier "opaque" rule, see the ADR-0017 addendum).** The panel uses the
 *   same `glassSurfaceClass` as the toolbar. When the device profile has `glassEnabled=false` it falls back to an opaque tint.
 * - **閉じ方は3つ:** フッターのボタン(呼び出し側が`footer`に「閉じる」か「キャンセル」を必ず置く)、
 *   外側の暗幕クリック、Esc。
 * - **暗幕クリックで閉じる(所有者の判断。以前は誤操作を避けて閉じなかった)。**
 *   ただし誤爆を避けるため、mousedownとclickの**両方**が暗幕自身の上で起きたときだけ閉じる。
 *   パネル内で押してパネル外で離す(テキスト選択やスライダーのドラッグがはみ出す)場合は、
 *   mousedownがパネル内なので閉じない。重なったとき(設定の上にエラー)は、最前面の
 *   ダイアログの暗幕が画面全体を覆うので、クリックは最前面の1枚にしか届かない。
 * - **Escはダイアログ内にフォーカスがあるときだけ効く**(`onKeyDown`をパネルに付けている)ので、
 *   重なっても最前面の1枚だけが閉じる。
 * - **フォーカス:** 開いたら本文の最初の操作要素(無ければパネル自身)へ移し、
 *   閉じたら開く前にフォーカスがあった要素へ戻す。Tabはダイアログ内で循環させる。
 * - **暗幕はぼかし(Blur)に統一(所有者の決定 2026-10-15、ADR-0017の追記)。** 全ダイアログで後ろをぼかし、
 *   暗くしすぎない(`bg-black/10`+`backdrop-blur-sm`)。以前は着色・見た目だけ透明、他は暗い、と混在していた。
 *   モバイル(`device-profile.ts`の`glassEnabled=false`)ではぼかしがGPUに重いので、ぼかさず薄い半透明(`bg-black/30`)に落とす。
 *   暗幕の要素は残るので、外側クリックで閉じる動きとEscは変わらない(開いている間、点群への操作は暗幕が受け止める)。
 * - **狭幅(<768px):** 外枠の余白を小さくして、ほぼ全幅の中央ダイアログにする。
 */
export function Dialog({ open, title, onClose, children, footer, widthClass = "max-w-lg", layer = "normal", tone = "normal", accent = "primary" }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 暗幕クリックで閉じる判定用: mousedownが暗幕自身の上で始まったか(refなので再描画しない)。
  const pressStartedOnBackdrop = useRef(false);
  // ぼかせる端末か(端末プロファイル。起動中は変わらないので最初の1回だけ読む)。
  const [blurEnabled] = useState(() => defaultRenderSettings(readDeviceProfileInput()).glassEnabled);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      // 本文の最初の操作要素へ。無ければパネル自身。
      const body = panel.querySelector<HTMLElement>("[data-dialog-body]");
      const first = body?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      (first ?? panel).focus();
    }
    return () => {
      previouslyFocused?.focus();
    };
  }, [open]);

  // AN-3: 閉じるときもDOMに少し残して、閉じるアニメーション(逆再生。開くより速い)を見せる。
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

  // 動かすのはopacityとtransformだけ。出る: 暗幕はフェード、パネルは0.96倍→1倍+フェード(ease-out)。
  // 閉じる: 逆向きで速く(ease-in)。時間・イージングはindex.cssの`--motion-*`(1箇所)。
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
      className={`fixed inset-0 ${layer === "top" ? "z-50" : "z-40"} flex items-center justify-center ${blurEnabled ? "bg-black/10 backdrop-blur-sm" : "bg-black/30"} p-3 md:p-4 ${shown ? "" : "pointer-events-none"}`}
    >
      <div
        style={panelStyle}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[85vh] w-full ${widthClass} flex-col overflow-hidden rounded-2xl ${glassSurfaceClass(blurEnabled)} border-t-[3px] ${ACCENT_BORDER[accent]} shadow-2xl outline-none`}
      >
        <div className={`px-4 py-3 text-center ${headerTone}`}>
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
        </div>
        <div data-dialog-body className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-black/10 px-4 py-3 dark:border-white/10">{footer}</div>
        )}
      </div>
    </div>
  );
}
