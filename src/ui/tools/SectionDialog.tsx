import { useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import type { LayerToolState } from "../../state/useLayerTool";
import { convertLength, lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { displayLengthToFile, heightRange, sectionLineRequestFor } from "../../state/tool-math";
import type { SectionLinePreset } from "../../datasource/section-line";
import { OptionRow } from "../dialogs/OptionRow";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";

// L2-F: the cross-section dialog (a plain form), opened after the two points of the section line are picked.

const SECTION_LINE_PRESETS: { value: SectionLinePreset; label: string; note: string }[] = [
  { value: "standard", label: "標準", note: "（平地や緩やかな地形）" },
  { value: "steep", label: "急勾配", note: "（斜面が多い地形。時間がかかる）" },
];

/** Round for the input boxes (2 decimals; the box is for typing, not for showing a measurement). */
function rounded(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Cross section: thickness of the slab and the height range, after the two points of the line were picked.
 * Values are typed in the display unit (settings, "単位"; default m) and converted to the file's unit with the
 * layer's CRS factors. If the file's unit is unknown the numbers are taken as the file's unit.
 * The default thickness is 1 (in the display unit); the default height range is the whole z range of the layer.
 */
export function SectionDialog({ viewer, tool }: { viewer: CopcViewerState; tool: LayerToolState }) {
  // Mounted only while open, so the fields start from the defaults each time.
  if (!tool.sectionReady) return null;
  return <SectionDialogBody viewer={viewer} tool={tool} />;
}

function SectionDialogBody({ viewer, tool }: { viewer: CopcViewerState; tool: LayerToolState }) {
  const [display] = useDisplayUnit();
  const layer = viewer.selectedLayer;
  const units = lengthUnitsFor(layer?.info.crs, display);
  const up = viewer.getViewSnapshot()?.up ?? [0, 0, 1];
  const range = layer ? heightRange(layer.info.min, layer.info.max, up) : { min: 0, max: 0 };
  const toDisplay = (v: number) => convertLength(v, units.verticalToMeter, display) ?? v;
  const unitText = units.horizontalToMeter === null || units.verticalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(display);

  const [thickness, setThickness] = useState("1");
  // G2-4: the CSF preset for the ground line (default: standard).
  const [preset, setPreset] = useState<SectionLinePreset>("standard");
  const [heightMin, setHeightMin] = useState(() => rounded(toDisplay(range.min)));
  const [heightMax, setHeightMax] = useState(() => rounded(toDisplay(range.max)));

  const t = Number(thickness);
  const lo = Number(heightMin);
  const hi = Number(heightMax);
  const valid = thickness.trim() !== "" && Number.isFinite(t) && t > 0 && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;

  const confirm = () => {
    if (!valid) return;
    tool.confirmSection(
      displayLengthToFile(t, units.horizontalToMeter, display),
      displayLengthToFile(lo, units.verticalToMeter, display),
      displayLengthToFile(hi, units.verticalToMeter, display),
      sectionLineRequestFor(preset, units.horizontalToMeter),
    );
  };

  const field = "h-10 w-full rounded border border-slate-300 bg-transparent px-2 text-sm dark:border-slate-600";
  return (
    <Dialog
      open
      title="断面を作る"
      onClose={tool.cancelSection}
      footer={
        <>
          <button type="button" onClick={tool.cancelSection} className={DIALOG_TERTIARY_BUTTON_CLASS}>
            キャンセル
          </button>
          <button type="button" onClick={confirm} disabled={!valid} className={DIALOG_PRIMARY_BUTTON_CLASS} data-testid="section-confirm">
            作る
          </button>
        </>
      }
    >
      <p className="text-xs opacity-70">
        対象のレイヤー: <span className="font-semibold">{layer?.name ?? "（なし）"}</span>
        。引いた線に沿った鉛直の板の中の点を、新しいレイヤーにします（元のレイヤーは変わりません）。
      </p>
      <label className="flex flex-col gap-1 text-sm">
        厚み（線の両側あわせて、{unitText}）
        <input type="number" min={0} step="any" value={thickness} onChange={(e) => setThickness(e.target.value)} className={field} data-testid="section-thickness" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          高さ 下（{unitText}）
          <input type="number" step="any" value={heightMin} onChange={(e) => setHeightMin(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          高さ 上（{unitText}）
          <input type="number" step="any" value={heightMax} onChange={(e) => setHeightMax(e.target.value)} className={field} />
        </label>
      </div>
      <p className="text-xs opacity-70">高さの既定は、このレイヤーの高さの範囲ぜんぶです。</p>
      {/* G2-4: the ground line of the section is made with CSF; the preset is the owner's "標準 / 急勾配". */}
      <fieldset className="flex flex-col gap-1" data-testid="section-line-preset">
        <legend className="mb-1 text-xs opacity-70">断面線（地表の線）の作り方</legend>
        {SECTION_LINE_PRESETS.map((option) => (
          <OptionRow key={option.value}>
            <input
              type="radio"
              name="section-line-preset"
              value={option.value}
              checked={preset === option.value}
              onChange={() => setPreset(option.value)}
              className="h-5 w-5 accent-primary"
            />
            {option.label}
            <span className="text-xs opacity-70">{option.note}</span>
          </OptionRow>
        ))}
      </fieldset>
    </Dialog>
  );
}

