// 生成物: src/ui/shell/Dock.ui から ui-forge が生成。手で編集しないこと。
// 変更は src/ui/shell/Dock.ui に対して行い、`npm run ui -- gen` で作り直す。

export interface DockLayoutProps {
  infoOpen: boolean;
  layerOpen: boolean;
  onOpenSettings: () => void;
  onToggleInfo: () => void;
  onToggleLayer: () => void;
  surface: "glass" | "opaque" | "none";
}

export function DockLayout(props: DockLayoutProps) {
  return (
    <div data-ui-id="root" className="pointer-events-none fixed inset-0 z-20">
      <div data-ui-id="dock" className={`pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full p-1.5 shadow-lg text-sm${props.surface === "glass" ? " backdrop-blur-md bg-white/65 text-slate-900 border border-black/10 dark:bg-slate-950/70 dark:text-slate-100 dark:border-white/10" : props.surface === "opaque" ? " bg-white text-slate-900 border border-black/10 dark:bg-slate-950 dark:text-slate-100 dark:border-white/10" : ""}`}>
        <div data-ui-id="dock_buttons" className="flex gap-1 items-stretch">
          <button type="button" data-ui-id="layer_button" className={`rounded-full px-3 py-1.5${props.layerOpen ? " bg-slate-900 text-white dark:bg-white dark:text-slate-900" : " hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={props.onToggleLayer}>
            レイヤー
          </button>
          <button type="button" data-ui-id="info_button" className={`rounded-full px-3 py-1.5${props.infoOpen ? " bg-slate-900 text-white dark:bg-white dark:text-slate-900" : " hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={props.onToggleInfo}>
            情報
          </button>
          <button type="button" data-ui-id="settings_button" className="rounded-full px-3 py-1.5 hover:bg-black/5 dark:hover:bg-white/10" onClick={props.onOpenSettings}>
            設定
          </button>
        </div>
      </div>
    </div>
  );
}
