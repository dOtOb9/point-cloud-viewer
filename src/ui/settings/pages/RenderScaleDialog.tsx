import type { CopcViewerState } from "../../../state/useCopcViewer";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

const RENDER_SCALE_OPTIONS = [0.25, 0.5, 0.75, 1.0] as const;

export function RenderScaleDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="描画の解像度">
      <div className="flex gap-2">
        {RENDER_SCALE_OPTIONS.map((scale) => (
          <button
            key={scale}
            type="button"
            onClick={() => viewer.setRenderScale(scale)}
            className={`rounded px-3 py-1.5 text-sm ${
              viewer.renderScale === scale ? "bg-primary text-on-primary" : "border border-slate-300 dark:border-slate-600"
            }`}
          >
            {scale}
          </button>
        ))}
      </div>
      <p className="text-xs opacity-60">画面サイズに対する描画の細かさ。小さいほど軽く、大きいほど鮮明。</p>
    </SettingsPageDialog>
  );
}
