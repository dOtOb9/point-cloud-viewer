# src/datasource: データの入口

`src/datasource/` は、Tauri 版と Web 版の違いをすべて閉じ込める層です。
[規約2](../conventions.md#規約2-tauri-の-api-を-import-してよいのは-srcdatasourcetaurits-だけ) により、
`@tauri-apps/api` を import してよいのは [`tauri.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/tauri.ts) だけです。
レンダラ・state・UI は [`DataSource.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/DataSource.ts) で定義されたインターフェースしか見ません。

```ts
export interface DataSource {
  open(path: string): Promise<OpenedCloud>;
  prepareToOpen(items: string[] | File[], options: PrepareOptions): Promise<PrepareOutcome>;
  cancelConversion(): void;
  readNode(cloudId: number, key: string): Promise<ArrayBuffer>;
  close(cloudId: number): Promise<void>;
}
```

### prepareToOpen: 開く前の準備

選んだファイルを「`open` に渡せる COPC」にする操作です。COPC ならそのまま、そうでなければ変換（複数 LAS/LAZ は結合）します。
Web とデスクトップで同じことをするので、`src/app/open-files.ts` は `instanceof` で分けずにこれを呼びます。
**変換が要るときも、この呼び出しの中で終わり、終わってから結果を返します**（R11。「変換開始 → 後で完了イベントが開き直す」往復は無い）。
`options`（`PrepareOptions`）は `tempDir`・`isMobile` に加えて、変換が本当に始まったとき1回呼ばれる `onConverting` と、進捗の `onProgress` を持ちます。
結果の `PrepareOutcome` は次の3つです。
- `ready { path, conversion }` — `open` に渡せるパス／キー。変換したときだけ `conversion`（`ConversionResult`: レイヤー名・`platform`・元の形式・段階ごとの秒数・警告・Web のダウンロード用 URL）が入る。
- `failed { summary, details }` — `summary` はパネル、`details` はエラーログ。変換の失敗もここ。
- `cancelled` — 利用者が変換を止めた。

`WebSource` は `File` を受けて OPFS で変換し（`tempDir` は使わない）、Worker の `convert-done` / `convert-failed` を要求 id ごとに待ちます。
`TauriSource` はイベントを先に購読してから Rust のコマンドを呼び（`isMobile` は使わない）、完了／失敗イベントを待ちます。
`cancelConversion()` は走っている変換を止める合図です（走っていなければ何もしない）。
`ConversionOutcome` から `PrepareOutcome` への変換と文言は `prepare-outcome.ts` です（[ファイルを開く](../flows/open-file.md)）。

### cloudId: 複数のファイルを同時に開く

`open` は**他に開いているファイルを閉じません**（複数同時に開ける）。返る `OpenedCloud` の `cloudId` が「開いたファイルの識別子」で、
`readNode` と `close` に渡します。Tauri では Rust 側の世代番号が、Web では Worker の表のキーが `cloudId` です。
`close(cloudId)` はリーダー（Tauri: ファイルハンドルのプール、Web: Worker の wasm リーダー）を手放します。
閉じたあとの `readNode`、および古い世代宛ての要求は `StaleNodeRequestError`（`stale-node-error.ts`。Tauri では HTTP 409）になり、
呼び出し側（`NodeLoader`）が**黙って捨てます**。知らない `cloudId` を `close` してもエラーにしません。

renderer は `cloudId` を知りません。`src/app/open-files.ts` の `addOpenedLayer` が
`readNode: (key) => source.readNode(opened.cloudId, key)` と `cloudId` を閉じ込めた関数にして renderer に渡します
（`NodeReader` インターフェース、`DataSource.ts`）。ファイルを閉じるのは `useLayers.ts` の `removeLayer`（[レイヤー操作](../flows/layers.md)）。

`open` の `path` の意味は実装によって違います。`TauriSource` ではファイルシステム
パス（または Android の `content://` URI）、`WebSource` ではローカルファイルを
指す `"file:<連番>"` キーか URL です。分類は [`web-protocol.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/web-protocol.ts) の
`classifyOpenPath`（純粋関数）が行います。

### 点群ツールの API（`tools.ts`）

選択・断面・結合は、**選んだレイヤーのファイルから新しい COPC を作る**関数です（元は書き換えない。ADR-0018）。
型は [`tools.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/tools.ts) にあり、デスクトップ（`tauri.ts`）と Web（`web.ts`）で同じ形です。

- `ExtractFilter` — `ScreenPolygonFilter`（画面上の多角形と `viewProj`。多角形の中に映り、カメラの手前にある点）または `OrientedBoxFilter`（断面の板）。座標はファイルの実座標（f64）。
- `extractToCopc(path, filter, options)` — フィルターに合う点だけを新しい COPC にする。点が 0 なら「選んだ範囲に点がありません」で失敗（Rust 側のエラー文をそのまま画面に出す）。
  デスクトップは `tauri.ts` の関数（Tauri コマンド `extract_copc`）、Web は `WebSource.extractToCopc`（Worker + OPFS）。
- `mergeCopcs(paths, options)` — 開いている複数の COPC を一つにする（デスクトップ `merge_copcs`、Web `WebSource.mergeCopcs`）。CRS が無いファイルは通し、理由を `warnings` で返す。CRS が違えば失敗。
- `ToolResult` — `outputPath`（そのまま `DataSource.open()` に渡せる）・`pointCount`・`warnings`（エラーログへ）。`ToolOptions` — 進捗コールバックと一時フォルダ。

これらを呼ぶのは `src/state/usePointCloudTools.ts` です。デスクトップでは変換と同じ `conversion-progress` イベントで進捗が来るため、
変換側が取り違えないよう `toolRunningRef` で区別しています。

## `tauri.ts`: デスクトップ・Android 実装

[`TauriSource`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/tauri.ts) は `DataSource` を実装し、`pcv://`（`convertFileSrc`）でノードを取得し、
`invoke` で `open_copc`・`close_copc` 等の制御コマンドを呼びます。ノードの URL は
`"<cloudId>/<level>-<x>-<y>-<z>"`（`tauri-protocol.ts` の `buildNodeRequestPath`）を `convertFileSrc` に渡して作ります。
このファイルはほかにも次を持ちます。**Tauri 系のパッケージを import するのはすべてここに閉じています。**

- ファイル選択・ドロップ: UI や state が呼ぶ入口は `file-picker.ts` の `pickFilesToOpen`・`onFilesDroppedToOpen`（Web と Tauri を切り替える）。Tauri 側の実体は `pickLocalFiles`（複数選択）・`onFilesDropped`（OS のドロップ）・`pickTempDirectory`
- 変換: `startLasConversion`・`startMultiLasConversion`・`cancelLasConversion`、進捗・完了・失敗のイベント購読 `onConversionProgress`／`onConversionDone`／`onConversionFailed`
- 点群ツール: `extractToCopc`・`mergeCopcs`（下の「点群ツールの API」）
- バックエンドのコンソールへの報告 `reportToBackendConsole`、アプリバージョンの取得 `getAppVersion`、更新通知で使うリリースページを開く処理

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

ノード読み出し用の Web Worker は1本だけ生成されます（`web.ts` の `createRealWorker`）。デスクトップ版の
ようにリーダーをプールして並列読み出しする仕組みはありません（[ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md)）。
変換の読み込み段階だけは、メモリを共有しない LAZ 展開専用 Worker（`laz-decompress.worker.ts`。範囲分割は `decompress-partition.ts`）を複数立てて並列化します（SharedArrayBuffer が使えないため）。

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

## `source-format.ts`: 変換経路の振り分け（Web 版）

`isCopcFile`（ヘッダー）は「変換が要るか」を、`detectSourceFormatByName`（拡張子。大文字小文字を区別しない。Rust の `detect_format` と同じ考え方）は
「どの変換経路に回すか」（`lasLaz`／`pcd`／`ply`／`e57`／`unknown`）を決めます。PCD を LAS/LAZ の見積もりに回して
「空き容量が足りません」と誤判定した実機不具合から分けられました。呼ぶのは `WebSource.prepareToOpen`（`openFiles`（`src/app/open-files.ts`）から。[ファイルを開く](../flows/open-file.md)）。

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
