# ノードの読み込み

この章は「処理の流れ(入口つき)」の1つです。画面に出す点群のうち、COPC のノード(octree の1区画)を1つ読んでGPUに載せるまでの経路を扱います。
どのノードを欲しがるかを決める毎フレームの処理(視錐台・優先度・点予算)は「毎フレームの描画」の章、データの形は[データの流れ](../data-flow.md)の章を見てください。

## 1. 何をするか

レンダラが「このノードが欲しい」と決めたら、`NodeLoader` が同時リクエスト数を絞りながら `DataSource.readNode(cloudId, key)` を呼びます。
バックエンド(デスクトップは Tauri の `pcv://`、Web は Web Worker)が `pcv-core` の `CopcFile::read_node` でそのノードの LAZ チャンク1つだけを展開し、
「ヘッダ32バイト + 点20バイト×点数」のバイナリにして返します。フロントがそれを解析して GPU のバッファにします。

## 2. 入口

- 欲しいノードを決めて渡す側: `src/renderer/point-cloud-renderer.ts` の `renderOnce` が `NodeLoader.setWanted(selection.wanted, ...)` を呼ぶ(1フレームごと)。
- 読み込みを実際に始める側: `src/renderer/node-loader.ts` の `NodeLoader`(`setWanted` → `pump` → `startLoad`)。
- レイヤーを開いたとき、レイヤーごとに読み出し関数を作る側: `src/state/useFileOpen.ts` の `addOpenedLayer`(`readNode: (key) => source.readNode(opened.cloudId, key)`)。

## 3. 流れ

### 3-A. 共通(フロント)

1. `src/state/useFileOpen.ts` `addOpenedLayer` — `source.open(path)` で `cloudId` を受け取り、`renderer.addLayer(layerId, { readNode: ... })` に、その `cloudId` を閉じ込めた `readNode` を渡す。レンダラは `DataSource` も `cloudId` も知らない。
2. `src/renderer/point-cloud-renderer.ts` `addLayer` — レイヤーに内部の通し番号(serial)を振る(`layersBySerial`)。ノードのキーはレイヤーで名前空間を分け、`"<serial>:<ノードキー>"` にする(`src/renderer/layer-key.ts` の `layerNodeKey` / `parseLayerNodeKey`)。COPC のノードキー(`"0-0-0-0"` など)はどのファイルにもあり、複数レイヤーで衝突するためです。
3. `renderOnce` → `NodeLoader.setWanted` — 欲しいノードの集合を丸ごと入れ替える(優先度つき)。キャッシュにあるもの・取得中のものは除く。
4. `node-loader.ts` `pump` / `pickHighestPriority` / `startLoad` — 同時取得数(`maxConcurrent`)の範囲で、優先度が高い順に始める。同時数の既定は論理コア数(下限4、取れなければ8。`defaultMaxConcurrent`)。
5. `point-cloud-renderer.ts` `readLayerNode` — `"<serial>:<ノードキー>"` を分け、そのレイヤーの `readNode(nodeKey)` を呼ぶ。レイヤーがもう無ければ `StaleNodeRequestError` で捨てる。
6. `DataSource.readNode(cloudId, key)`(`src/datasource/DataSource.ts`) — ここから先は実装ごとに違う(3-B・3-C)。
7. 結果が届いたら `src/datasource/node-format.ts` `parseNodeBuffer`(ヘッダの magic / version / stride を検証し、点配列はコピーせず参照するだけ)→ `point-cloud-renderer.ts` `handleNodeLoaded` → `GpuResources.createCachedNode` → `NodeCache.set`。強度の範囲もここで広げる。
8. 失敗は `NodeLoader` の `onFailed` → `point-cloud-renderer.ts` `reportNodeLoadError` → エラー表示(ADR-0011 のバナーとログ)。

### 3-B. デスクトップ・Android(Tauri)

1. `src/datasource/tauri.ts` `TauriSource.readNode` — `buildNodeRequestPath(cloudId, key)`(`src/datasource/tauri-protocol.ts`)で `"<generation>/<level>-<x>-<y>-<z>"` を作り、`convertFileSrc(segment, "pcv")` で URL にして `fetch` する。
   Windows と Android では `http://pcv.localhost/...`、macOS と Linux では `pcv://localhost/...` の形になる。**区切りの `/` も1セグメントとしてまるごとパーセントエンコードされて届く**。
