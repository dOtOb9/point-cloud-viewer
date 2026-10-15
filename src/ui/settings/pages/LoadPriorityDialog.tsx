import type { CopcViewerState } from "../../../state/useCopcViewer";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

/** 読み込み優先: 画面中央を優先して読み込む強さと、重みの下限。(L2-A: リボンのダイアログから設定の専用ページへ移した) */
export function LoadPriorityDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="読み込み優先">
      <p className="text-xs opacity-70">画面の中央に近いデータを先に読み込む設定。変更はすぐ反映される。</p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex justify-between">
          <span>中央優先の強さ</span>
          <span className="font-mono">{viewer.centerPriorityStrength}</span>
        </span>
        <input
          type="range"
          min={0}
          max={16}
          step={0.5}
          value={viewer.centerPriorityStrength}
          onChange={(e) => viewer.setCenterPriorityStrength(Number(e.target.value))}
          className="h-8 w-full accent-primary"
        />
        <span className="text-xs opacity-70">0〜16、既定4。大きいほど画面の端を後回しにする。0で無効。</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex justify-between">
          <span>重みの下限</span>
          <span className="font-mono">{viewer.minCenterPriorityWeight.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.01}
          value={viewer.minCenterPriorityWeight}
          onChange={(e) => viewer.setMinCenterPriorityWeight(Number(e.target.value))}
          className="h-8 w-full accent-primary"
        />
        <span className="text-xs opacity-70">0〜0.5、既定0.2。画面の端でも読み込まれなくならないよう、重みの最小値を決める。</span>
      </label>
    </SettingsPageDialog>
  );
}
