import { useState } from "react";
import { rasterizeLayer } from "../../app/point-cloud-tools";
import type { RasterValueKind } from "../../datasource/tools";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { displayLengthToFile } from "../../state/tool-math";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";
import { selectedPointCloudLayer } from "../toolbar/toolbar-state";

// G1: the Rasterize dialog (a plain form), opened from the toolbar button. Same structure as SectionDialog.

const VALUE_OPTIONS: { value: RasterValueKind; label: string }[] = [
  { value: "zMean", label: "高さ（Z）の平均" },
  { value: "zMax", label: "高さ（Z）の最大" },
  { value: "zMin", label: "高さ（Z）の最小" },
  { value: "count", label: "点数（密度）" },
  { value: "intensityMean", label: "強度の平均" },
  { value: "rgbMean", label: "色（RGB）の平均" },
];

/**
 * Rasterize: cell size, what each cell holds, and which points count. The cell size is typed in the display unit
 * (settings, "単位"; default m) and converted to the file's unit with the layer's CRS factor. If the file's unit is
 * unknown the number is taken as the file's unit (same rule as the cross-section dialog).
 */
export function RasterDialog({ viewer, open, onClose }: { viewer: CopcViewerState; open: boolean; onClose: () => void }) {
  // Mounted only while open, so the fields start from the defaults each time.
  if (!open) return null;
  return <RasterDialogBody viewer={viewer} onClose={onClose} />;
}

function RasterDialogBody({ viewer, onClose }: { viewer: CopcViewerState; onClose: () => void }) {
  const [display] = useDisplayUnit();
  const layer = selectedPointCloudLayer(viewer);
  const units = lengthUnitsFor(layer?.info.crs, display);
  const unitText = units.horizontalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(display);
  // RGB is offered only when the layer has colour (a layer without colour would give a flat grey picture).
  const options = VALUE_OPTIONS.filter((o) => o.value !== "rgbMean" || layer?.info.hasColor);

  const [cellSize, setCellSize] = useState("1");
  const [value, setValue] = useState<RasterValueKind>("zMean");
  const [groundOnly, setGroundOnly] = useState(false);

  const size = Number(cellSize);
  const valid = layer !== null && cellSize.trim() !== "" && Number.isFinite(size) && size > 0;

  // How many cells the grid would have (the tool refuses a grid over its cap and says so).
  const fileCell = valid ? displayLengthToFile(size, units.horizontalToMeter, display) : null;
  const cellCount =
    layer && fileCell
      ? Math.ceil((layer.info.max[0] - layer.info.min[0]) / fileCell + 1) * Math.ceil((layer.info.max[1] - layer.info.min[1]) / fileCell + 1)
      : null;

  const confirm = () => {
    if (!valid || !layer || fileCell === null) return;
    onClose();
    void rasterizeLayer(viewer.toolContext, layer.id, { cellSize: fileCell, value, groundOnly });
  };

  const field = "h-10 w-full rounded border border-slate-300 bg-transparent px-2 text-sm dark:border-slate-600";
  return (
    <Dialog
      open
      title="ラスタ化"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={DIALOG_TERTIARY_BUTTON_CLASS}>
            キャンセル
          </button>
          <button type="button" onClick={confirm} disabled={!valid} className={DIALOG_PRIMARY_BUTTON_CLASS} data-testid="raster-confirm">
            実行
          </button>
        </>
      }
    >
      <p className="text-xs opacity-70">
        対象のレイヤー: <span className="font-semibold">{layer?.name ?? "（なし）"}</span>
        。セルごとの値を GeoTIFF にし、確認用に1セル1点の新しいレイヤーを作ります（元のレイヤーは変わらず、非表示になります）。
      </p>
      <label className="flex flex-col gap-1 text-sm">
        セルの大きさ（{unitText}）
        <input type="number" min={0} step="any" value={cellSize} onChange={(e) => setCellSize(e.target.value)} className={field} data-testid="raster-cell-size" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        セルの値
        <select value={value} onChange={(e) => setValue(e.target.value as RasterValueKind)} className={field} data-testid="raster-value">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        数える点
        <select value={groundOnly ? "ground" : "all"} onChange={(e) => setGroundOnly(e.target.value === "ground")} className={field} data-testid="raster-classes">
          <option value="all">すべての点</option>
          <option value="ground">地表のみ（分類 2）</option>
        </select>
      </label>
      {cellCount !== null && <p className="text-xs opacity-70">セルの数: 約 {cellCount.toLocaleString()}（上限を超えると、実行時にセルの大きさを大きくするよう案内します）</p>}
    </Dialog>
  );
}
