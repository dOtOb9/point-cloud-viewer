import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { OPAQUE_GLASS_SURFACE } from "../common/glass";

// The small right-click / long-press menu of the layer list ("move to" and "delete").

export interface MenuState {
  layerId: string;
  x: number;
  y: number;
}

/**
 * 「削除」だけの小さなメニュー。外側のクリック・Esc・スクロール・リサイズで閉じる。
 * レイヤーパネルは transform を持つ（滑って出入りする）ため、`position: fixed` がパネル基準になってしまう。
 * それを避けるため `document.body` へ portal で出す。
 */
export function LayerContextMenu({
  menu,
  onFocus,
  onDelete,
  onClose,
}: {
  menu: MenuState;
  onFocus: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="layer-context-menu"
      style={{ left: menu.x, top: menu.y }}
      className={`fixed z-50 min-w-28 rounded-lg p-1 text-sm shadow-xl ${OPAQUE_GLASS_SURFACE}`}
    >
      <button
        type="button"
        role="menuitem"
        autoFocus
        onClick={onFocus}
        className="flex min-h-11 w-full items-center rounded px-3 text-left hover:bg-black/5 dark:hover:bg-white/10"
      >
        移動
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex min-h-11 w-full items-center rounded px-3 text-left hover:bg-black/5 dark:hover:bg-white/10"
      >
        削除
      </button>
    </div>,
    document.body,
  );
}
