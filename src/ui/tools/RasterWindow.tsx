import { useEffect, useRef, type ReactNode } from "react";
import { changeRasterSettings, closeRasterWindow, exportRaster, fileCellSizeOf } from "../../app/raster-window";
import type { RasterPreviewImage, RasterValueKind, TiffKind } from "../../datasource/raster";
import { ELEVATION_INTENSITY_RAMP } from "../../renderer/colormap";
import { findLayer } from "../../state/layers";
import type { RasterWindow as RasterWindowHolder } from "../../state/useRasterWindow";
import type { RasterSettings } from "../../state/raster-window";
import { convertLength, formatLength, lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE, type LengthUnits } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";

// G1-R3: the Rasterize window. React only shows the state (src/state/raster-window.ts) and calls the functions of
// src/app/raster-window.ts. Left (top on a narrow screen): toggle buttons for what the raster holds, which points count,
// the cell size and the kind of GeoTIFF. Right (bottom): the preview picture, redrawn as soon as a setting changes.

const VALUE_BUTTONS: { value: RasterValueKind; label: string }[] = [
  { value: "rgbMean", label: "RGB" },
  { value: "zMean", label: "標高 平均" },
  { value: "zMin", label: "標高 最小" },
  { value: "zMax", label: "標高 最大" },
  { value: "count", label: "点数" },
  { value: "intensityMean", label: "強度" },
];

/** The tallest the preview picture may be, so a tall layer does not push the legend out of the window. */
const PREVIEW_MAX_HEIGHT = "55vh";

const CHECKERBOARD =
  "repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 50% / 16px 16px";

/** The ramp of the picture as a CSS gradient (low at the left). Same stops as the 3D view's elevation colours. */
const LEGEND_GRADIENT = `linear-gradient(to right, ${ELEVATION_INTENSITY_RAMP.map(
  (s) => `rgb(${s.color.map((c) => Math.round(c * 255)).join(",")}) ${(s.t * 100).toFixed(1)}%`,
).join(", ")})`;

