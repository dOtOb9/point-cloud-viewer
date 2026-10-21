import { useState } from "react";
import { filterLayer } from "../../app/point-cloud-tools";
import {
  THIN_FILTER_PRESETS,
  defaultSorSearchRadius,
  filterRequestFor,
  presetLengthInDisplay,
  type FilterMethod,
} from "../../app/thin-filter";
import { lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { selectedPointCloudLayer } from "../toolbar/toolbar-state";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";
import { OptionRow } from "../dialogs/OptionRow";

// G3: the outlier-filter dialog (a plain form). The preset values and the estimate of the SOR search range live in
// src/app/thin-filter.ts; this file only shows them and calls `filterLayer` when "実行" is pressed.

const METHODS: { value: FilterMethod; label: string; note: string }[] = [
  { value: "ror", label: "ROR（半径）", note: "（半径の中に近傍の点が少ない点を消す）" },
  { value: "sor", label: "SOR（統計）", note: "（近傍までの距離が全体より大きく外れた点を消す）" },
];

/** Round for the input box (3 decimals; the box is for typing). */
function rounded(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Outlier removal for the selected point-cloud layer. Mounted only while open, so the fields start from the presets each time. */
export function FilterDialog({ viewer, onClose }: { viewer: CopcViewerState; onClose: () => void }) {
  const [display] = useDisplayUnit();
  const layer = selectedPointCloudLayer(viewer);
  const units = lengthUnitsFor(layer?.info.crs, display);
  const unitText = units.horizontalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(display);

  const [method, setMethod] = useState<FilterMethod>("ror");
  const [radius, setRadius] = useState(() => rounded(presetLengthInDisplay(THIN_FILTER_PRESETS.ror.radiusMeters, display)));
  const [minNeighbors, setMinNeighbors] = useState(String(THIN_FILTER_PRESETS.ror.minNeighbors));
  const [k, setK] = useState(String(THIN_FILTER_PRESETS.sor.k));
  const [nSigma, setNSigma] = useState(String(THIN_FILTER_PRESETS.sor.nSigma));
  // The default search range comes from the layer's point spacing (src/app/thin-filter.ts).
  const [searchRadius, setSearchRadius] = useState(() => (layer ? rounded(defaultSorSearchRadius(layer.info, units)) : ""));

  const numbers = {
    radius: Number(radius),
    minNeighbors: Number(minNeighbors),
    k: Number(k),
    nSigma: Number(nSigma),
    searchRadius: Number(searchRadius),
  };
  const positive = (text: string, n: number) => text.trim() !== "" && Number.isFinite(n) && n > 0;
  const wholeAtLeast = (text: string, n: number, min: number) => text.trim() !== "" && Number.isInteger(n) && n >= min;
  const valid =
    layer !== null &&
    (method === "ror"
      ? positive(radius, numbers.radius) && wholeAtLeast(minNeighbors, numbers.minNeighbors, 1)
      : wholeAtLeast(k, numbers.k, 1) && nSigma.trim() !== "" && Number.isFinite(numbers.nSigma) && numbers.nSigma >= 0 && positive(searchRadius, numbers.searchRadius));

  const confirm = () => {
    if (!valid || layer === null) return;
    onClose();
    void filterLayer(viewer.toolContext, layer.id, filterRequestFor({ method, ...numbers }, units));
  };

  const field = "h-10 w-full rounded border border-slate-300 bg-transparent px-2 text-sm dark:border-slate-600";
  return (
    <Dialog
      open
      title="フィルタ（外れ値の除去）"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={DIALOG_TERTIARY_BUTTON_CLASS}>
            キャンセル
          </button>
          <button type="button" onClick={confirm} disabled={!valid} className={DIALOG_PRIMARY_BUTTON_CLASS} data-testid="filter-confirm">
            実行
          </button>
        </>
      }
    >
      <p className="text-xs opacity-70">
        対象のレイヤー: <span className="font-semibold">{layer?.name ?? "（なし）"}</span>
        。外れ値を除いた新しいレイヤーを作ります（元のレイヤーは変わりません）。
      </p>
      <fieldset className="flex flex-col gap-1" data-testid="filter-method">
        <legend className="mb-1 text-xs opacity-70">方式</legend>
        {METHODS.map((option) => (
          <OptionRow key={option.value}>
            <input
              type="radio"
              name="filter-method"
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
      {method === "ror" ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            半径 r（{unitText}）
            <input type="number" min={0} step="any" value={radius} onChange={(e) => setRadius(e.target.value)} className={field} data-testid="filter-radius" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            最小の近傍数 m
            <input type="number" min={1} step={1} value={minNeighbors} onChange={(e) => setMinNeighbors(e.target.value)} className={field} data-testid="filter-min-neighbors" />
          </label>
          <p className="col-span-2 text-xs opacity-70">半径 r の中にある他の点が m 個より少ない点を消します。</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            近傍数 k
            <input type="number" min={1} step={1} value={k} onChange={(e) => setK(e.target.value)} className={field} data-testid="filter-k" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            倍率 n
            <input type="number" min={0} step="any" value={nSigma} onChange={(e) => setNSigma(e.target.value)} className={field} data-testid="filter-n-sigma" />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            探す範囲 R（{unitText}）
            <input type="number" min={0} step="any" value={searchRadius} onChange={(e) => setSearchRadius(e.target.value)} className={field} data-testid="filter-search-radius" />
          </label>
          <p className="col-span-2 text-xs opacity-70">
            k 個の近傍までの平均の距離が、全体の平均 + n × 標準偏差より大きい点を消します。探す範囲 R の既定は、点の平均の間隔の10倍です（見積もりで、実際の間隔とは違うことがあります）。
            SOR は点を2回読むので、時間が2倍かかります。
          </p>
        </div>
      )}
    </Dialog>
  );
}
