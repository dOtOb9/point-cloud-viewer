# pcv-wasm: Web 版のための wasm 層

`crates/pcv-wasm` は `pcv-core` を `wasm-bindgen` で包み、ブラウザの Web Worker
内で動かすための層です。wasm 固有の依存（`wasm-bindgen`/`js-sys`/`web-sys`）は
すべてここに閉じ込められており、`pcv-core` 自体には一切入っていません
（[規約1](../conventions.md)）。設計の全体像は [ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md) を参照してください。

**`pcv-wasm` はルートの Cargo ワークスペースに含まれていません**（`crates/pcv-wasm`
は独立した1クレートのワークスペースで、ルートの `Cargo.toml` が `exclude` しています）。
ビルドは `--manifest-path crates/pcv-wasm/Cargo.toml` を明示して行います
（`.github/workflows/pages.yml` 参照）。[`vendor/copc-reader`](./copc-reader.md) への
`[patch.crates-io]`(`copc-reader`・`copc-writer`・`laz` の3つ)もルートとは別にこちらの `Cargo.toml` に持たせており、
どれかを忘れると「Web 版だけ大きい COPC が開けない」(ADR-0003)や、分担展開の seek のずれ(`vendor/laz`)といった不具合に
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

`WasmConverter` の使い方は、`new` → (`feed` を繰り返す、または `push_serialized_records` で分担展開の結果を受ける) → `finish` です。
複数ファイルの結合は、`new` の後に `set_declared_totals`(全入力の合計点数・サイズで上書き)と `open_next_file`(読み元だけを次のファイルに切り替える。spill は1本のまま。点のレイアウトと CRS の一致を `check_layout_and_crs_match` が確かめる)を使います。
`inspect_las_header_summary` は、変換を始める前に TypeScript 側が全ファイルのヘッダーだけを読むための関数です。
`finish` は結果の DTO(`FinishResultDto`)に、段階ごとの所要時間と警告(CRS が無いファイルを通した旨など)を入れて返します。

### 分担展開: `LazRangeDecompressor`

デスクトップは `rayon` で LAZ の展開を並列にしていますが、Web 版では `rayon` が使えません(`SharedArrayBuffer` に必要な `crossOriginIsolated` が GitHub Pages では得られない)。
代わりに `convert.rs` の `LazRangeDecompressor` を、独立した Web Worker(`src/datasource/laz-decompress.worker.ts`)で複数動かします。

- `new(file, start_index, count)` — 自分専用の `las::Reader` を開き、担当範囲の先頭まで `seek` する。**この `seek` は `vendor/laz` のパッチに依存します**([vendor/copc-writer と vendor/laz の章](./copc-writer.md))。
- `feed(batch_size)` — そのバッチ分だけを `copc_core::serialize_le` でシリアライズして返す。呼び出し側(`copc.worker.ts` の `runParallelReadPhase`)が、届いたバッチを変換用の `WasmConverter::push_serialized_records` に渡して**すぐ捨てる**。
  未消費のバッチ数は `BoundedBatchFlow`(`src/datasource/decompress-partition.ts`)で数えて上限を付ける(pull 型・背圧)。同時に抱える量は点数に比例しません。
- Worker 間の点の順序は到着順になります。`SpillWriter::push` の順序が変わっても、検証と統計が1点ごとに閉じているため、点の集合は変わりません(`crates/pcv-wasm/tests/parallel_push_order_point_set.rs`)。

### `WasmExtractor`: 点の選択・断面の書き出し(L2-C)

[`src/extract.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/extract.rs) の `WasmExtractor` は、`pcv_core::extract::ExtractPoints`(読み側)と `SpillWriter` →
`write_copc_from_spill_with_fs_and_timings`(書き側、OPFS)をつなぎます。`new`(条件の JSON を `ExtractFilter` に読む)→ `feed` を繰り返す → `finish` で、`WasmConverter` と同じ形です。
0点のときは `finish` が「選んだ範囲に点がありません」で失敗します。`finish` の間はキャンセルできません。

### `WasmRasterizer`: ラスタ化(G1)

[`src/raster.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/raster.rs) の `WasmRasterizer` は、デスクトップの `pcv-convert/src/raster.rs` と同じ仕事です。
`feed` が2段階で、前半は点を読んで格子に足し、後半は空でないセルを spill に書きます(どちらもバッチごとに Worker がイベントループへ戻るので、キャンセルが効く)。
`geotiff()` が GeoTIFF のバイト列を返し(Worker が `tool-done` で本体に**転送**する)、`finish()` が表示用 COPC を OPFS に書きます(この間はキャンセルできない)。
セル数の上限は `MAX_CELLS_WEB`。コンストラクタが、点を1つも読む前に断ります。

### `WasmPointFileConverter`: PLY・PCD・E57 の取り込みと、形式をまたぐ結合(R7・M4-17)