function ToggleRow<T extends string>({
  title,
  options,
  value,
  onSelect,
  testIdPrefix,
}: {
  title: string;
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onSelect: (value: T) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs opacity-70">{title}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            aria-pressed={o.value === value}
            onClick={() => onSelect(o.value)}
            data-testid={`${testIdPrefix}-${o.value}`}
            className={`min-h-9 rounded border px-3 text-sm disabled:opacity-40 ${
              o.value === value ? "border-primary bg-primary text-on-primary" : "border-slate-300 hover:bg-black/5 dark:border-slate-600 dark:hover:bg-white/10"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Number text for the legend ends: heights in the display unit, counts and intensity as they are. */
function legendValue(value: number, kind: RasterValueKind, units: LengthUnits): string {
  if (kind === "count" || kind === "intensityMean") return Math.round(value).toLocaleString();
  const converted = convertLength(value, units.verticalToMeter, units.display);
  return converted === null ? `${value.toFixed(2)}（${UNKNOWN_UNIT_NOTE}）` : `${converted.toFixed(2)} ${unitSymbol(units.display)}`;
}

function PreviewCanvas({ image }: { image: RasterPreviewImage }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = image.width;
    canvas.height = image.height;
    context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0);
  }, [image]);
  return (
    <div className="overflow-hidden rounded border border-black/10 dark:border-white/10" style={{ background: CHECKERBOARD }}>
      {/* The parent column is sized to the picture, so the canvas is scaled up or down to it with CSS. */}
      <canvas
        ref={ref}
        data-testid="raster-canvas"
        className="block w-full"
        style={{ imageRendering: "pixelated", aspectRatio: `${image.width} / ${image.height}` }}
      />
    </div>
  );
}

export function RasterWindow({ viewer, holder }: { viewer: CopcViewerState; holder: RasterWindowHolder }) {
  const { state, context } = holder;
  const [display] = useDisplayUnit();
  const layer = state.layerId ? findLayer(viewer.layers, state.layerId) : undefined;
  const units = lengthUnitsFor(layer?.info.crs, display);
  const unitText = units.horizontalToMeter === null ? UNKNOWN_UNIT_NOTE : unitSymbol(display);
  const settings = state.settings;
  const change = (patch: Partial<RasterSettings>) => void changeRasterSettings(context, { ...settings, ...patch });

  const fileCell = layer ? fileCellSizeOf(layer, settings, display) : null;
  const cellCount =
    layer && fileCell
      ? Math.ceil((layer.info.max[0] - layer.info.min[0]) / fileCell + 1) * Math.ceil((layer.info.max[1] - layer.info.min[1]) / fileCell + 1)
      : null;
  const canExport = state.open && fileCell !== null && state.busy === null && !viewer.toolProgress;
  const image = state.image;

  const footer: ReactNode = (
    <>
      <button type="button" onClick={() => void closeRasterWindow(context)} className={DIALOG_TERTIARY_BUTTON_CLASS} data-testid="raster-close">
        閉じる
      </button>
      <button type="button" onClick={() => void exportRaster(context)} disabled={!canExport} className={DIALOG_PRIMARY_BUTTON_CLASS} data-testid="raster-export">
        書き出す
      </button>
    </>
  );

  return (
    <Dialog open={state.open} title="ラスタ化" onClose={() => void closeRasterWindow(context)} footer={footer} widthClass="max-w-5xl">
      <p className="text-xs opacity-70">
        対象のレイヤー: <span className="font-semibold">{layer?.name ?? "（なし）"}</span>
        。セルごとの値を画像（GeoTIFF）にします。元のレイヤーは変わりません。
      </p>
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="flex w-full shrink-0 flex-col gap-3 md:w-72">
          <ToggleRow
            title="セルの値"
            testIdPrefix="raster-value"
            value={settings.value}
            onSelect={(value) => change({ value })}
            options={VALUE_BUTTONS.map((b) => ({ ...b, disabled: b.value === "rgbMean" && !layer?.info.hasColor }))}
          />
          <ToggleRow
            title="数える点"
            testIdPrefix="raster-class"
            value={settings.groundOnly ? "ground" : "all"}
            onSelect={(v) => change({ groundOnly: v === "ground" })}
            options={[
              { value: "all", label: "すべて" },
              { value: "ground", label: "地表のみ" },
            ]}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs opacity-70">セルの大きさ（{unitText}）</span>
            <input
              type="number"
              min={0}
              step="any"
              value={settings.cellSizeText}
              onChange={(e) => change({ cellSizeText: e.target.value })}
              className="h-10 w-full rounded border border-slate-300 bg-transparent px-2 text-sm dark:border-slate-600"
              data-testid="raster-cell-size"
            />
          </label>
          {cellCount !== null && <p className="text-xs opacity-70">書き出すセルの数: 約 {cellCount.toLocaleString()}（上限を超えると、書き出すときにセルの大きさを大きくするよう案内します）</p>}
          <ToggleRow<TiffKind>
            title="書き出す TIFF"
            testIdPrefix="raster-tiff"
            value={settings.tiff}
            onSelect={(tiff) => change({ tiff })}
            options={[
              { value: "colored", label: "色付き（見たとおり）" },
              { value: "values", label: "値のまま（解析用）" },
            ]}
          />
          {state.exported?.download && (
            <a
              href={state.exported.download.url}
              download={state.exported.download.fileName}
              data-testid="raster-download-link"
              className="rounded bg-primary px-3 py-2 text-center text-sm text-on-primary hover:opacity-90"
            >
              書き出した GeoTIFF をダウンロード（{state.exported.width.toLocaleString()} x {state.exported.height.toLocaleString()} セル）
            </a>
          )}
          {state.exported && !state.exported.download && (
            <p className="text-xs" data-testid="raster-exported">
              保存しました（{state.exported.width.toLocaleString()} x {state.exported.height.toLocaleString()} セル）
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2" data-testid="raster-preview">
          {state.busy === "opening" && <p className="text-sm opacity-70">プレビュー用の点を読んでいます…</p>}
          {state.error && (
            <p className="text-sm text-error" data-testid="raster-preview-error">
              {state.error}
            </p>
          )}
          {image && (
            // One column as wide as the picture: the whole preview area, but the picture is never taller than
            // PREVIEW_MAX_HEIGHT (max width = that height x the aspect ratio). Picture, legend and note share
            // this width and the column is centred.
            <div
              className="mx-auto flex w-full flex-col gap-2"
              style={{ maxWidth: `calc(${PREVIEW_MAX_HEIGHT} * ${image.width / image.height})` }}
              data-testid="raster-preview-column"
            >
              <PreviewCanvas image={image} />
              {image.range && (
                <div className="flex flex-col gap-1" data-testid="raster-legend">
                  <div className="h-3 w-full rounded" style={{ background: LEGEND_GRADIENT }} />
                  <div className="flex justify-between text-xs">
                    <span>{legendValue(image.range.min, settings.value, units)}</span>
                    <span>{legendValue(image.range.max, settings.value, units)}</span>
                  </div>
                </div>
              )}
              <p className="text-xs opacity-70">
                プレビューは間引いた点から作っています（セルの大きさ {formatLength(image.cellSize, units.horizontalToMeter, display)}、
                {image.width.toLocaleString()} x {image.height.toLocaleString()} セル、{image.points.toLocaleString()} 点）。
                最小・最大は書き出し結果と少し違うことがあります。
                {state.session?.info.truncated ? " 点の上限に達したため、一部の層は読んでいません。" : ""}
              </p>
            </div>
          )}
          {state.busy === "rendering" && <p className="text-xs opacity-70">描き直しています…</p>}
        </div>
      </div>
    </Dialog>
  );
}
