import type { DisplayUnit } from "../../../state/units";
import { useDisplayUnit } from "../../../state/useDisplayUnit";
import { OptionRow } from "../../dialogs/OptionRow";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

const UNIT_LABELS: Record<DisplayUnit, string> = {
  meter: "メートル",
  foot: "フィート",
};

/** L2-D: display unit (meters or feet) for measurement results and the layer-info bounding box. */
export function UnitDialog(page: PageProps) {
  const [unit, setUnit] = useDisplayUnit();
  return (
    <SettingsPageDialog {...page} title="単位">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">長さの表示</legend>
        {(Object.keys(UNIT_LABELS) as DisplayUnit[]).map((u) => (
          <OptionRow key={u}>
            <input
              type="radio"
              name="display-unit"
              data-testid={`unit-${u}`}
              value={u}
              checked={unit === u}
              onChange={() => setUnit(u)}
              className="h-5 w-5 accent-primary"
            />
            {UNIT_LABELS[u]}
          </OptionRow>
        ))}
      </fieldset>
      <p className="text-xs opacity-60">
        計測の結果とレイヤー情報の範囲に使う。ファイルの座標の単位（フィートなど）から換算して出す。
        フィートは国際フィート（1 ft = 0.3048 m）。座標の単位が分からないファイルは換算せず、「座標の単位」と注記する。
      </p>
    </SettingsPageDialog>
  );
}
