import type { CopcViewerState } from "../../state/useCopcViewer";
import { MEASURE_KIND_NAME, measurementLabelLines } from "../../state/measure";
import { coordinateUnitLabel, formatCoordinate, lengthUnitsFor } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { formatCrsLong } from "../common/crs-format";
import { ConversionBreakdownPanel } from "./ConversionBreakdownPanel";
import { DtmInfoSection } from "./DtmInfoSection";

export function LayerInfoSection({ viewer }: { viewer: CopcViewerState }) {
  const layer = viewer.selectedLayer;
  const errorMessage = viewer.status.kind === "error" ? viewer.status.message : null;
  const cloudInfo = layer?.info ?? null;
  const [displayUnit] = useDisplayUnit();
  const units = lengthUnitsFor(cloudInfo?.crs, displayUnit);
  return (
    <div className="flex flex-col gap-3 pl-[11px]">
      {layer?.measurement ? (
        <div className="flex flex-col gap-0.5 text-xs" data-testid="measure-layer-info">
          <p>
            <span className="opacity-60">名前: </span>
            {layer.name}
          </p>
          <p>
            <span className="opacity-60">種類: </span>
            計測（{MEASURE_KIND_NAME[layer.measurement.kind]}）
          </p>
          {measurementLabelLines(layer.measurement, units).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 text-xs">
          <p>
            <span className="opacity-60">ファイル名: </span>
            {layer?.name ?? "（未選択）"}
          </p>
          <p>
            <span className="opacity-60">点数: </span>
            {cloudInfo ? cloudInfo.pointCount.toLocaleString() : "―"}
          </p>
          <p>
            <span className="opacity-60">CRS: </span>
            {cloudInfo ? formatCrsLong(cloudInfo.crs) : "―"}
          </p>
          <p>
            <span className="opacity-60">バウンディングボックス: </span>
            {cloudInfo ? (
              <span className="font-mono">
                min={formatCoordinate(cloudInfo.min, units)} / max={formatCoordinate(cloudInfo.max, units)} {coordinateUnitLabel(units)}
              </span>
            ) : (
              "―"
            )}
          </p>
        </div>
      )}

      {errorMessage && (
        <p data-testid="viewer-error" className="text-xs text-error">
          {errorMessage}
        </p>
      )}


      {viewer.isBrowser && layer?.download && (
        <div className="flex items-center justify-between gap-2 rounded border border-black/10 p-2 text-xs dark:border-white/10">
          <span className="opacity-70">変換したCOPCを保存できます</span>
          <a
            href={layer.download.url}
            download={layer.download.fileName}
            data-testid="download-link"
            className="rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90"
          >
            ダウンロード
          </a>
        </div>
      )}

      {layer?.dtm && <DtmInfoSection viewer={viewer} dtm={layer.dtm} />}

      {layer?.conversionBreakdownText && (
        <ConversionBreakdownPanel text={layer.conversionBreakdownText} onCopy={viewer.copyConversionBreakdownText} />
      )}
    </div>
  );
}
