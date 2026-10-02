# pcv-wasm: Web 版のための wasm 層

`crates/pcv-wasm` は `pcv-core` を `wasm-bindgen` で包み、ブラウザの Web Worker
内で動かすための層です。wasm 固有の依存（`wasm-bindgen`/`js-sys`/`web-sys`）は
すべてここに閉じ込められており、`pcv-core` 自体には一切入っていません
（[規約1](../conventions.md)）。設計の全体像は [ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md) を参照してください。

**`pcv-wasm` はルートの Cargo ワークスペースに含まれていません**（`crates/pcv-wasm`
は独立した1クレートのワークスペースで、ルートの `Cargo.toml` が `exclude` しています）。
ビルドは `--manifest-path crates/pcv-wasm/Cargo.toml` を明示して行います
（`.github/workflows/pages.yml` 参照）。[`vendor/copc-reader`](./copc-reader.md) への
`[patch.crates-io]` もルートとは別にこちらの `Cargo.toml` に持たせており、
これを忘れると「Web 版だけ大きい COPC が開けない」という ADR-0003 と同じ不具合に
再び落ちます。

## `WasmCopcFile`: COPC の読み込み

[`src/lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/lib.rs) が公開する `wasm-bindgen` 型です。

```rust
#[wasm_bindgen]
pub struct WasmCopcFile { /* ... */ }

impl WasmCopcFile {
    pub fn open_file(file: File) -> Result<WasmCopcFile, JsValue>;
    pub fn open_url(url: String) -> Result<WasmCopcFile, JsValue>;
    pub fn info(&self) -> Result<JsValue, JsValue>;
    pub fn hierarchy(&self) -> Result<JsValue, JsValue>;
    pub fn read_node(&mut self, key: String) -> Result<Vec<u8>, JsValue>;
    pub fn bytes_read(&self) -> f64;
    pub fn total_size(&self) -> f64;
}
```

`open_file`/`open_url` の違いは、内部で渡す `Read + Seek` 実装だけです。

- [`file_reader.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/file_reader.rs) の `FileRangeReader` — ローカルファイル（`File.slice` + `FileReaderSync`）
- [`http_reader.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/http_reader.rs) の `HttpRangeReader` — URL（`Range` ヘッダー付きの同期 XHR）

どちらも `pcv_core::CopcFile<R>` にそのまま渡せ、`bytes_read()`/`total_size()` で
「ファイル全体を読んでいないこと」を実際に積算したバイト数から確認できます。
[`range_math.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/range_math.rs) は範囲計算をブラウザ API から切り離した純粋関数で、ネイティブ
ターゲットでも `cargo test` できます。

`HttpRangeReader` は `status` が 206（Partial Content）であることを確認し、
200（サーバーが Range を無視して全体を返した）ならエラーにします。黙って
全体取得にフォールバックすると「ファイルサイズに関わらず開く時間とメモリが
一定」という主張が崩れるためです。

## `WasmConverter`: Web 版での変換

[`convert.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/convert.rs) が LAS/LAZ → COPC の変換を担います。デスクトップ・Android
（[pcv-convert](./pcv-convert.md)）と違い、Web 版には変換を別スレッドで止める
手段がありません。Web Worker は1本しかなく、`SharedArrayBuffer` + `Atomics.wait`
が使えれば即座に止められますが、これには `crossOriginIsolated`（COOP/COEP
ヘッダー）が必要で、**GitHub Pages は静的ホスティングでレスポンスヘッダーを
カスタマイズできない**ため使えません。

そこで読み込み段階を TypeScript 側から `feed()` というバッチ単位で駆動し、
バッチの合間に Worker のイベントループへ制御を返すことで、その隙間でだけ
キャンセル要求を処理できるようにしています。**読み込み段階のキャンセルは
実質的に即座に効きますが、後処理段階（octree 構築・チャンク圧縮・書き出し、
`finish()`）は `copc-writer` 本体の1回の同期呼び出しで、途中では止められません。**

[`FileRangeReader` を直接 `las::Reader` に渡すと変換が極端に遅くなる不具合](../pitfalls.md)が
実機で見つかり、`std::io::BufReader`（4MiB）で包むよう修正されています。
詳細は [`TaskSheets/M4-import-and-conversion.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M4-import-and-conversion.md) の「M4-6b 追記」を参照してください。

## `opfs.rs`: OPFS 上の一時ファイル

[`opfs.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/opfs.rs) が `copc_writer::ScratchFs` の OPFS 実装（`OpfsScratchFs`）です。
詳細は [vendor/copc-writer の章](./copc-writer.md)を参照してください。ここで特筆すべきは
プール方式です。

OPFS で新しいファイルを開く操作（`getFileHandle`・`createSyncAccessHandle`）は
どちらも非同期ですが、`copc-writer` の octree 構築は同期呼び出しの中で
`ScratchFs::create_temp` をデータ依存で数千〜数万回呼びます。そこで、変換を
始める前に固定個数（既定600、`OPFS_SCRATCH_POOL_SIZE`）の OPFS 一時ファイルを
あらかじめ非同期に開いておき、`OpfsScratchFs` はその配列から「空いている
ハンドルを借りる／返す」という同期操作だけで `create_temp` を実装しています。

## `alloc_guard.rs`: メモリ確保失敗の可視化

[`alloc_guard.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/alloc_guard.rs) は `std::alloc::System` を薄くラップした `#[global_allocator]` で、
メモリ確保が失敗した瞬間に `console.error` へメッセージを出します。wasm の
メモリ確保失敗は通常何のメッセージも残さず `unreachable` で止まるため、
数千万点の入力で実際に起きたメモリ不足を切り分けるために追加されました
（[落とし穴と教訓](../pitfalls.md)参照）。

## まず読むファイル

- [`crates/pcv-wasm/src/lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/lib.rs) — `WasmCopcFile` の公開 API
- [`crates/pcv-wasm/src/convert.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/convert.rs) — Web 版の変換とキャンセルの制約
- [`TaskSheets/ADR-0012-web-worker-sync-io.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md) — なぜ Worker + 同期 I/O なのか
