import type { CopcViewerState } from "../../../state/useCopcViewer";
import { OptionRow } from "../../dialogs/OptionRow";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

/** 点予算: 手動の値と「自動調整する」。 */
export function PointBudgetDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="点予算">
      <p className="text-xs opacity-60">一度に描く点の数の上限。小さいほど軽く、大きいほど細かく見える。</p>
      <label className="flex flex-col gap-1 text-sm">
        点数{viewer.autoPointBudgetEnabled ? "（自動調整中）" : ""}
        <input
          type="number"
          name="point-budget"
          min={1000}
          step={100_000}
          value={viewer.pointBudget}
          onChange={(e) => viewer.setPointBudget(Number(e.target.value) || 0)}
          disabled={viewer.autoPointBudgetEnabled}
          title={viewer.autoPointBudgetEnabled ? "自動調整中のため読み取り専用。下のチェックを外すと手動で変更できる" : undefined}
          className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm text-inherit disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800"
        />
      </label>
      <OptionRow>
        <input
          type="checkbox"
          name="auto-point-budget"
          checked={viewer.autoPointBudgetEnabled}
          onChange={(e) => viewer.setAutoPointBudgetEnabled(e.target.checked)}
          className="h-5 w-5 accent-primary"
        />
        点予算を自動調整する
      </OptionRow>
    </SettingsPageDialog>
  );
}
