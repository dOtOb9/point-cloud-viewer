// G2-T17: write the section line (the line the panel shows) as CSV or DXF. Pure text builders plus one workflow function.
// Desktop: ask where to save, then the Tauri command writes the text. Web: a Blob download.
// Rule: nothing in src/app/ imports React or a `use*` hook (TaskSheets/ADR-0021-thin-react.md).
//
// Coordinates: the line is `(s, z)` in the file's unit. `z` is the ABSOLUTE height along `up` (profile.rs `project` is
// `dot(p, up)`, no origin subtracted), the same value the panel's GL label shows, so it is written as it is. X and Y
// are `A + s * along` in f64; the file's unit is kept (no m / ft conversion).
import { chooseTextDestination, saveTextFile } from "../datasource/tauri";
import type { DataSource } from "../datasource/DataSource";
import { WebSource } from "../datasource/web";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { findLayer, type LayersState, type SectionInfo } from "../state/layers";
import { sectionAlong } from "../state/tool-math";
import { startDownload } from "./download";

export type SectionExportFormat = "csv";

/** What the workflow needs (a subset of the section view context). */
export interface SectionExportContext {
  getSource: () => DataSource | null;
  getLayersState: () => LayersState;
  reportError: (message: string, source?: GpuErrorSource) => void;
}

/** One point of the exported line. */
export interface ExportPoint {
  s: number;
  z: number;
  x: number;
  y: number;
}

/** `(s, z)` pairs -> `(s, z, X, Y)`. Null when A and B are on one vertical line (no direction). */
export function sectionLineWorldPoints(section: SectionInfo, pairs: Float32Array): ExportPoint[] | null {
  const axes = sectionAlong(section.a, section.b, section.up);
  if (axes === null) return null;
  const { along } = axes;
  const out: ExportPoint[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const s = pairs[i];
    out.push({ s, z: pairs[i + 1], x: section.a[0] + s * along[0], y: section.a[1] + s * along[1] });
  }
  return out;
}

const EOL = "\r\n";

/** CSV: header `s,z,X,Y`, one row per point, 3 decimals, CRLF, no BOM. */
export function sectionLineCsv(points: ExportPoint[]): string {
  const rows = points.map((p) => [p.s, p.z, p.x, p.y].map((v) => v.toFixed(3)).join(","));
  return ["s,z,X,Y", ...rows].join(EOL) + EOL;
}

/** Replace characters a file name cannot hold. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

/** The step of the panel's buttons: export the line of layer `layerId` in `format`. Failures go to the error log. */
export async function exportSectionLine(ctx: SectionExportContext, layerId: string, format: SectionExportFormat): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  const section = layer?.section;
  const pairs = section?.line?.history.present.points;
  if (!layer || !section || !pairs) return;
  try {
    const points = sectionLineWorldPoints(section, pairs);
    if (points === null) {
      ctx.reportError("断面線を書き出せません: 2点が同じ鉛直線上にあります", "tool");
      return;
    }
    const text = sectionLineCsv(points);
    const fileName = `${safeFileName(layer.name)}-断面線.${format}`;
    if (ctx.getSource() instanceof WebSource) {
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      startDownload(url, fileName);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
    const destination = await chooseTextDestination(fileName, "CSV", format);
    if (!destination) return; // the dialog was closed
    await saveTextFile(destination, text);
  } catch (e) {
    ctx.reportError(`断面線を書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`, "tool");
  }
}