2. `src-tauri/src/lib.rs` `handle_pcv_protocol` — 非同期のスキームハンドラ。`parse_pcv_path` で**先にパーセントデコードしてから** `PcvNodeRequest { generation, key }` に解析する。重い読み出しは `tauri::async_runtime::spawn_blocking` に逃がす。
3. `src-tauri/src/copc_state.rs` `read_node_bytes(state, generation, key)` — `CopcState`(`generation` → `Arc<CopcPool>` の表)のロックは `Arc` を複製する一瞬だけ持つ。表に無い世代は `ReadNodeError::Stale`。
4. 同 `CopcPool::checkout` — プール(論理コア数ぶん開いた独立の `CopcFile`)から1本借りる。空きが無ければ `Condvar` で返却を待つ。
5. `crates/pcv-core/src/copc.rs` `CopcFile::read_node` — hierarchy の `offset` / `byte_size` へ直接 seek し、そのノードの LAZ チャンクだけを展開(`copc-reader` の `CopcReader::read_node`)。色のビット深度を8ビットに直し、`crates/pcv-core/src/node_format.rs` `encode_node` が、ノードの原点を f32 に丸めた相対座標のバイナリにする。
6. `copc_state.rs` に戻り、`file.read_node(key)` の呼び出しだけを `catch_unwind` で囲む。panic したリーダーはプールに返さず捨て、`replenish_after_panic` で開き直して補充する(ADR-0013)。`checkin` で返却。
7. `lib.rs` — 結果を HTTP 応答にする。成功は 200(`octet_stream_response`)、通常のエラーは 400(`bad_request_response`)、panic は 500(`internal_server_error_response`、本文に panic メッセージ)、古い世代は 409(`stale_generation_response`)。
   `tauri.ts` は 409 を `StaleNodeRequestError`(黙って捨てる)にし、それ以外の失敗は本文を読んでエラーメッセージにする。

ファイルを開く・閉じる側: `src/datasource/tauri.ts` `TauriSource.open` → `invoke("open_copc")` → `src-tauri/src/copc_state.rs` `open_copc`(パスなら `CopcPool::open_path`、`content://` なら `open_uri`)→ `open_copc_impl`(hierarchy と info を返し、`generation` を1つ進めて表に足す)。
`TauriSource.close` → `close_copc`(表から外すだけ。読み出し中のリクエストは `Arc` を持っているので、終わるまでハンドルは生きる)。

### 3-C. Web

1. `src/datasource/web.ts` `WebSource.readNode(cloudId, key)` — `buildReadNodeRequest`(`src/datasource/web-protocol.ts`)で `{ type: "readNode", id, key, generation: cloudId }` を作り、Worker に `postMessage`。`id` で応答と対応づける(`send` / `pending` の表)。
2. `src/datasource/copc.worker.ts` `handleRequest` → `handleReadNode(id, key, generation)` — `openFiles`(`generation` → `WasmCopcFile` の Map)から引く。無ければ `{ type: "readNode-stale" }` を返し、`WebSource` が `StaleNodeRequestError` にする。
3. `crates/pcv-wasm/src/lib.rs` `WasmCopcFile::read_node(key)` — 文字列のキーを `NodeKey` にして `pcv_core::CopcFile::read_node`(3-B の step 5 と同じコード)を呼ぶ。入力は `FileRangeReader`(ローカルファイルを `File.slice` + `FileReaderSync` で範囲読み)か `HttpRangeReader`(Range ヘッダーつきの同期 XHR)。
4. 結果の `Vec<u8>` は wasm-bindgen が既にコピー済みなので、そのまま `postMessage` の transfer で渡す(もう1回コピーしない)。`readNode-result` として戻る。

ファイルを開く側: `WebSource.open(path)`(`classifyOpenPath` でローカルファイルのキー `"file:N"` か URL かを判別。ローカルは `registerFile` で登録済みの `File`)→ `copc.worker.ts` `handleOpen`(`WasmCopcFile.openFile` / `openUrl`、`openGeneration` を進めて `openFiles` に足す)→ `open-result`。`handleClose` は `file.free()` で wasm 側のリーダーを手放す。
Web の Worker は読み出し用に1本だけで、ノード読み出しは並列にならない(ADR-0012)。

