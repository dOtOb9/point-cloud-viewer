import {
  fitAllView,
  PROJECTION_LABELS,
  runViewAction,
  setProjection,
  shortcutKeyOfPreset,
  viewContext,
  type ViewContext,
} from "../../app/view";
import { VIEW_PRESET_IDS, VIEW_PRESET_LABELS } from "../../renderer/view-presets";
import type { ProjectionMode } from "../../renderer/projection";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useStore } from "../../state/useStore";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";

// TP-1: the view dialog. It stays open after a press (the view moves at once, nothing to "apply") and sits at the
// side so the result stays visible (UX-2). On a narrow screen it is a short strip at the bottom: the explanations are
// hidden and the buttons are in a compact grid. The steps are in src/app/view.ts; this file only shows the state.

const PROJECTIONS: ProjectionMode[] = ["perspective", "orthographic"];

const VIEW_BUTTON_CLASS =
  "min-h-11 min-w-11 rounded border border-slate-300 px-2 py-2 text-sm whitespace-nowrap hover:bg-black/5 dark:border-slate-600 dark:hover:bg-white/10";
const VIEW_BUTTON_ACTIVE_CLASS = "border-primary bg-primary/15 font-semibold";

/** `context` is the app's view context; a test passes its own. */
export function ViewDialog({
  viewer,
  onClose,
  context = viewContext,
}: {
  viewer: CopcViewerState;
  onClose: () => void;
  context?: ViewContext;
}) {
  const projectionMode = useStore(context.projection);
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
      <div className="grid grid-cols-4 gap-2 md:grid-cols-3" data-testid="view-presets">
        <button
          type="button"
          onClick={() => fitAllView(context)}
          className={`${VIEW_BUTTON_CLASS} font-semibold md:col-span-3`}
          title="見えているレイヤーが全部入るように、向きはそのままで寄る（F キー）"
          data-testid="view-fit"
        >
          全体 <span className="hidden text-xs opacity-70 md:inline">(F)</span>
        </button>
        {VIEW_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => runViewAction(context, { kind: "preset", id })}
            aria-pressed={currentPreset === id}
            className={`${VIEW_BUTTON_CLASS} ${currentPreset === id ? VIEW_BUTTON_ACTIVE_CLASS : ""}`}
            title={`${VIEW_PRESET_LABELS[id]}から見る（${shortcutKeyOfPreset(id)} キー）`}
            data-testid={`view-preset-${id}`}
          >
            {VIEW_PRESET_LABELS[id]} <span className="hidden text-xs opacity-70 md:inline">({shortcutKeyOfPreset(id)})</span>
          </button>
        ))}
      </div>
      <fieldset className="flex flex-row gap-2 md:flex-col md:gap-1" data-testid="view-projection">
        <legend className="mb-1 text-xs opacity-70">投影（5 キーで切り替え）</legend>
        {PROJECTIONS.map((mode) => (
          <label
            key={mode}
            className="flex min-h-11 flex-1 items-center gap-2 rounded px-2 text-sm whitespace-nowrap hover:bg-black/5 md:flex-none dark:hover:bg-white/10"
          >
            <input
              type="radio"
              name="view-projection"
              value={mode}
              checked={projectionMode === mode}
              onChange={() => setProjection(context, mode)}
            />
            <span>{PROJECTION_LABELS[mode]}</span>
            <span className="hidden text-xs whitespace-normal opacity-70 md:inline">
              {mode === "perspective" ? "（遠くが小さく見える）" : "（どこも同じ大きさ。図面向き）"}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="hidden text-xs opacity-70 md:block">押すとすぐ動きます。Esc か「閉じる」で閉じます。「全体」でいつでも戻れます。</p>
    </Dialog>
  );
}
