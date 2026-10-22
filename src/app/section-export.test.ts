import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "../datasource/DataSource";
import { WebSource } from "../datasource/web";
import type { SectionInfo, ViewerLayer } from "../state/layers";
import { newHistory } from "./section-math";
import {
  exportSectionLine,
  safeFileName,
  sectionLineCsv,
  sectionLineDxf,
  sectionLineWorldPoints,
  type SectionExportContext,
} from "./section-export";

const tauri = vi.hoisted(() => ({ chooseTextDestination: vi.fn(), saveTextFile: vi.fn(async () => {}) }));
vi.mock("../datasource/tauri", () => tauri);
const download = vi.hoisted(() => ({ startDownload: vi.fn() }));
vi.mock("./download", () => download);

beforeEach(() => vi.clearAllMocks());

function section(a: [number, number, number], b: [number, number, number], up: [number, number, number] = [0, 0, 1]): SectionInfo {
  return { a, b, up, thickness: 1, sourceLayerId: "src", linePreset: "standard" } as SectionInfo;
}

describe("sectionLineWorldPoints", () => {
  it("puts X and Y on A + s * along for a 45 degree line", () => {
    const pts = sectionLineWorldPoints(section([10, 20, 5], [20, 30, 5]), new Float32Array([0, 1, 10, 2]));
    const k = Math.SQRT1_2;
    expect(pts).toHaveLength(2);
    expect(pts![0]).toMatchObject({ s: 0, z: 1, x: 10, y: 20 });
    expect(pts![1].x).toBeCloseTo(10 + 10 * k, 9);
    expect(pts![1].y).toBeCloseTo(20 + 10 * k, 9);
  });

  it("keeps millimetres at plane rectangular coordinate sizes (not f32)", () => {
    const pts = sectionLineWorldPoints(section([-12345.678, -45678.901, 30], [-12345.678 + 100, -45678.901, 30]), new Float32Array([0, 1, 50, 2]));
    expect(pts![0].x).toBe(-12345.678);
    expect(pts![0].y).toBe(-45678.901);
    expect(pts![1].x).toBeCloseTo(-12295.678, 6);
    expect(pts![1].y).toBe(-45678.901);
  });

  it("removes the up part of A->B and rejects a vertical pair", () => {
    // B is higher than A; along stays horizontal.
    const pts = sectionLineWorldPoints(section([0, 0, 0], [30, 0, 40]), new Float32Array([0, 0, 10, 0]));
    expect(pts![1].x).toBeCloseTo(10, 9);
    expect(pts![1].y).toBeCloseTo(0, 9);
    expect(sectionLineWorldPoints(section([1, 1, 0], [1, 1, 9]), new Float32Array([0, 0]))).toBeNull();
  });
});

describe("sectionLineCsv", () => {
  it("has the header, one row per point, 3 decimals and CRLF", () => {
    const pts = sectionLineWorldPoints(section([-12345.678, -45678.901, 0], [-12245.678, -45678.901, 0]), new Float32Array([0, 35.5, 25, 36.25]))!;
    const csv = sectionLineCsv(pts);
    expect(csv).toBe("s,z,X,Y\r\n0.000,35.500,-12345.678,-45678.901\r\n25.000,36.250,-12320.678,-45678.901\r\n");
    expect(csv.charCodeAt(0)).toBe("s".charCodeAt(0)); // no BOM
  });
});

