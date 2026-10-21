import type { DtmFormat } from "../../../state/dtm-setting";
import type { TiffKind } from "../../../datasource/raster";
import { useDtmOutput } from "../../../state/useDtmOutput";
import { OptionRow } from "../../dialogs/OptionRow";
import { SettingsPageDialog, type PageProps } from "../SettingsPageDialog";

const FORMAT_LABELS: Record<DtmFormat, string> = {
  geotiff: "GeoTIFF",
  landxml: "LandXML",
  both: "両方",
};

const TIFF_LABELS: Record<TiffKind, string> = {
  colored: "色付き（RGBA 8bit。そのまま画像として見られる）",
  values: "値のまま（float32。標高の数値。解析用）",
};

/** G1-T15: which DTM files the DTM tool makes (owner's answer Q18: chosen here, not in the DTM dialog). */
export function DtmOutputDialog(page: PageProps) {
  const [output, setOutput] = useDtmOutput();
  return (
    <SettingsPageDialog {...page} title="DTM の出力">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">出力するファイル</legend>
        {(Object.keys(FORMAT_LABELS) as DtmFormat[]).map((f) => (
          <OptionRow key={f}>
            <input
              type="radio"
              name="dtm-format"
              data-testid={`dtm-format-${f}`}
              value={f}
              checked={output.format === f}
              onChange={() => setOutput({ ...output, format: f })}
              className="h-5 w-5 accent-primary"
            />
            {FORMAT_LABELS[f]}
          </OptionRow>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">GeoTIFF の種類</legend>
        {(Object.keys(TIFF_LABELS) as TiffKind[]).map((k) => (
          <OptionRow key={k} disabled={output.format === "landxml"}>
            <input
              type="radio"
              name="dtm-tiff"
              data-testid={`dtm-tiff-${k}`}
              value={k}
              checked={output.tiff === k}
              disabled={output.format === "landxml"}
              onChange={() => setOutput({ ...output, tiff: k })}
              className="h-5 w-5 accent-primary"
            />
            {TIFF_LABELS[k]}
          </OptionRow>
        ))}
      </fieldset>
      <p className="text-xs opacity-60">
        DTM ツールが作るファイルの形式。GeoTIFF は格子（セルの中心の標高）、LandXML は三角形の網（TIN）そのもの。
        点の数が多い範囲では LandXML は大きくなる。Web 版で LandXML を作るときは、範囲の上限が小さくなる。
      </p>
    </SettingsPageDialog>
  );
}
