import type { BackgroundMode, CopcViewerState } from "../../../state/useCopcViewer";
import { OptionRow } from "../../dialogs/OptionRow";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  "solid-dark": "単色(暗)",
  "solid-light": "単色(明)",
  sky: "空",
};

/** 背景(ラジオボタン)とグリッドのオン/オフ。 */
export function BackgroundDialog({ viewer, ...page }: PageProps & { viewer: CopcViewerState }) {
  return (
    <SettingsPageDialog {...page} title="背景とグリッド">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">背景</legend>
        {(Object.keys(BACKGROUND_MODE_LABELS) as BackgroundMode[]).map((mode) => (
          <OptionRow key={mode}>
            <input
              type="radio"
              name="background-mode"
              value={mode}
              checked={viewer.backgroundMode === mode}
              onChange={() => viewer.setBackgroundMode(mode)}
              className="h-5 w-5 accent-primary"
            />
            {BACKGROUND_MODE_LABELS[mode]}
          </OptionRow>
        ))}
      </fieldset>
      <OptionRow>
        <input
          type="checkbox"
          name="grid-enabled"
          checked={viewer.gridEnabled}
          onChange={(e) => viewer.setGridEnabled(e.target.checked)}
          className="h-5 w-5 accent-primary"
        />
        グリッドを表示する
      </OptionRow>
    </SettingsPageDialog>
  );
}
