// web-protocol.ts のテスト。WebSourceとcopc.worker.tsの間で交わすメッセージの
// 組み立て・`open(path)`の`path`の分類ロジックは、Workerを起動しなくてもテストできる
// 純粋関数にしてある(TaskSheets/ADR-0012-web-worker-sync-io.mdの受け入れ条件)。

import { describe, expect, it } from "vitest";
import {
  buildConvertCancelRequest,
  buildConvertMultiStartRequest,
  buildConvertStartRequest,
  buildExtractStartRequest,
  buildRasterStartRequest,
  buildToolMergeStartRequest,
  buildOpenFileRequest,
  buildOpenUrlRequest,
  buildPointFileConvertStartRequest,
  buildReadNodeRequest,
  classifyOpenPath,
  DEFAULT_MAX_POINTS_PER_NODE,
  makeFileKey,
} from "./web-protocol";

describe("classifyOpenPath", () => {
  it("makeFileKeyが作るキーをfile種別として分類する", () => {
    const key = makeFileKey(3);
    expect(key).toBe("file:3");
    expect(classifyOpenPath(key)).toEqual({ kind: "file", fileKey: "file:3" });
  });

  it("http(s)のURLをurl種別として分類する", () => {
    expect(classifyOpenPath("https://example.com/a.copc.laz")).toEqual({
      kind: "url",
      url: "https://example.com/a.copc.laz",
    });
    expect(classifyOpenPath("http://example.com/a.copc.laz")).toEqual({
      kind: "url",
      url: "http://example.com/a.copc.laz",
    });
  });
});

describe("makeFileKey", () => {
  it("連番ごとに異なるキーを作る(登録したFileの取り違えを防ぐ)", () => {
    expect(makeFileKey(0)).toBe("file:0");
    expect(makeFileKey(1)).toBe("file:1");
    expect(makeFileKey(0)).not.toBe(makeFileKey(1));
  });
});

describe("buildOpenFileRequest / buildOpenUrlRequest / buildReadNodeRequest", () => {
  it("openリクエスト(file)を組み立てる", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "test.copc.laz");
    const req = buildOpenFileRequest(7, file);
    expect(req).toEqual({ type: "open", id: 7, source: { kind: "file", file } });
  });

  it("openリクエスト(url)を組み立てる", () => {
    const req = buildOpenUrlRequest(8, "https://example.com/x.copc.laz");
    expect(req).toEqual({
      type: "open",
      id: 8,
      source: { kind: "url", url: "https://example.com/x.copc.laz" },
    });
  });

  it("readNodeリクエストを組み立てる(世代番号込み。ファイル切り替え時の不具合の修正)", () => {
    const req = buildReadNodeRequest(9, "2-1-0-1", 3);
    expect(req).toEqual({ type: "readNode", id: 9, key: "2-1-0-1", generation: 3 });
  });
});

describe("buildConvertStartRequest / buildConvertCancelRequest", () => {
  it("既定のmaxPointsPerNodeでconvertStartリクエストを組み立てる", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "raw.laz");
    const req = buildConvertStartRequest(10, file, false);
    expect(req).toEqual({
      type: "convertStart",
      id: 10,
      file,
      maxPointsPerNode: DEFAULT_MAX_POINTS_PER_NODE,
      isMobile: false,
    });
  });

  it("maxPointsPerNodeを明示的に指定できる", () => {
    const file = new File([new Uint8Array([1])], "raw.las");
    const req = buildConvertStartRequest(11, file, false, 5_000);
    expect(req.maxPointsPerNode).toBe(5_000);
  });

  it("isMobileをそのまま伝える(M4-11: モバイルでは展開用Workerの数を抑える)", () => {
    const file = new File([new Uint8Array([1])], "raw.las");
    const req = buildConvertStartRequest(13, file, true);
    expect(req.isMobile).toBe(true);
  });

  it("convertCancelリクエストを組み立てる", () => {
    const req = buildConvertCancelRequest(12);
    expect(req).toEqual({ type: "convertCancel", id: 12 });
  });
});

