import type { CopcViewerState } from "../../../state/useCopcViewer";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

export function AnimationDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="アニメーション">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="animation-toggle"
          checked={viewer.animationEnabled}
          onChange={(e) => viewer.setAnimationEnabled(e.target.checked)}
        />
        アニメーションを使う
      </label>
      <p className="text-xs opacity-60">画面の動きをまとめて切り替える。OSで「動きを減らす」が有効なときは常に止まる。</p>
    </SettingsPageDialog>
  );
}