describe("sectionLineDxf", () => {
  it("is R12 group code / value pairs with one VERTEX per point at (s, z)", () => {
    const pts = sectionLineWorldPoints(section([1000, 2000, 0], [1100, 2000, 0]), new Float32Array([0, 35.5, 25, 36.25, 50, 37]))!;
    const lines = sectionLineDxf(pts).split("\r\n");
    expect(lines.pop()).toBe(""); // ends with CRLF
    expect(lines.length % 2).toBe(0);
    const pairs: [string, string][] = [];
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]).toMatch(/^\d+$/); // every even line is a group code
      pairs.push([lines[i], lines[i + 1]]);
    }
    expect(pairs.slice(0, 5)).toEqual([["0", "SECTION"], ["2", "HEADER"], ["9", "$ACADVER"], ["1", "AC1009"], ["0", "ENDSEC"]]);
    expect(pairs[pairs.length - 1]).toEqual(["0", "EOF"]);
    const count = (name: string) => pairs.filter(([c, v]) => c === "0" && v === name).length;
    expect(count("SECTION")).toBe(2);
    expect(count("ENDSEC")).toBe(2);
    expect(count("POLYLINE")).toBe(1);
    expect(count("SEQEND")).toBe(1);
    expect(count("VERTEX")).toBe(3);
    // The coordinates of the vertices are (s, z), not the world X, Y.
    const xs = pairs.filter(([c]) => c === "10").slice(1).map(([, v]) => v);
    const ys = pairs.filter(([c]) => c === "20").slice(1).map(([, v]) => v);
    expect(xs).toEqual(["0.000", "25.000", "50.000"]);
    expect(ys).toEqual(["35.500", "36.250", "37.000"]);
  });
});

describe("safeFileName", () => {
  it("replaces characters a file name cannot hold", () => {
    expect(safeFileName('断面 - a/b:c*?"<>|')).toBe("断面 - a_b_c______");
  });
});

function layer(withLine: boolean): ViewerLayer {
  return {
    id: "sec",
    name: "断面/1",
    section: {
      ...section([0, 0, 0], [100, 0, 0]),
      line: withLine
        ? { original: { points: new Float32Array([0, 1, 10, 2]), groundPoints: 1, cells: 1 }, history: newHistory({ points: new Float32Array([0, 1, 10, 2]), groundPoints: 1, cells: 1 }) }
        : undefined,
    },
  } as unknown as ViewerLayer;
}

function harness(l: ViewerLayer, source: DataSource | null) {
  const errors: string[] = [];
  const ctx: SectionExportContext = {
    getSource: () => source,
    getLayersState: () => ({ layers: [l], selectedLayerId: null }),
    reportError: (m) => errors.push(m),
  };
  return { ctx, errors };
}

describe("exportSectionLine", () => {
  const fake = {} as DataSource;

  it("does nothing for a layer without a line", async () => {
    const { ctx, errors } = harness(layer(false), fake);
    await exportSectionLine(ctx, "sec", "csv");
    expect(tauri.chooseTextDestination).not.toHaveBeenCalled();
    expect(tauri.saveTextFile).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("asks where to save and writes the CSV on the desktop", async () => {
    tauri.chooseTextDestination.mockResolvedValueOnce("D:/out/x.csv");
    const { ctx } = harness(layer(true), fake);
    await exportSectionLine(ctx, "sec", "csv");
    expect(tauri.chooseTextDestination).toHaveBeenCalledWith("断面_1-断面線.csv", "CSV", "csv");
    expect(tauri.saveTextFile).toHaveBeenCalledWith("D:/out/x.csv", "s,z,X,Y\r\n0.000,1.000,0.000,0.000\r\n10.000,2.000,10.000,0.000\r\n");
  });

  it("writes nothing when the dialog is closed", async () => {
    tauri.chooseTextDestination.mockResolvedValueOnce(null);
    const { ctx, errors } = harness(layer(true), fake);
    await exportSectionLine(ctx, "sec", "csv");
    expect(tauri.saveTextFile).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("reports a failure to write", async () => {
    tauri.chooseTextDestination.mockResolvedValueOnce("D:/out/x.csv");
    tauri.saveTextFile.mockRejectedValueOnce(new Error("ディスクが一杯です"));
    const { ctx, errors } = harness(layer(true), fake);
    await exportSectionLine(ctx, "sec", "csv");
    expect(errors).toEqual(["断面線を書き出せませんでした: ディスクが一杯です"]);
  });

  it("downloads on the Web without asking", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const web = Object.create(WebSource.prototype) as DataSource;
    const { ctx } = harness(layer(true), web);
    await exportSectionLine(ctx, "sec", "csv");
    expect(tauri.chooseTextDestination).not.toHaveBeenCalled();
    expect(download.startDownload).toHaveBeenCalledWith("blob:x", "断面_1-断面線.csv");
    vi.unstubAllGlobals();
  });
});
