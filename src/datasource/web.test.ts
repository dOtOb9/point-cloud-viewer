// web.ts (WebSource) のテスト。本物のWeb Worker/wasmは起動できない(vitestの
// jsdom環境にはFileReaderSync等が無い)ので、`WorkerLike`を満たす偽物を注入して
// メッセージの送受信・リクエストIDの対応付け・エラー伝播だけを確認する
// (TaskSheets/ADR-0012-web-worker-sync-io.mdの受け入れ条件: 「Workerに依存しない
// 部分」としてのメッセージの組み立てのテスト)。

import { describe, expect, it } from "vitest";
import { WebSource, type WorkerLike } from "./web";
import type { WorkerRequest, WorkerResponse } from "./web-protocol";

/** 送られたメッセージを記録し、テストから任意のタイミングで応答を返せる偽Worker。 */
class FakeWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;

  postMessage(message: unknown): void {
    this.sent.push(message as WorkerRequest);
  }

  respond(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

function makeSource(): { source: WebSource; worker: FakeWorker } {
  const worker = new FakeWorker();
  const source = new WebSource(() => worker);
  return { source, worker };
}

describe("WebSource.open", () => {
  it("registerFileで登録したFileをopenリクエストに乗せる", async () => {
    const { source, worker } = makeSource();
    const file = new File([new Uint8Array([1, 2, 3])], "a.copc.laz");
    const key = source.registerFile(file);

    const openPromise = source.open(key);
    expect(worker.sent).toHaveLength(1);
    const req = worker.sent[0];
    expect(req.type).toBe("open");
    if (req.type !== "open") throw new Error("unreachable");
    expect(req.source).toEqual({ kind: "file", file });

    worker.respond({
      type: "open-result",
      id: req.id,
      ok: true,
      info: {
        point_count: 10,
        min: [0, 0, 0],
        max: [1, 1, 1],
        scale: [1, 1, 1],
        offset: [0, 0, 0],
        has_color: false,
      },
      nodes: [],
      bytesRead: 128,
    });

    const opened = await openPromise;
    expect(opened.info.pointCount).toBe(10);
    expect(source.getLastBytesRead()).toBe(128);
  });

  it("http(s)のURLはそのままopenリクエストのurlになる", async () => {
    const { source, worker } = makeSource();
    const openPromise = source.open("https://example.com/a.copc.laz");
    const req = worker.sent[0];
    expect(req.type).toBe("open");
    if (req.type !== "open") throw new Error("unreachable");
    expect(req.source).toEqual({ kind: "url", url: "https://example.com/a.copc.laz" });

    worker.respond({
      type: "open-result",
      id: req.id,
      ok: true,
      info: { point_count: 0, min: [0, 0, 0], max: [0, 0, 0], scale: [1, 1, 1], offset: [0, 0, 0], has_color: false },
      nodes: [],
      bytesRead: 0,
    });
    await openPromise;
  });

  it("未登録のfile:キーを渡すとWorkerに送らずに拒否する", async () => {
    const { source, worker } = makeSource();
    await expect(source.open("file:999")).rejects.toThrow(/未登録/);
    expect(worker.sent).toHaveLength(0);
  });
});

describe("WebSource.readNode", () => {
  it("応答のArrayBufferをそのまま返す", async () => {
    const { source, worker } = makeSource();
    const readPromise = source.readNode("0-0-0-0");
    const req = worker.sent[0];
    expect(req.type).toBe("readNode");

    const buffer = new ArrayBuffer(8);
    worker.respond({ type: "readNode-result", id: req.id, ok: true, buffer, bytesRead: 8 });

    expect(await readPromise).toBe(buffer);
  });

  it("エラー応答はErrorとしてrejectされる", async () => {
    const { source, worker } = makeSource();
    const readPromise = source.readNode("0-0-0-0");
    const req = worker.sent[0];

    worker.respond({ type: "error", id: req.id, ok: false, message: "boom" });

    await expect(readPromise).rejects.toThrow("boom");
  });
});

describe("WebSource: リクエストIDの対応付け", () => {
  it("複数の呼び出しが順不同で応答してもそれぞれ正しい呼び出し元に届く", async () => {
    const { source, worker } = makeSource();

    const first = source.readNode("0-0-0-0");
    const second = source.readNode("1-0-0-0");
    expect(worker.sent).toHaveLength(2);
    const [firstReq, secondReq] = worker.sent;
    expect(firstReq.id).not.toBe(secondReq.id);

    const bufferA = new ArrayBuffer(1);
    const bufferB = new ArrayBuffer(2);
    // わざと2番目のリクエストへ先に応答する。
    worker.respond({ type: "readNode-result", id: secondReq.id, ok: true, buffer: bufferB, bytesRead: 2 });
    worker.respond({ type: "readNode-result", id: firstReq.id, ok: true, buffer: bufferA, bytesRead: 1 });

    expect(await first).toBe(bufferA);
    expect(await second).toBe(bufferB);
  });
});

describe("WebSource.fetchBench", () => {
  it("Workerを介さず指定サイズのArrayBufferを返す", async () => {
    const { source, worker } = makeSource();
    const buf = await source.fetchBench(16);
    expect(buf.byteLength).toBe(16);
    expect(worker.sent).toHaveLength(0);
  });
});
