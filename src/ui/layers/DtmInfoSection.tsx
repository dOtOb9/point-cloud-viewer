import { saveDtmFile } from "../../app/point-cloud-tools";
import type { DtmFile, DtmInfo } from "../../datasource/dtm";
import { convertLength, lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useDisplayUnit } from "../../state/useDisplayUnit";

const FILE_NAMES = { geotiff: "GeoTIFF", landxml: "LandXML" } as const;

/** One DTM file: a download link on the Web, a "save" button on desktop (the file is in the temp folder until then). */
function DtmFileRow({ viewer, file, kind }: { viewer: CopcViewerState; file: DtmFile; kind: keyof typeof FILE_NAMES }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="opacity-70">{FILE_NAMES[kind]}（{file.fileName}）</span>
      {file.downloadUrl !== null ? (
        <a
          href={file.downloadUrl}
          download={file.fileName}
          data-testid={`dtm-download-${kind}`}
          className="rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90"
        >
          ダウンロード
        </a>
      ) : (
        <button
          type="button"
          onClick={() => void saveDtmFile(viewer.toolContext, file, kind)}
          data-testid={`dtm-save-${kind}`}
          className="rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90"
        >
          保存…
        </button>
      )}
    </div>
  );
}

/**
 * G1-T15: the layer info of a layer made by the DTM tool: the grid, the counts, and the DTM files (save buttons on
 * desktop, download links on the Web). The files stay until the layer is removed or the app is closed.
 */
export function DtmInfoSection({ viewer, dtm }: { viewer: CopcViewerState; dtm: DtmInfo }) {
  const [display] = useDisplayUnit();
  const layer = viewer.selectedLayer;
  const units = lengthUnitsFor(layer?.info.crs, display);
  const cell = convertLength(dtm.cellSize, units.horizontalToMeter, display);
  const cellText = cell === null ? `${dtm.cellSize}（${UNKNOWN_UNIT_NOTE}）` : `${Math.round(cell * 1000) / 1000} ${unitSymbol(display)}`;
  return (
    <div className="flex flex-col gap-2 rounded border border-black/10 p-2 text-xs dark:border-white/10" data-testid="dtm-info">
      <div className="flex flex-col gap-0.5">
        <p>
          <span className="opacity-60">DTM のセル: </span>
          {cellText}（{dtm.width.toLocaleString()} 列 × {dtm.height.toLocaleString()} 行）
        </p>
        <p>
          <span className="opacity-60">地表の点: </span>
          {dtm.groundPoints.toLocaleString()}
        </p>
        <p>
          <span className="opacity-60">三角形の網: </span>
          頂点 {dtm.tinPoints.toLocaleString()} / 三角形 {dtm.tinTriangles.toLocaleString()}
        </p>
      </div>
      {dtm.geotiff && <DtmFileRow viewer={viewer} file={dtm.geotiff} kind="geotiff" />}
      {dtm.landxml && <DtmFileRow viewer={viewer} file={dtm.landxml} kind="landxml" />}
    </div>
  );
}
