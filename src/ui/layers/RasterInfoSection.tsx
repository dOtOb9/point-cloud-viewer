import { saveRasterGeoTiff } from "../../app/point-cloud-tools";
import type { RasterValueKind } from "../../datasource/tools";
import type { ViewerLayer } from "../../state/layers";
import { formatLength, lengthUnitsFor } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import type { CopcViewerState } from "../../state/useCopcViewer";

// G1: what the layer info says about a raster layer (made by the Rasterize tool), and how to get its GeoTIFF.

const VALUE_NAMES: Record<RasterValueKind, string> = {
  zMean: "高さ（Z）の平均",
  zMax: "高さ（Z）の最大",
  zMin: "高さ（Z）の最小",
  count: "点数（密度）",
  intensityMean: "強度の平均",
  rgbMean: "色（RGB）の平均",
};

/** Cell size, value, grid size, and the GeoTIFF (desktop: a save button, Web: a download link). Null for other layers. */
export function RasterInfoSection({ viewer, layer }: { viewer: CopcViewerState; layer: ViewerLayer }) {
  const [displayUnit] = useDisplayUnit();
  const raster = layer.raster;
  if (!raster) return null;
  const units = lengthUnitsFor(layer.info.crs, displayUnit);
  const { path, download } = raster.geotiff;
  return (
    <div className="flex flex-col gap-1 rounded border border-black/10 p-2 text-xs dark:border-white/10" data-testid="raster-info">
      <p>
        <span className="opacity-60">ラスタ: </span>
        {VALUE_NAMES[raster.value]}
        {raster.groundOnly ? "（地表のみ）" : ""}
      </p>
      <p>
        <span className="opacity-60">セルの大きさ: </span>
        {formatLength(raster.cellSize, units.horizontalToMeter, displayUnit)}
        <span className="ml-3 opacity-60">大きさ: </span>
        {raster.width.toLocaleString()} x {raster.height.toLocaleString()} セル
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="opacity-70">GeoTIFF</span>
        {download ? (
          <a
            href={download.url}
            download={download.fileName}
            data-testid="raster-download-link"
            className="rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90"
          >
            ダウンロード
          </a>
        ) : path && !viewer.isBrowser ? (
          <button
            type="button"
            onClick={() => void saveRasterGeoTiff(viewer.toolContext, layer.id)}
            data-testid="raster-save"
            className="rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90"
          >
            保存
          </button>
        ) : null}
      </div>
    </div>
  );
}
