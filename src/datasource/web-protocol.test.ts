// web-protocol.ts のテスト。WebSourceとcopc.worker.tsの間で交わすメッセージの
// 組み立て・`open(path)`の`path`の分類ロジックは、Workerを起動しなくてもテストできる
// 純粋関数にしてある(TaskSheets/ADR-0012-web-worker-sync-io.mdの受け入れ条件)。

import { describe, expect, it } from "vitest";
import {
  buildOpenFileRequest,
  buildOpenUrlRequest,
  buildReadNodeRequest,
  classifyOpenPath,
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

  it("readNodeリクエストを組み立てる", () => {
    const req = buildReadNodeRequest(9, "2-1-0-1");
    expect(req).toEqual({ type: "readNode", id: 9, key: "2-1-0-1" });
  });
});