// M4-14: 複数のLAS/LAZを選択したときの変換開始リクエスト。
describe("buildConvertMultiStartRequest", () => {
  it("複数のFileをまとめたconvertMultiStartリクエストを組み立てる", () => {
    const files = [
      new File([new Uint8Array([1])], "a.las"),
      new File([new Uint8Array([2])], "b.laz"),
    ];
    const req = buildConvertMultiStartRequest(30, files, false);
    expect(req).toEqual({
      type: "convertMultiStart",
      id: 30,
      files,
      maxPointsPerNode: DEFAULT_MAX_POINTS_PER_NODE,
      isMobile: false,
    });
  });

  it("isMobile・maxPointsPerNodeを明示的に指定できる", () => {
    const files = [new File([new Uint8Array([1])], "a.las")];
    const req = buildConvertMultiStartRequest(31, files, true, 5_000);
    expect(req.isMobile).toBe(true);
    expect(req.maxPointsPerNode).toBe(5_000);
  });
});

// M4-9追記(TaskSheets/M4-import-and-conversion.md): PCD→COPC変換の開始リクエスト。
describe("buildPointFileConvertStartRequest", () => {
  it("pointFileConvertStartリクエストを組み立てる", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cloud.pcd");
    const req = buildPointFileConvertStartRequest(20, [file], ["pcd"], false);
    expect(req).toEqual({
      type: "pointFileConvertStart",
      id: 20,
      files: [file],
      formats: ["pcd"],
      maxPointsPerNode: DEFAULT_MAX_POINTS_PER_NODE,
      isMobile: false,
    });
  });

  it("passes the formats through (PLY and E57 use the same request)", () => {
    const file = new File([new Uint8Array([1])], "scan.e57");
    expect(buildPointFileConvertStartRequest(22, [file], ["e57"], false).formats).toEqual(["e57"]);
    expect(buildPointFileConvertStartRequest(23, [file], ["ply"], false).formats).toEqual(["ply"]);
  });

  it("carries several files with one format each (M4-17 merge, LAS/LAZ included)", () => {
    const files = [new File([new Uint8Array([1])], "a.las"), new File([new Uint8Array([1])], "b.ply")];
    const req = buildPointFileConvertStartRequest(24, files, ["lasLaz", "ply"], false);
    expect(req.files).toEqual(files);
    expect(req.formats).toEqual(["lasLaz", "ply"]);
  });

  it("isMobileとmaxPointsPerNodeを明示的に指定できる", () => {
    const file = new File([new Uint8Array([1])], "cloud.pcd");
    const req = buildPointFileConvertStartRequest(21, [file], ["pcd"], true, 5_000);
    expect(req.isMobile).toBe(true);
    expect(req.maxPointsPerNode).toBe(5_000);
  });
});

describe("点群ツールのリクエスト(L2-C)", () => {
  it("extractStartに条件とラベルを載せる", () => {
    const file = new File([new Uint8Array([1])], "a.copc.laz");
    const filter = {
      kind: "orientedBox" as const,
      center: [1, 2, 3] as [number, number, number],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as [[number, number, number], [number, number, number], [number, number, number]],
      halfExtents: [1, 1, 1] as [number, number, number],
    };
    expect(buildExtractStartRequest(5, file, filter, "抽出: a")).toEqual({
      type: "extractStart",
      id: 5,
      file,
      filter,
      label: "抽出: a",
    });
  });

  it("rasterStartにファイルと設定を載せる (G1)", () => {
    const file = new File([new Uint8Array([1])], "a.copc.laz");
    const options = { cellSize: 2, value: "zMean", groundOnly: true } as const;
    expect(buildRasterStartRequest(4, file, options, "ラスタ化: a")).toEqual({
      type: "rasterStart",
      id: 4,
      file,
      options,
      label: "ラスタ化: a",
    });
  });

  it("toolMergeStartに複数ファイルを載せる", () => {
    const a = new File([new Uint8Array([1])], "a.copc.laz");
    const b = new File([new Uint8Array([2])], "b.copc.laz");
    expect(buildToolMergeStartRequest(6, [a, b], false, "合成")).toEqual({
      type: "toolMergeStart",
      id: 6,
      files: [a, b],
      isMobile: false,
      label: "合成",
    });
  });
});
