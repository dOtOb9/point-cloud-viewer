import { useEffect, useRef, useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { isFileOpenBusy } from "../../state/viewer-status";
import { LayerContextMenu, type MenuState } from "./LayerContextMenu";

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8;

export function LayerList({ viewer }: { viewer: CopcViewerState }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null);

  const cancelPress = () => {
    if (pressRef.current) {
      window.clearTimeout(pressRef.current.timer);
      pressRef.current = null;
    }
  };
  useEffect(() => cancelPress, []);

  const loading = isFileOpenBusy(viewer.status);

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
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) viewer.toggleLayerSelection(layer.id);
                else if (e.shiftKey) viewer.selectLayerRange(layer.id);
                else viewer.selectLayer(layer.id);
              }}
              onDoubleClick={() => viewer.focusLayer(layer.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelPress();
                setMenu({ layerId: layer.id, x: e.clientX, y: e.clientY });
              }}
              onPointerDown={(e) => {
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
              className={`flex min-h-11 cursor-pointer select-none items-center gap-2 rounded border-l-[3px] px-2 py-1.5 text-xs ${
                selected
                  ? "border-l-primary bg-black/5 dark:bg-white/10"
                  : alsoSelected
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
