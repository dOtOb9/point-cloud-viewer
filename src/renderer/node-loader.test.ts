// node-loader.ts のテスト。
//
// ファイル切り替え時の不具合の修正（TaskSheets/M4-import-and-conversion.md参照）:
// COPCを開いたあとに別のファイルを開くと、切り替え前に投げたノード要求が
// 「今開いているファイル」に対して処理されてしまい、(1) 存在しないキーで
// 読み出しエラーが出る、(2) 運悪くキーが両方のファイルに存在すると前のファイルの
// 点が新しいファイルのキャッシュに紛れ込む、という2つの不具合が起きていた。
//
// `NodeLoader.reset()`（ファイルを開くたびに呼ぶ）が世代カウンタを進め、
// 世代をまたいで届いた結果（成功・失敗どちらも）を黙って捨てるようにして直した。
// ここでは`readNode()`の応答タイミングを自由に操作できる偽の`DataSource`を使い、
// 受け入れ条件の3点をそのまま確認する:
//   (a) 切り替え前に始まった読み込みが切り替え後に成功しても、キャッシュに入らない
//       （onLoadedが呼ばれない）
//   (b) 切り替え前に始まった読み込みが切り替え後に失敗しても、エラーとして
//       報告されない（onFailedが呼ばれない）
//   (c) 切り替え後の新しい要求は普通に処理される
// 加えて、裏側（Tauri/Web）が検出した古い世代（`StaleNodeRequestError`）も、
// フロント自身の世代カウンタの状態に関わらず黙って捨てることを確認する。

import { describe, expect, it } from "vitest";
import type { DataSource, OpenedCloud } from "../datasource/DataSource";
import { StaleNodeRequestError } from "../datasource/stale-node-error";
import { NODE_HEADER_BYTES, NODE_MAGIC, NODE_POINT_STRIDE, NODE_VERSION } from "../datasource/node-format";
import { NodeLoader } from "./node-loader";

/** parseNodeBuffer()が受理する最小のノードバッファ（点数0、ヘッダのみ）。 */
function makeEmptyNodeBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(NODE_HEADER_BYTES);
  const view = new DataView(buffer);
  for (let i = 0; i < NODE_MAGIC.length; i++) {
    view.setUint8(i, NODE_MAGIC.charCodeAt(i));
  }
  view.setUint32(4, NODE_VERSION, true);
  view.setUint32(8, 0, true); // pointCount
  view.setUint32(12, NODE_POINT_STRIDE, true); // stride
  return buffer;
}

/**
 * `readNode()`の応答タイミングをテストから自由に操作できる偽の`DataSource`。
 * キーごとにPromiseの`resolve`/`reject`を保持しておき、テストが好きなときに
 * `resolve(key, ...)`/`reject(key, ...)`を呼んで応答を返す
 * （本物のTauri/Web実装の「fetch/postMessageの応答がいつ届くか分からない」を
 * 模している）。
 */
class FakeDataSource implements DataSource {
  readonly requestedKeys: string[] = [];
  private readonly pending = new Map<
    string,
    { resolve: (buffer: ArrayBuffer) => void; reject: (error: unknown) => void }
  >();

  async fetchBench(): Promise<ArrayBuffer> {
    throw new Error("このテストでは使わない");
  }

  async open(): Promise<OpenedCloud> {
    throw new Error("このテストでは使わない");
  }

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

/** `.then()/.catch()/.finally()`のチェーンが実行されるまでマイクロタスクを流す。 */
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

    // ファイルを切り替える（`resetForNewFile()`相当）。
    loader.reset();

    // 切り替え前に投げたリクエストが、切り替え後になって成功で返ってくる
    // （裏側が新しいファイルに対して処理してしまった、または単に遅延して
    // 届いたケースの両方を表す）。
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

    // 切り替え後、新しいファイルのノードを要求する。
    loader.setWanted([{ key: "new-file-node", priority: 1 }], () => false);
    expect(dataSource.requestedKeys).toEqual(["old-file-node", "new-file-node"]);

    dataSource.resolve("new-file-node", makeEmptyNodeBuffer());
    await flushMicrotasks();

    expect(loaded).toEqual(["new-file-node"]);
    expect(failed).toEqual([]);

    // 古いリクエストが後から失敗で返ってきても、新しい要求の結果には影響しない。
    dataSource.reject("old-file-node", new Error("stale"));
    await flushMicrotasks();

    expect(loaded).toEqual(["new-file-node"]);
    expect(failed).toEqual([]);
  });

  it("maxConcurrentの枠は切り替え後すぐに空く（古いinFlightを引きずらない）", async () => {
    const { dataSource, loader, loaded } = makeHarness(1); // 同時1本に絞る

    loader.setWanted([{ key: "old-file-node", priority: 1 }], () => false);
    expect(loader.loadingCount).toBe(1);

    loader.reset();
    expect(loader.loadingCount).toBe(0); // reset()でinFlightも空になる

    loader.setWanted([{ key: "new-file-node", priority: 1 }], () => false);
    // maxConcurrent=1でも、古いリクエストの完了を待たずに新しい要求が始まる。
    expect(dataSource.requestedKeys).toEqual(["old-file-node", "new-file-node"]);

    dataSource.resolve("new-file-node", makeEmptyNodeBuffer());
    await flushMicrotasks();
    expect(loaded).toEqual(["new-file-node"]);
  });

  it("裏側が検出した古い世代(StaleNodeRequestError)は、フロントの世代が同じでもエラー報告しない", async () => {
    const { dataSource, loader, failed } = makeHarness();

    // resetを呼ばない(=フロント自身の世代カウンタはまだ進んでいない)狭い競合の窓を
    // 模している。裏側(Tauri/Web)だけが「今開いているファイルと世代が違う」と
    // 判定したケース(src/datasource/stale-node-error.tsのドキュメント参照)。
    loader.setWanted([{ key: "x", priority: 1 }], () => false);
    dataSource.reject("x", new StaleNodeRequestError("x"));
    await flushMicrotasks();

    expect(failed).toEqual([]);
  });
});
