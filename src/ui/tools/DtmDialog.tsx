import { useState } from "react";
import {
  DTM_DEFAULT_CELL_SIZE_M,
  csfPresetInDisplay,
  dtmRequestFor,
  presetOf,
  type DtmPreset,
} from "../../app/dtm";
import type { CsfParamsInMetres } from "../../app/csf-params";
import { makeDtm } from "../../app/point-cloud-tools";
import { describeDtmOutput } from "../../state/dtm-setting";
import { lengthUnitsFor, metersToDisplay, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { useDtmOutput } from "../../state/useDtmOutput";
import { selectedPointCloudLayer } from "../toolbar/toolbar-state";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";
import { OptionRow } from "../dialogs/OptionRow";

// G1-T15: the DTM dialog (a plain form). The preset values live in src/app/csf-params.ts and the request is built by
// src/app/dtm.ts; this file only shows them and calls `makeDtm` (src/app/point-cloud-tools.ts) when "作る" is pressed.
// The output format is NOT chosen here (owner's answer Q18): it is a setting, and this dialog only says what it is now.

const PRESETS: { value: DtmPreset; label: string; note: string }[] = [
  { value: "standard", label: "標準", note: "（平地・市街地向け）" },
  { value: "steep", label: "急勾配", note: "（山地・斜面向け。布を細かく柔らかくして、繰り返しを増やす）" },
  { value: "custom", label: "カスタム", note: "（詳細設定で値を変えたとき）" },
];

type NumericKey = Exclude<keyof CsfParamsInMetres, "slopeSmooth">;

/** The detail fields. `length`: shown in the display unit; `integer`: a whole number of 1 or more. */
const FIELDS: { key: NumericKey; label: string; length: boolean; integer: boolean }[] = [
  { key: "clothResolution", label: "布の間隔", length: true, integer: false },
  { key: "rigidness", label: "布のかたさ（大きいほど硬い）", length: false, integer: true },
  { key: "timeStep", label: "時間刻み", length: false, integer: false },
  { key: "classThresholdUpper", label: "地表とみなす幅（上）", length: true, integer: false },
  { key: "classThresholdLower", label: "地表とみなす幅（下）", length: true, integer: false },
  { key: "iterations", label: "繰り返しの上限", length: false, integer: true },
  { key: "hdiff", label: "斜面の補正の高さの差", length: true, integer: false },
  { key: "convergenceThreshold", label: "収束とみなす動き", length: true, integer: false },
];

/** Round for the input box (3 decimals; the box is for typing). */
function rounded(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

type Texts = Record<NumericKey, string>;

function textsOf(values: CsfParamsInMetres): Texts {
  const texts = {} as Texts;
  for (const f of FIELDS) texts[f.key] = rounded(values[f.key]);
  return texts;
}

/** The numbers the texts hold, or null when one is not a valid number. */
function parseTexts(texts: Texts, slopeSmooth: boolean): CsfParamsInMetres | null {
  const values = { slopeSmooth } as CsfParamsInMetres;
  for (const f of FIELDS) {
    const text = texts[f.key].trim();
    const n = Number(text);
    if (text === "" || !Number.isFinite(n) || n <= 0) return null;
    if (f.integer && !Number.isInteger(n)) return null;
    values[f.key] = n;
  }
  return values;
}

/** DTM of the selected point-cloud layer. Mounted only while open, so the fields start from the preset each time. */
export function DtmDialog({ viewer, onClose }: { viewer: CopcViewerState; onClose: () => void }) {
  const [display] = useDisplayUnit();
  const [output] = useDtmOutput();
  const layer = selectedPointCloudLayer(viewer);
  const units = lengthUnitsFor(layer?.info.crs, display);
  const unitText = units.horizontalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(display);

  const [texts, setTexts] = useState<Texts>(() => textsOf(csfPresetInDisplay("standard", display)));
  const [slopeSmooth, setSlopeSmooth] = useState(true);
  const [cellSize, setCellSize] = useState(() => rounded(metersToDisplay(DTM_DEFAULT_CELL_SIZE_M, display)));
  const [showDetails, setShowDetails] = useState(false);

  const csf = parseTexts(texts, slopeSmooth);
  const preset: DtmPreset = csf === null ? "custom" : presetOf(csf, display);
  const cellSizeNumber = Number(cellSize);
  const valid = layer !== null && csf !== null && cellSize.trim() !== "" && Number.isFinite(cellSizeNumber) && cellSizeNumber > 0;

  const choosePreset = (next: DtmPreset) => {
    if (next === "custom") {
      setShowDetails(true);
      return;
    }
    const values = csfPresetInDisplay(next, display);
    setTexts(textsOf(values));
    setSlopeSmooth(values.slopeSmooth);
  };

  const confirm = () => {
    if (!valid || layer === null || csf === null) return;
    const { request, warning } = dtmRequestFor({ csf, cellSize: cellSizeNumber }, units, output);
    if (warning) viewer.toolContext.reportError(warning, "tool");
    onClose();
    void makeDtm(viewer.toolContext, layer.id, request);
  };

  const field = "h-10 w-full rounded border border-slate-300 bg-transparent px-2 text-sm dark:border-slate-600";
  return (
    <Dialog
      open
      title="DTM"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={DIALOG_TERTIARY_BUTTON_CLASS}>
            キャンセル
          </button>
          <button type="button" onClick={confirm} disabled={!valid} className={DIALOG_PRIMARY_BUTTON_CLASS} data-testid="dtm-confirm">
            作る
          </button>
        </>
      }
    >
      <p className="text-xs opacity-70">
        対象のレイヤー: <span className="font-semibold">{layer?.name ?? "（なし）"}</span>
        。地表の点を判定して、地表だけを三角形でつないだ標高モデル（DTM）を作ります。地表を判定した点群は新しいレイヤーになります（元のレイヤーは変わりません。
        元が地表の点でも、判定で地表でなければ「未分類」になります）。
      </p>
      <fieldset className="flex flex-col gap-1" data-testid="dtm-preset">
        <legend className="mb-1 text-xs opacity-70">地表の判定</legend>
        {PRESETS.map((option) => (
          <OptionRow key={option.value}>
            <input
              type="radio"
              name="dtm-preset"
              value={option.value}
              checked={preset === option.value}
              onChange={() => choosePreset(option.value)}
              className="h-5 w-5 accent-primary"
            />
            {option.label}
            <span className="text-xs opacity-70">{option.note}</span>
          </OptionRow>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        DTM のセルの一辺（{unitText}）
        <input type="number" min={0} step="any" value={cellSize} onChange={(e) => setCellSize(e.target.value)} className={field} data-testid="dtm-cell-size" />
      </label>
      <button
        type="button"
        onClick={() => setShowDetails(!showDetails)}
        className="self-start text-xs text-primary underline"
        data-testid="dtm-details-toggle"
        aria-expanded={showDetails}
      >
        {showDetails ? "詳細設定を閉じる" : "詳細設定を開く"}
      </button>
      {showDetails && (
        <div className="flex flex-col gap-2" data-testid="dtm-details">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-sm">
              {f.label}
              {f.length ? `（${unitText}）` : ""}
              <input
                type="number"
                min={0}
                step={f.integer ? 1 : "any"}
                value={texts[f.key]}
                onChange={(e) => setTexts({ ...texts, [f.key]: e.target.value })}
                className={field}
                data-testid={`dtm-field-${f.key}`}
              />
            </label>
          ))}
          <OptionRow>
            <input type="checkbox" checked={slopeSmooth} onChange={(e) => setSlopeSmooth(e.target.checked)} className="h-5 w-5 accent-primary" />
            斜面の補正をする
          </OptionRow>
        </div>
      )}
      <p className="text-xs opacity-70" data-testid="dtm-output-note">
        出力するファイル: <span className="font-semibold">{describeDtmOutput(output)}</span>
        。形式は設定の「DTM の出力形式」で変えられます。
      </p>
    </Dialog>
  );
}
