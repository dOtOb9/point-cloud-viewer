import { describe, expect, it } from "vitest";
import type { NodeReader } from "../datasource/DataSource";
import { StaleNodeRequestError } from "../datasource/stale-node-error";
import { NODE_HEADER_BYTES, NODE_MAGIC, NODE_POINT_STRIDE, NODE_VERSION } from "../datasource/node-format";
import { NodeLoader } from "./node-loader";

function makeEmptyNodeBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(NODE_HEADER_BYTES);
  const view = new DataView(buffer);
  for (let i = 0; i < NODE_MAGIC.length; i++) {
    view.setUint8(i, NODE_MAGIC.charCodeAt(i));
  }
  view.setUint32(4, NODE_VERSION, true);
  view.setUint32(8, 0, true);
  view.setUint32(12, NODE_POINT_STRIDE, true);
  return buffer;
}

class FakeDataSource implements NodeReader {
  readonly requestedKeys: string[] = [];
  private readonly pending = new Map<
    string,
    { resolve: (buffer: ArrayBuffer) => void; reject: (error: unknown) => void }
  >();

  readNode(key: string): Promise<ArrayBuffer> {
    this.requestedKeys.push(key);
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
  }

  resolve(key: string, buffer: ArrayBuffer): void {
    const entry = this.pending.get(key);
    if (!entry) throw new Error(`readNode("${key}")はまだ呼ばれていない`);
    this.pending.delete(key);
    entry.resolve(buffer);
  }

  reject(key: string, error: unknown): void {
    const entry = this.pending.get(key);
    if (!entry) throw new Error(`readNode("${key}")はまだ呼ばれていない`);
    this.pending.delete(key);
    entry.reject(error);
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

interface Harness {
  dataSource: FakeDataSource;
  loader: NodeLoader;
  loaded: string[];
  failed: string[];
}

function makeHarness(maxConcurrent = 4): Harness {
  const dataSource = new FakeDataSource();
  const loaded: string[] = [];
  const failed: string[] = [];
  const loader = new NodeLoader(
    dataSource,
    (key) => loaded.push(key),
    (key) => failed.push(key),
    maxConcurrent,
  );
  return { dataSource, loader, loaded, failed };
}

describe("NodeLoader: ファイル切り替え時の不具合の修正", () => {
  it("(a) 切り替え前に始まった読み込みが切り替え後に成功しても、キャッシュに入らない", async () => {
    const { dataSource, loader, loaded, failed } = makeHarness();

    loader.setWanted([{ key: "old-file-node", priority: 1 }], () => false);
    expect(dataSource.requestedKeys).toEqual(["old-file-node"]);

    loader.reset();

    dataSource.resolve("old-file-node", makeEmptyNodeBuffer());
    await flushMicrotasks();

    expect(loaded).toEqual([]);
    expect(failed).toEqual([]);
  });

  it("(b) 切り替え前に始まった読み込みが切り替え後に失敗しても、エラーとして報告されない", async () => {
    const { dataSource, loader, loaded, failed } = makeHarness();

    loader.setWanted([{ key: "old-file-node", priority: 1 }], () => false);
    loader.reset();

    dataSource.reject("old-file-node", new Error("ノードキー old-file-node はこのファイルのhierarchyに存在しない"));
    await flushMicrotasks();

    expect(loaded).toEqual([]);
    expect(failed).toEqual([]);
  });

  it("(c) 切り替え後の新しい要求は普通に処理される", async () => {
    const { dataSource, loader, loaded, failed } = makeHarness();

    loader.setWanted([{ key: "old-file-node", priority: 1 }], () => false);
    loader.reset();

    loader.setWanted([{ key: "new-file-node", priority: 1 }], () => false);
    expect(dataSource.requestedKeys).toEqual(["old-file-node", "new-file-node"]);

    dataSource.resolve("new-file-node", makeEmptyNodeBuffer());
    await flushMicrotasks();

    expect(loaded).toEqual(["new-file-node"]);
    expect(failed).toEqual([]);

    dataSource.reject("old-file-node", new Error("stale"));
    await flushMicrotasks();

    expect(loaded).toEqual(["new-file-node"]);
    expect(failed).toEqual([]);
  });

  it("maxConcurrentの枠は切り替え後すぐに空く（古いinFlightを引きずらない）", async () => {
    const { dataSource, loader, loaded } = makeHarness(1);

    loader.setWanted([{ key: "old-file-node", priority: 1 }], () => false);
    expect(loader.loadingCount).toBe(1);

    loader.reset();
    expect(loader.loadingCount).toBe(0);

    loader.setWanted([{ key: "new-file-node", priority: 1 }], () => false);
    expect(dataSource.requestedKeys).toEqual(["old-file-node", "new-file-node"]);

    dataSource.resolve("new-file-node", makeEmptyNodeBuffer());
    await flushMicrotasks();
    expect(loaded).toEqual(["new-file-node"]);
  });

  it("裏側が検出した古い世代(StaleNodeRequestError)は、フロントの世代が同じでもエラー報告しない", async () => {
    const { dataSource, loader, failed } = makeHarness();

    loader.setWanted([{ key: "x", priority: 1 }], () => false);
    dataSource.reject("x", new StaleNodeRequestError("x"));
    await flushMicrotasks();

    expect(failed).toEqual([]);
  });
});