### 複数ファイルを同時に開く表(cloudId)

| 場所 | 表 | キー(= `cloudId`) | 値 |
|---|---|---|---|
| Rust(Tauri) | `src-tauri/src/copc_state.rs` の `CopcState.opened`(`HashMap<u64, Arc<CopcPool>>`) | `open_copc` が返す `generation`(`next_generation` を1ずつ進める) | そのファイルのリーダープール |
| Worker(Web) | `src/datasource/copc.worker.ts` の `openFiles`(`Map<number, WasmCopcFile>`) | `handleOpen` が返す `openGeneration` | そのファイルの `WasmCopcFile` |
| フロント(両方) | `src/state/layers.ts` のレイヤー(`cloudId` を持つ)、`point-cloud-renderer.ts` の `layersBySerial` | `cloudId`(DataSource が返す)/ serial(レンダラ内部の通し番号) | レイヤー |

`cloudId` は同じファイルを開き直すたびに新しい値になります(「古い世代を無効化する」目的には、同じファイルかどうかを区別する必要が無いため)。
`open` は他のファイルを閉じず、表に足すだけです。閉じるのは `close` だけで、`src/state/useLayers.ts` が、レイヤーを消すときに `sourceRef.current?.close(layer.cloudId)` を呼びます。
表に無い `cloudId` への読み出しは、切り替え後に届いた古いリクエストと同じく「古い世代」(Stale)として扱い、エラー表示には出さず黙って捨てます。

## 4. データの形・メモリとディスクの上限

- ノードのバイナリ: ヘッダ32バイト(`HEADER_BYTES`)+ 点20バイト(`POINT_STRIDE`)×点数。`magic`・`version`・`stride`・`flags`(色・強度・分類の有無)・ノードの原点(f32 相当)が先頭にある(`crates/pcv-core/src/node_format.rs`、`src/datasource/node-format.ts`)。
- 1ノードの点数はファイルを書いたときの `max_points_per_node`(既定100,000)が上限なので、バッファは点の総数に依存しません。
- Tauri のリーダープール: 論理コア数(`default_pool_size`)。フロントの同時リクエスト数も論理コア数で、揃えてある。超えた分はプールが `Condvar` で待たせるだけで害は無い。
  実測(`TaskSheets/ADR-0007-pcv-protocol-concurrency.md` の追記): 1ノードの読みは単スレッドで約88msから約8.7msに下がり、20論理コアで 1→114.6、20→1123.6 nodes/s と伸びた。
- 開いたファイルのハンドルは `generation` ごとに `pool_size` 本。`File::try_clone()` は使わない(複製はシーク位置を共有し、並行読みが壊れるため)。

## 5. 関連する ADR・タスクシートと落とし穴

- ADR: [ADR-0007](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md)(`pcv://` の並行)、[ADR-0003](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0003-copc-crate.md)(COPC クレートと `read_node` の直接 seek)、[ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md)、[ADR-0013](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0013-crash-visibility.md)(panic の可視化)、[ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md)。
- タスクシート: `TaskSheets/M1-point-rendering.md`、`TaskSheets/L1-multi-layer.md`(複数ファイル)、`TaskSheets/M4-import-and-conversion.md`(ファイル切り替え時の世代)。
- 落とし穴:
  - **パーセントデコードを忘れない。** v0.1.3 では区切りに `:` を使い、Rust 側がデコードしていなかったため、全ノードが「unknown pcv:// path」で失敗した。Rust のテストは `read_node_bytes` を直接呼んでいて、この壊れ方を検出できなかった。現在は区切りを `/` にし、`parse_pcv_path` が先にデコードする。
  - 「古い世代」は**エラーではない**。ファイルを切り替えた直後に届く古い応答は、バナーに出さず黙って捨てる(`StaleNodeRequestError`)。逆に、本物の失敗を Stale として握りつぶさないこと。
  - `NodeLoader.reset()`(ファイル切り替え)は取得中の Promise を止めません。結果が届いたときに「始めた時点の世代」と比べて捨てているだけです。
  - Web では `WasmCopcFile.read_node` が `bytes_read` で積算するバイト数を見れば、「ファイル全体を読んでいない」ことを確かめられます(`WebSource.getLastBytesRead`)。
