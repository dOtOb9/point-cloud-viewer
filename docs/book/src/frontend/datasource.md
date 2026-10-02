# src/datasource: データの入口

`src/datasource/` は、Tauri 版と Web 版の違いをすべて閉じ込める層です。
[規約2](../conventions.md#規約2-tauri-の-api-を-import-してよいのは-srcdatasourcetaurits-だけ) により、
`@tauri-apps/api` を import してよいのは [`tauri.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/tauri.ts) だけです。
レンダラ・state・UI は [`DataSource.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/DataSource.ts) で定義されたインターフェースしか見ません。

```ts
export interface DataSource {
  fetchBench(sizeBytes: number): Promise<ArrayBuffer>;
  open(path: string, readerPoolSize?: number): Promise<OpenedCloud>;
  readNode(key: string): Promise<ArrayBuffer>;
}
```

`open` の `path` の意味は実装によって違います。`TauriSource` ではファイルシステム
パス（または Android の `content://` URI）、`WebSource` ではローカルファイルを
指す `"file:<連番>"` キーか URL です。分類は [`web-protocol.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/web-protocol.ts) の
`classifyOpenPath`（純粋関数）が行います。

## `tauri.ts`: デスクトップ・Android 実装

[`TauriSource`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/tauri.ts) は `DataSource` を実装し、`pcv://`（`convertFileSrc`）でノードを取得し、
`invoke` で `open_copc` 等の制御コマンドを呼びます。このファイルはほかにも、
ファイル選択ダイアログ（`@tauri-apps/plugin-dialog`）、更新通知で使うリリース
ページを開く処理（`@tauri-apps/plugin-opener`）、アプリバージョンの取得
（`@tauri-apps/api/app`）を持ちます。**Tauri 系のパッケージを import するのは
すべてここに閉じています。**

## `web.ts`・`copc.worker.ts`: Web 実装

[`WebSource`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/web.ts) は Tauri の npm パッケージを一切 import しません。COPC の読み込みと
変換はすべて [`copc.worker.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/copc.worker.ts) という専用の Web Worker の中で行われ、`WebSource` は
`postMessage` でメッセージをやり取りするだけです。Worker の中でなければならない
理由（`FileReaderSync`・同期 XHR が Worker 専用の API であること）は
[データの流れの章](../data-flow.md#web-worker-経路web)を参照してください。

メッセージの形は [`web-protocol.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/web-protocol.ts) に定義されており、Worker の実体や
`pcv-wasm` には依存しない「ただのデータ形と組み立てる純粋関数」だけが置かれて
います。これにより、Worker を実際に起動できない `vitest` 環境でも
メッセージの組み立てが正しいかをテストできます。

Web Worker は1本だけ生成されます（`web.ts` の `createRealWorker`）。デスクトップ版の
ようにリーダーをプールして並列読み出しする仕組みはありません（[ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md)）。

## `opfs.ts`: Web 版の変換用一時ファイル

[`opfs.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/opfs.ts) は OPFS（Origin Private File System）上の一時ファイルプールを TypeScript 側
から管理します。変換ごとに一意な一時ディレクトリ名（`crypto.randomUUID()`）を使い、
複数タブでの同時変換は Web Locks API（`navigator.locks`）で防いでいます。
これは実機不具合（`createSyncAccessHandle` の衝突）を受けて追加された仕組みで、
詳細は[落とし穴と教訓](../pitfalls.md)を参照してください。

## `node-format.ts` / `copc-dto.ts` / `conversion-dto.ts`

- [`node-format.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/node-format.ts) — `pcv-core` が決めたノードのバイナリ形式のパーサ。`magic`/`version`/
  バイト長を検証してから読み返します（[データの流れの章](../data-flow.md)参照）
- [`copc-dto.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/copc-dto.ts) — Rust 側（`CloudInfoDto`/`HierarchyNodeDto`）が JSON で返す値を、
  フロントの `CloudInfo`/`HierarchyNodeInfo` に変換します
- [`conversion-dto.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/conversion-dto.ts) — 変換の進捗・結果のイベントを同様に変換します

## `copc-header.ts`: COPC かどうかの判定（Web 版）

拡張子ではなく、ヘッダー（COPC info VLR の有無）で判定します。Rust 側の
`crates/pcv-convert/src/copc_detect.rs` と同じ考え方を、Web 版にも一貫させています。
Web 側には `las` 相当のパーサライブラリが無いため、LAS ヘッダーのバイナリ
レイアウトを自前で最小限だけ読んでいます。

## `update-check.ts`: 更新通知（デスクトップ・Android 共通）

GitHub Releases の最新版を `fetch` で確認し、新しければ知らせ、同意したときだけ
リリースページを開きます。当初はデスクトップに `tauri-plugin-updater`（署名付き
自動適用）を使う計画でしたが、所有者が署名鍵を当面作らない方針にしたため、
Android と同じこの自前方式に統一されています（[ADR-0004 の追記4](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0004-distribution-and-update.md#追記42026-09-23-当面は署名鍵を作らない)、
[配布の章](../distribution.md)）。

## まず読むファイル

- [`src/datasource/DataSource.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/DataSource.ts) — すべての実装が従うインターフェース
- [`src/datasource/tauri.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/tauri.ts) / [`web.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/web.ts) — 2つの実装
- [`src/datasource/copc.worker.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/copc.worker.ts) — Web 版の読み込み・変換の実体
