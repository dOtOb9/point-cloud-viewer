import { chooseTextDestination, saveTextFile } from "../datasource/tauri";
import type { DataSource } from "../datasource/DataSource";
import { WebSource } from "../datasource/web";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { findLayer, type LayersState, type SectionInfo } from "../state/layers";
import { sectionAlong } from "../state/tool-math";
import { startDownload } from "./download";

export type SectionExportFormat = "csv" | "dxf";

export interface SectionExportContext {
  getSource: () => DataSource | null;
  getLayersState: () => LayersState;
  reportError: (message: string, source?: GpuErrorSource) => void;
}

export interface ExportPoint {
  s: number;
  z: number;
  x: number;
  y: number;
}

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

export function sectionLineCsv(points: ExportPoint[]): string {
  const rows = points.map((p) => [p.s, p.z, p.x, p.y].map((v) => v.toFixed(3)).join(","));
  return ["s,z,X,Y", ...rows].join(EOL) + EOL;
}

export function sectionLineDxf(points: ExportPoint[]): string {
  const layer = "SECTION_LINE";
  const pairs: [number, string][] = [
    [0, "SECTION"],
    [2, "HEADER"],
    [9, "$ACADVER"],
    [1, "AC1009"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "ENTITIES"],
    [0, "POLYLINE"],
    [8, layer],
    [66, "1"],
    [10, "0.0"],
    [20, "0.0"],
    [30, "0.0"],
    [70, "0"],
  ];
  for (const p of points) {
    pairs.push([0, "VERTEX"], [8, layer], [10, p.s.toFixed(3)], [20, p.z.toFixed(3)], [30, "0.0"]);
  }
  pairs.push([0, "SEQEND"], [8, layer], [0, "ENDSEC"], [0, "EOF"]);
  return pairs.map(([code, value]) => `${code}${EOL}${value}`).join(EOL) + EOL;
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

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
    const text = format === "csv" ? sectionLineCsv(points) : sectionLineDxf(points);
    const fileName = `${safeFileName(layer.name)}-断面線.${format}`;
    if (ctx.getSource() instanceof WebSource) {
      const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/dxf";
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      startDownload(url, fileName);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
    const destination = await chooseTextDestination(fileName, format === "csv" ? "CSV" : "DXF", format);
    if (!destination) return;
    await saveTextFile(destination, text);
  } catch (e) {
    ctx.reportError(`断面線を書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`, "tool");
  }
}
