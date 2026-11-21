import { VIEW_PRESET_IDS, type ProjectionMode, type Program } from "../../../plugin-api";
import { PROJECTION_HINTS, PROJECTION_LABELS, shortcutKeyOfPreset, VIEW_PRESET_LABELS } from "../labels";
import type { ViewModel, ViewMsg } from "../model";
import { useViewModel } from "./useViewModel";

const PROJECTIONS: ProjectionMode[] = ["perspective", "orthographic"];

const VIEW_BUTTON_CLASS =
  "min-h-11 min-w-11 rounded border border-slate-300 px-2 py-2 text-sm whitespace-nowrap hover:bg-black/5 dark:border-slate-600 dark:hover:bg-white/10";
const VIEW_BUTTON_ACTIVE_CLASS = "border-primary bg-primary/15 font-semibold";

export function ViewDialogBody({ program }: { program: Program<ViewModel, ViewMsg> }) {
  const { view } = useViewModel(program);
  const currentPreset = view.preset;
  return (
    <>
      <div className="grid grid-cols-4 gap-2 md:grid-cols-3" data-testid="view-presets">
        <button
          type="button"
          onClick={() => program.dispatch({ type: "fitRequested" })}
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
            onClick={() => program.dispatch({ type: "presetRequested", id })}
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
        <legend className="sr-only mb-1 text-xs opacity-70 md:not-sr-only">投影（5 キーで切り替え）</legend>
        {PROJECTIONS.map((mode) => (
          <label
            key={mode}
            className="flex min-h-11 flex-1 items-center gap-2 rounded px-2 text-sm whitespace-nowrap hover:bg-black/5 md:flex-none dark:hover:bg-white/10"
          >
            <input
              type="radio"
              name="view-projection"
              value={mode}
              checked={view.projection === mode}
              onChange={() => program.dispatch({ type: "projectionRequested", mode })}
            />
            <span>{PROJECTION_LABELS[mode]}</span>
            <span className="hidden text-xs whitespace-normal opacity-70 md:inline">{PROJECTION_HINTS[mode]}</span>
          </label>
        ))}
      </fieldset>
      <p className="hidden text-xs opacity-70 md:block">押すとすぐ動きます。Esc か「閉じる」で閉じます。「全体」でいつでも戻れます。</p>
    </>
  );
}