[`src/point_file_import.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/point_file_import.rs) の `WasmPointFileConverter` は、
LAS/LAZ 以外の形式(PLY・PCD・E57)を直接 spill に流す変換で、**ファイルの配列**を受け取ります。1件なら単一ファイルの変換、複数件なら順に1本の spill へ流します。
`new(formats, files, ...)` / `totalPoints` / `feed` / `finish` の形は `WasmConverter` と同じなので、Worker のバッチループは1件でも複数件でも同じです。
LAZ のような分担展開は無く、逐次の `feed` のみです。

仕事は2つのファイルに分かれています。

- [`src/point_merge.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/point_merge.rs)(ブラウザに依存しない。`cargo test` が合成データで動かす)
  - `PointStream`: 開いた1ファイル。「次の点を1つ返す」だけが形式ごとに違います(`PlyStream`・`PcdStream`・`E57Stream`・`LasStream`)。
    `enum` にしたのは4種類しかなく、メソッドが4本の `match` で済むからです(トレイトオブジェクトにしない)。
  - `plan_merge`: **最初の点を読む前に**全ファイルのヘッダーから出力を決めます(1つでも色があれば出力は色あり、CRS の食い違いはエラー、警告文の組み立て)。
    spill の形(色の有無)は spill を作る時点で決まっている必要があるためです。
  - `MergedPoints`: ファイルを名前順に1つずつ開いて、点を1本の流れにします。色の無いファイルの点は、出力に色があれば灰色 `[32768, 32768, 32768]` にします(読み元ごとではなく、この結合の層で塗ります)。
- `point_file_import.rs`: `File` と OPFS と spill をつなぐ層(`MergedPoints` を `feed` で読んで `SpillWriter` に書く)。

ヘッダーを読む段階(ヘッダーパス)は `new` の中で行います。全ファイルを一度開いてヘッダーを読み、先頭のファイルだけ開いたまま残します
(1件だけの変換でファイルを2度開かないため)。残りは閉じ、順番が来たときにもう一度開くので、同時に開いているのは常に1ファイルです。
`LasStream` が持つ点は最大4096点で、メモリは点数に比例しません。

LAS/LAZ を含む結合では、x・y・z・色・強度だけを引き継ぎます(分類・GPS時刻・リターン番号などは出力に入らないため、警告を出します)。
LAS/LAZ だけの選択はこの経路を通らず、従来の `WasmConverter::open_next_file` の結合が使われます(あちらは属性をすべて残すため)。

以前は PCD 専用の `WasmPcdConverter` クラスがありましたが、読み元の `PcdStream` に縮めて、この1つのクラスにまとめました(使われなくなったクラスと Worker の分岐を残さないため)。
PLY・PCD・E57 の読み込みは `crates/pcv-convert/src/import/` を**意図的に複製**しています(`pcv-wasm` は別ワークスペースで、`pcv-convert` に依存すると `rayon` が wasm32 のビルドに混入するため)。

E57 の `e57` クレートは、点を返すイテレータが `E57Reader` を借用します。`feed` の呼び出しをまたいでイテレータを持つには
自己参照になるため、`E57Stream` は reader を `Box::into_raw` で生ポインタにし、`Drop` で「イテレータ、reader」の順に解放します
(`unsafe` は `open_scan` と `Drop` の2か所だけ)。イテレータを毎回作り直して読み済みの点を飛ばす案は、先頭から再展開するため点数の2乗に
なるので採りませんでした。1回の呼び出しで全部変換する案は、Worker がキャンセルのメッセージを受け取れないので採りませんでした。

## `opfs.rs`: OPFS 上の一時ファイル

[`opfs.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/opfs.rs) が `copc_writer::ScratchFs` の OPFS 実装（`OpfsScratchFs`）です。
詳細は [vendor/copc-writer の章](./copc-writer.md)を参照してください。ここで特筆すべきは
プール方式です。

OPFS で新しいファイルを開く操作（`getFileHandle`・`createSyncAccessHandle`）は
どちらも非同期ですが、`copc-writer` の octree 構築は同期呼び出しの中で
`ScratchFs::create_temp` をデータ依存で数千〜数万回呼びます。そこで、変換を
始める前に固定個数（`OPFS_SCRATCH_POOL_SIZE`、下記）の OPFS 一時ファイルを
あらかじめ非同期に開いておき、`OpfsScratchFs` はその配列から「空いている
ハンドルを借りる／返す」という同期操作だけで `create_temp` を実装しています。

プールの個数は `OPFS_SCRATCH_POOL_SIZE` = **256** です(`opfs.rs`)。根拠は、octree の最大の深さ(30)での同時に開くファイル数の理論上限 `8×(30+1)+1 = 249` に約3割の余裕を見た値で、
`crates/pcv-wasm/tests/sequential_lod_open_files_bounded.rs` で深さごとの実測が上限内に収まることを確かめています。
ただしこの根拠は ADR-0019 の**前**の LOD(点番号の索引)の数え方で書かれています。ADR-0019 後の run ファイルでも同時数が点数に比例しないことは
`vendor/copc-writer/tests/lod_runs_bounded.rs` で確かめていますが、256 が今の方式の上限として十分かは、実ブラウザでは確かめていません。

読み出し側は `ReadCache`(64KiB × 最大64個 = 4MiB 固定)で、OPFS への小さな `read` の往復を抑えています。`ScratchReader` は `read_at`(範囲読み)だけで、ファイル全体をメモリに載せません。

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
