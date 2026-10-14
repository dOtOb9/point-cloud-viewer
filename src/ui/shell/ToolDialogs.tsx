import { useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import type { LayerToolState } from "../../state/useLayerTool";
import { convertLength, lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { displayLengthToFile, heightRange } from "../../state/tool-math";
import { Dialog } from "./Dialog";
import { DIALOG_BUTTON_CLASS, DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

// L2-F: dialogs of the point-cloud tools. Both are plain forms.

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
    </Dialog>
  );
}

/** Progress of the running point-cloud tool, with a cancel button. Shown while `viewer.toolProgress` is set. */
export function ToolProgressDialog({ viewer }: { viewer: CopcViewerState }) {
  const progress = viewer.toolProgress;
  const ratio = progress && progress.totalPoints > 0 ? Math.min(1, progress.pointsRead / progress.totalPoints) : 0;
  return (
    <Dialog
      open={progress !== null}
      title="点群ツールを実行中"
      accent="secondary"
      onClose={viewer.cancelTool}
      footer={
        <button type="button" onClick={viewer.cancelTool} className={DIALOG_BUTTON_CLASS} data-testid="tool-cancel">
          キャンセル
        </button>
      }
    >
      <p className="break-words text-sm" data-testid="tool-progress-title">
        {progress?.title ?? ""}
      </p>
      {progress && progress.totalPoints > 0 ? (
        <>
          <p className="text-sm">
            読み込み中: {progress.pointsRead.toLocaleString()} / {progress.totalPoints.toLocaleString()} 点（{(ratio * 100).toFixed(1)}%）
          </p>
          <div className="h-2 w-full overflow-hidden rounded bg-tertiary/25">
            <div className="h-full w-full origin-left bg-secondary transition-transform duration-(--motion-progress) ease-linear" style={{ transform: `scaleX(${ratio})` }} />
          </div>
        </>
      ) : (
        <p className="text-sm opacity-70">準備しています…</p>
      )}
      <p className="text-xs opacity-70">書き出しの間は割合を出せません。キャンセルは読み込みの合間に効きます。</p>
    </Dialog>
  );
}
