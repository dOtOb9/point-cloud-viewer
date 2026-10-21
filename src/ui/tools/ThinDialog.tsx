import { useState } from "react";
import { thinLayer } from "../../app/point-cloud-tools";
import { THIN_FILTER_PRESETS, presetLengthInDisplay, thinRequestFor, type ThinMethod } from "../../app/thin-filter";
import type { GridKeep } from "../../datasource/thin-filter";
import { lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { selectedPointCloudLayer } from "../toolbar/toolbar-state";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";
import { OptionRow } from "../dialogs/OptionRow";

// G3: the thinning dialog (a plain form). The preset values live in src/app/thin-filter.ts; this file only shows them
// and calls `thinLayer` (src/app/point-cloud-tools.ts) when "間引く" is pressed.

const METHODS: { value: ThinMethod; label: string; note: string }[] = [
  { value: "grid", label: "グリッド（2D）", note: "（平面を正方形のセルに区切り、セルごとに1点）" },
  { value: "voxel", label: "ボクセル（3D）", note: "（空間を立方体に区切り、立方体ごとに1点）" },
];

const GRID_KEEPS: { value: GridKeep; label: string }[] = [
  { value: "nearestCentre", label: "セルの中心に最も近い点" },
  { value: "lowest", label: "最も低い点" },
  { value: "highest", label: "最も高い点" },
];

/** Round for the input box (3 decimals; the box is for typing). */
function rounded(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Thinning of the selected point-cloud layer. Mounted only while open, so the fields start from the presets each time. */
export function ThinDialog({ viewer, onClose }: { viewer: CopcViewerState; onClose: () => void }) {
  const [display] = useDisplayUnit();
  const layer = selectedPointCloudLayer(viewer);
  const units = lengthUnitsFor(layer?.info.crs, display);
  const unitText = units.horizontalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(display);

  const [method, setMethod] = useState<ThinMethod>(THIN_FILTER_PRESETS.thin.method);
  const [size, setSize] = useState(() => rounded(presetLengthInDisplay(THIN_FILTER_PRESETS.thin.sizeMeters, display)));
  const [keep, setKeep] = useState<GridKeep>(THIN_FILTER_PRESETS.thin.keep);

  const sizeNumber = Number(size);
  const valid = layer !== null && size.trim() !== "" && Number.isFinite(sizeNumber) && sizeNumber > 0;

  const confirm = () => {
    if (!valid || layer === null) return;
    onClose();
    void thinLayer(viewer.toolContext, layer.id, thinRequestFor({ method, size: sizeNumber, keep }, units));
  };

  const field = "h-10 w-full rounded border border-slate-300 bg-transparent px-2 text-sm dark:border-slate-600";
  return (
    <Dialog
      open
      title="間引き"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={DIALOG_TERTIARY_BUTTON_CLASS}>
            キャンセル
          </button>
          <button type="button" onClick={confirm} disabled={!valid} className={DIALOG_PRIMARY_BUTTON_CLASS} data-testid="thin-confirm">
            間引く
          </button>
        </>
      }
    >
      <p className="text-xs opacity-70">
        対象のレイヤー: <span className="font-semibold">{layer?.name ?? "（なし）"}</span>
        。点を減らした新しいレイヤーを作ります（元のレイヤーは変わりません。残る点は元の点で、色や強度もそのままです）。
      </p>
      <fieldset className="flex flex-col gap-1" data-testid="thin-method">
        <legend className="mb-1 text-xs opacity-70">方式</legend>
        {METHODS.map((option) => (
          <OptionRow key={option.value}>
            <input
              type="radio"
              name="thin-method"
              value={option.value}
              checked={method === option.value}
              onChange={() => setMethod(option.value)}
              className="h-5 w-5 accent-primary"
            />
            {option.label}
            <span className="text-xs opacity-70">{option.note}</span>
          </OptionRow>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        {method === "grid" ? "セルの一辺" : "ボクセルの一辺"}（{unitText}）
        <input type="number" min={0} step="any" value={size} onChange={(e) => setSize(e.target.value)} className={field} data-testid="thin-size" />
      </label>
      {method === "grid" ? (
        <fieldset className="flex flex-col gap-1" data-testid="thin-keep">
          <legend className="mb-1 text-xs opacity-70">セルに残す点</legend>
          {GRID_KEEPS.map((option) => (
            <OptionRow key={option.value}>
              <input
                type="radio"
                name="thin-keep"
                value={option.value}
                checked={keep === option.value}
                onChange={() => setKeep(option.value)}
                className="h-5 w-5 accent-primary"
              />
              {option.label}
            </OptionRow>
          ))}
        </fieldset>
      ) : (
        <p className="text-xs opacity-70">ボクセルでは、立方体の中心に最も近い点を残します。</p>
      )}
    </Dialog>
  );
}
