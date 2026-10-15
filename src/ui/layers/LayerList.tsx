import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { OPAQUE_GLASS_SURFACE } from "../common/glass";

// L1-D: レイヤー欄の一覧。各行は「表示チェック + 名前」。
// - チェックボックス: 表示・非表示
// - 行クリック: 選択（選択中は左の緑線）
// - ダブルクリック: そのレイヤーへカメラを移す（L2-B）
// - 右クリック（タッチ端末では長押し）: 小さなメニュー「移動」「削除」

/** 長押しとみなすまでの時間(ms)。タッチ端末で右クリックの代わりにメニューを出す（未検証の初期値）。 */
const LONG_PRESS_MS = 500;
/** 長押し中にこれ以上指が動いたら、スクロールとみなして長押しをやめる(px)。 */
const LONG_PRESS_MOVE_TOLERANCE = 8;

interface MenuState {
  layerId: string;
  x: number;
  y: number;
}

/**
 * 「削除」だけの小さなメニュー。外側のクリック・Esc・スクロール・リサイズで閉じる。
 * レイヤーパネルは transform を持つ（滑って出入りする）ため、`position: fixed` がパネル基準になってしまう。
 * それを避けるため `document.body` へ portal で出す。
 */
function LayerContextMenu({
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

export function LayerList({ viewer }: { viewer: CopcViewerState }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 長押しの判定用。タイマーと、押し始めた位置。
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null);

  const cancelPress = () => {
    if (pressRef.current) {
      window.clearTimeout(pressRef.current.timer);
      pressRef.current = null;
    }
  };
  // アンマウント時にタイマーが残らないようにする。
  useEffect(() => cancelPress, []);

  const loading = viewer.status === "opening" || viewer.status === "converting";

  if (viewer.layers.length === 0 && !loading) {
    return <p className="px-2 py-1.5 text-xs opacity-60">開いているファイルはありません</p>;
  }

  return (
    <>
      <ul className="flex flex-col gap-1">
        {viewer.layers.map((layer) => {
          const selected = layer.id === viewer.selectedLayerId;
          const alsoSelected = !selected && viewer.selectedLayerIds.includes(layer.id);
          return (
            <li
              key={layer.id}
              aria-selected={selected || alsoSelected}
              data-testid="layer-row"
              // L2-F: Ctrl/Cmd click adds or removes a layer, Shift click selects a range; a plain click selects just this one.
              // The action buttons below act on the one chosen last (`selectedLayerId`).
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) viewer.toggleLayerSelection(layer.id);
                else if (e.shiftKey) viewer.selectLayerRange(layer.id);
                else viewer.selectLayer(layer.id);
              }}
              // ダブルクリックでそのレイヤーへカメラを移す（1回目のクリックで選択も済んでいる）。
              onDoubleClick={() => viewer.focusLayer(layer.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelPress();
                setMenu({ layerId: layer.id, x: e.clientX, y: e.clientY });
              }}
              onPointerDown={(e) => {
                // マウスは右クリック(contextmenu)に任せる。タッチ・ペンだけ長押しでも同じメニューを出す。
                if (e.pointerType === "mouse") return;
                cancelPress();
                const x = e.clientX;
                const y = e.clientY;
                pressRef.current = {
                  x,
                  y,
                  timer: window.setTimeout(() => {
                    pressRef.current = null;
                    setMenu({ layerId: layer.id, x, y });
                  }, LONG_PRESS_MS),
                };
              }}
              onPointerMove={(e) => {
                const press = pressRef.current;
                if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_MOVE_TOLERANCE) cancelPress();
              }}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              // L2-A: 選択の有無で左線の太さが変わると文字がずれるため、全行に同じ太さの左線を付け、
              // 選択していない行は透明にする（余白・高さは全行で同じ）。
              className={`flex min-h-11 cursor-pointer select-none items-center gap-2 rounded border-l-[3px] px-2 py-1.5 text-xs ${
                selected
                  ? "border-l-primary bg-black/5 dark:bg-white/10"
                  : // Selected together with the primary (L2-F): a lighter version of the same look.
                    alsoSelected
                    ? "border-l-primary/40 bg-black/[0.03] dark:bg-white/5"
                    : "border-l-transparent"
              }`}
            >
              <input
                type="checkbox"
                aria-label={`${layer.name}を表示`}
                title="表示・非表示"
                checked={layer.visible}
                onChange={(e) => viewer.setLayerVisible(layer.id, e.target.checked)}
                // チェックの操作で行の選択や長押しが起きないようにする。
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="h-5 w-5 shrink-0 accent-primary"
              />
              <span className={`min-w-0 flex-1 truncate ${layer.visible ? "" : "opacity-50"}`} title={layer.name}>
                {layer.name}
              </span>
            </li>
          );
        })}
        {loading && (
          <li className="flex min-h-11 items-center gap-2 rounded border-l-[3px] border-l-transparent px-2 py-1.5 text-xs opacity-70">
            <span className="min-w-0 flex-1 truncate">読み込み中…</span>
          </li>
        )}
      </ul>
      {menu && (
        <LayerContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onFocus={() => {
            viewer.focusLayer(menu.layerId);
            setMenu(null);
          }}
          onDelete={() => {
            viewer.removeLayer(menu.layerId);
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
