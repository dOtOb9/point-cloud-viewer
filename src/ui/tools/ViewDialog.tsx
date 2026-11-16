import { fitAllView, PROJECTION_LABELS, runViewAction, setProjection, shortcutKeyOfPreset } from "../../app/view";
import { VIEW_PRESET_IDS, VIEW_PRESET_LABELS } from "../../renderer/view-presets";
import type { ProjectionMode } from "../../renderer/projection";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";
import { OptionRow } from "../dialogs/OptionRow";

// TP-1: the view dialog. It stays open after a press (the view moves at once, nothing to "apply") and sits at the
// side so the result stays visible (UX-2). The steps are in src/app/view.ts; this file only shows the state.

const PROJECTIONS: ProjectionMode[] = ["perspective", "orthographic"];

const VIEW_BUTTON_CLASS =
  "min-h-11 min-w-11 rounded border border-slate-300 px-3 py-2 text-sm hover:bg-black/5 dark:border-slate-600 dark:hover:bg-white/10";
const VIEW_BUTTON_ACTIVE_CLASS = "border-primary bg-primary/15 font-semibold";

export function ViewDialog({ viewer, onClose }: { viewer: CopcViewerState; onClose: () => void }) {
  const ctx = viewer.viewContext;
  const currentPreset = viewer.stats?.viewPreset ?? null;
  return (
    <Dialog
      open
      title="視点"
      onClose={onClose}
      placement="side"
      widthClass="max-w-xs"
      footer={
        <button type="button" onClick={onClose} className={DIALOG_TERTIARY_BUTTON_CLASS}>
          閉じる
        </button>
      }
    >
      <button
        type="button"
        onClick={() => fitAllView(ctx)}
        className={`${VIEW_BUTTON_CLASS} w-full font-semibold`}
        title="見えているレイヤーが全部入るように、向きはそのままで寄る（F キー）"
        data-testid="view-fit"
      >
        全体 <span className="text-xs opacity-70">(F)</span>
      </button>
      <div className="grid grid-cols-3 gap-2" data-testid="view-presets">
        {VIEW_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => runViewAction(ctx, { kind: "preset", id })}
            aria-pressed={currentPreset === id}
            className={`${VIEW_BUTTON_CLASS} ${currentPreset === id ? VIEW_BUTTON_ACTIVE_CLASS : ""}`}
            title={`${VIEW_PRESET_LABELS[id]}から見る（${shortcutKeyOfPreset(id)} キー）`}
            data-testid={`view-preset-${id}`}
          >
            {VIEW_PRESET_LABELS[id]} <span className="text-xs opacity-70">({shortcutKeyOfPreset(id)})</span>
          </button>
        ))}
      </div>
      <fieldset className="flex flex-col gap-1" data-testid="view-projection">
        <legend className="mb-1 text-xs opacity-70">投影（5 キーで切り替え）</legend>
        {PROJECTIONS.map((mode) => (
          <OptionRow key={mode}>
            <input
              type="radio"
              name="view-projection"
              value={mode}
              checked={viewer.projectionMode === mode}
              onChange={() => setProjection(ctx, mode)}
            />
            <span>{PROJECTION_LABELS[mode]}</span>
            <span className="text-xs opacity-70">
              {mode === "perspective" ? "（遠くが小さく見える。ふつうの見え方）" : "（距離によらず同じ大きさ。平面図・立面図向き）"}
            </span>
          </OptionRow>
        ))}
      </fieldset>
      <p className="text-xs opacity-70">
        押すとすぐ動きます。Esc か「閉じる」で閉じます。どこにいても「全体」で戻れます。
      </p>
    </Dialog>
  );
}
