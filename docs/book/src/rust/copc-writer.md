# vendor/copc-writer と vendor/laz: ScratchFs・ADR-0019・seek の修正

[`vendor/copc-writer`](https://github.com/dOtOb9/point-cloud-viewer/tree/main/vendor/copc-writer) は crates.io の `copc-writer` 0.9.0
（`copc-core`/`copc-reader` と同じ `roteiro-gis/copc-rust` の姉妹クレート、MIT OR Apache-2.0）
に、**ファイルシステムに触れる箇所をトレイト越しに差し替える改修**を当てたものです。

経緯の全文は [`vendor/copc-writer/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/PATCH.md) にあります。

## 何をしたか

`copc-writer` はファイルシステムに3箇所で直接触れていました。

1. 点レコードを吐き出す一時ファイル（`tempfile`、読み戻しは `memmap2` でファイル
   全体をマップ）
2. octree（LOD）構築が使う一時ファイル（当時は root・partition・order の点番号の索引。
   ADR-0019 以降は、点のレコードを並べた run のファイル。下の節）
3. 出力ファイル（COPC 本体。一時名で書き、成功時だけアトミックに `rename`）

`tempfile`（OS 一時ファイル）も `memmap2`（メモリマップ）も `wasm32-unknown-unknown`
では実行時に使えないため、このままでは Web 版の変換が成立しません
（[ADR-0006 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md#追記-androidとwebでも変換する2026-09-24)）。

この3箇所を、新設した3つのトレイトにまとめました。

```rust
pub trait ScratchFs: Send + Sync {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>>;
    fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>>;
}
pub trait ScratchWriter: Write + Seek + Send + Sync {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>>;
    fn finish_output(self: Box<Self>) -> Result<()>;
}
pub trait ScratchReader: Send + Sync {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>>;
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()>;
    fn len(&self) -> Result<u64>;
}
```

実装は3つあります。

| 実装 | 用途 |
|---|---|
| `NativeScratchFs`（`native-fs` フィーチャ、既定オン） | `tempfile` + `memmap2`。M4-6 の時点では振る舞いを変えていない（下記参照。ADR-0019 で `sync_all` の省略と `open_at` の通常 read 化を入れた）。デスクトップ・Android の変換経路が使う |
| `MemoryScratchFs` | `Vec<u8>` だけの実装。単体テストと wasm32 ビルド可否の確認に使う |
| `OpfsScratchFs`（[`crates/pcv-wasm/src/opfs.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/opfs.rs)） | OPFS（Origin Private File System）上の実装。Web 版が使う |

ScratchFs を入れた時点(M4-6)では、ネイティブの出力がバイト単位で変わっていないことを回帰テスト
（`native_output_hash_matches_recorded_value`）で確認しました。
**その後 ADR-0019 でチャンクの順序が変わったため、このテストの記録ハッシュは更新してあります**(下の節)。
今このテストが守るのは「バイト列が同じ」ことではなく、「意図せず出力が変わったら気付く」ことです。

## `read_at` に変えた理由（実機不具合からの学び）

当初、`ScratchReader` は `as_bytes()`（`Result<Arc<dyn AsRef<[u8]>>>`、ファイル
全体をスライスとして返す）という API でした。ネイティブでは `mmap` なので
OS が必要な部分だけをページインしますが、**OPFS にはメモリマップ相当の API が
無い**ため、Web 版はこれを `Vec<u8>` へ丸ごと読み込む実装にせざるを得ませんでした。

数千万点規模の入力を Web 版で変換すると、一時ファイルが数 GB になり、
wasm32 のメモリ上限（実務上 4GiB 未満）を超えてメモリ確保が失敗し、
`unreachable` で変換全体が止まる不具合が実機で見つかりました。
これは [ADR-0006](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) が M4-1 で退けたはずの「メモリが点数に比例する」問題が、
Web 版という別の形で戻ってきたものです。**出力ファイルのバイト同一性だけを
確認基準にしていたため、読み込み中のメモリの使い方という別の軸の問題が
M4-6a/M4-6b の検証ではすり抜けていました。**

対処として `as_bytes` を廃止し、`read_at(offset, buf)`（範囲読み）と `len()` に
変更しました。`NativeScratchFs` は mmap 上のスライスを範囲ぶんだけコピーする形に、
`OpfsScratchFs` は `FileSystemSyncAccessHandle::read`（`at` 指定）で範囲だけを
読む形に直し、小さい読み出しが頻発する性能面の懸念には 64KiB ブロック×最大64個
（固定4MiB）の LRU ブロックキャッシュで対処しています。詳細は
[`vendor/copc-writer/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/PATCH.md) の「M4-6 追記」節を参照してください。

## ADR-0019: 点のレコードを運ぶ LOD(L3-B)

[ADR-0019](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0019-record-carrying-lod.md) で、octree の分割(`src/lod.rs`)を作り直しました。
流れとして読むときは [変換の中身](../flows/conversion.md)の 3-B を見てください。

**なぜ変えたか。** 旧方式は「点の番号」を分割し、LOD の段階も圧縮の段階も、番号を使って spill から1点ずつ取り出していました。
あるノードの点は spill の中(入力の走査線順)に散らばるので、spill が RAM(31.8 GiB)を超えると、1点ごとにディスクのページ読みになります。
計測では、0.73億点の変換で 38.6 GB の spill から約 490 GB(約13倍)を読み、圧縮のスループットが 5.5M 点/秒から 0.3M 点/秒に落ちました
(`TaskSheets/BENCH-conversion-profile.md`)。

**どう変えたか。** すべてのデータの読みを順次読みにしました。

| 部品 | 内容 |
|---|---|
| run(`lod.rs` の `Run`) | 固定幅の点レコードを並べたファイル。あるノードとその下に属する点。根の run は spill そのもの(`SpillReader::into_run`) |
| `expand_run`・`partition` | メモリ予算に収まらない run を、1回の順次読みで8つの子 run に振り分ける。親ノードの点は各子の列全体から等間隔に取る(M4-16 の規則)。分割した run はすぐ削除 |
| `build_in_memory` | 予算に収まる run は、メモリ上の `Vec<u8>` だけで残りの部分木を作る。この間は spill を読まない |
| `node_pipeline.rs` | run を処理する task の実行(1スレッドは深さ優先、`parallel-compress` 有効なら `max_concurrent_subtrees` 本のスレッドが新しい task から取る)、ノードごとの LAZ 圧縮、チャンクの書き出し(`ChunkWriter`) |
| `lod_reference.rs` | 旧方式の実装を**テスト専用**に残したもの。`lod::tests::record_builder_matches_index_reference` が、新旧が全ノードで同じ点を同じ順に選ぶことを確かめる |

パラメータは `CopcWriterParams` の `memory_budget_bytes`(既定: デスクトップ 1 GiB、Android 256 MiB、Web 64 MiB)と
`max_concurrent_subtrees`(既定: 論理 CPU 数の最大8、`parallel-compress` 無しは1)です。
1つの run は `予算 / (2 × スレッド数)` バイト以下ならメモリで仕上げます。

**出力が変わった点。** チャンクの順序がファイル内で変わります(部分木の順、スレッドが複数なら終わった順)。COPC はチャンクの順序を要求せず、hierarchy が各ノードの offset を持つので有効です。
ただしバイト単位では一致しなくなったため、`crates/pcv-convert/tests/streaming_conversion.rs` の記録ハッシュを更新しました。
ノードごとの点の集合の一致は `crates/pcv-convert/examples/compare_copc_nodes.rs` で確かめます。

**`rayon` はやめました。** ノード圧縮の並列化は標準の `std::thread` に置き換えました。`parallel-compress` は std のスレッドを有効にするフィーチャで、
`parallel-lod` は何もしない空のフィーチャとして残してあります(`pcv-convert` のフィーチャ指定が解決できるように)。
ノードごとの圧縮は、ノードごとに新しい圧縮器を作って独立に行うため、旧来の「1本の圧縮器を使い回す」逐次版とは LAZ のバイト列が異なります(M4-10。所有者が基準を「点の集合の一致」に緩めて採用)。

**メモリとディスクの上限(テストで確かめてある)。**

- `tests/heap_is_bounded.rs`: 計数アロケータで、150,000点と400,000点の入力でヒープのピークが同じ 10.5 MB(i32 のレコードを1スレッド・4スレッド、f64 のレコードを4スレッド。L3-C の後の実行結果。前は 50,000点と400,000点で 11.6 MB)。
- `tests/lod_runs_bounded.rs`: 生きている一時ファイルのバイト数が spill の約 2.1 倍を超えない(上位の段で親 run と子 run が同時に在る)。開いている一時ファイルの数が点数に比例しない。
- `tests/lod_cancel.rs`・`tests/compress_cancel.rs`: キャンセルが効く。

**速くなったか。** 渋谷4枚(30,043,046点)で旧 61.8 秒 → 新 35.2 秒(1回ずつ、他の負荷は不明)。ノードごとの点の集合は同一でした。
**3.5億・7億・10億点の再計測は未実施**です(`TaskSheets/BENCH-conversion-profile.md` の "After ADR-0019")。「10億点で何分になる」は、まだ数字がありません。

**`u64` の点番号(L3-A)について。** ADR-0019 の前に、点の番号が `u32`(約43億点)に収まらない入力のため、番号を `u64`(8バイト幅)に切り替える改修を入れました。
ADR-0019 で番号そのものを運ばなくなったため、本番の経路からは消え、旧方式のテスト専用実装(`lod_reference.rs` の `IndexWidth`)にだけ残っています。

**native の `ScratchFs` の変更。** `NativeScratchFs` の `finish_temp` は `sync_all` を呼びません(一時ファイルは、クラッシュしても残る必要が無い)。
`open_at` は mmap ではなく通常の read で順次読みします(mmap 越しの順次読みは4KBごとにページフォルトし、開発機の Windows で約 190 MB/s でした)。

## L3-C: spill と run のレコードを小さくする

ADR-0019 で run がレコードを運ぶようになったので、レコードの大きさがそのままディスクの使用量と読み書きの量になります。
`vendor/copc-writer/src/record.rs` で、レコードを**出力の COPC の点レコード(LAS の点形式 6/7)そのもの**にしました。
以前は `copc_core::serialize_le` の汎用形式で、Tokyo の点形式3(GPS時刻+RGB)で 57 B/点でした(`TaskSheets/BENCH-multi-billion.md` §3)。

| 部分 | 内容 |
|---|---|
| x, y, z | 出力と同じ scale/offset で量子化した i32 が3つ(12 B)。`SpillWriter::create` に `Option<LasTransform>` を渡したとき |
| 残り(body) | 強度・リターン番号・フラグ・分類・user data・走査角(i16)・点源 ID・GPS 時刻(f64)・RGB(あれば)・extra bytes。出力の点レコードの12バイト目以降と同じバイト列 |
| 幅 | RGB なし(点形式6)30 B、RGB あり(点形式7)36 B。extra bytes はその分を足す |
| 広い形(`None`) | x, y, z を f64 のまま(24 B)にして、RGB ありで 48 B。出力の offset を最後の点を見てから決める E57/PLY/PCD の取り込みだけが使う |

- 点は `SpillWriter::push` で1回だけ出力の形に詰める(`writer.rs` の `encode_point_record`。ノードの圧縮が以前していたのと同じ処理)。
  ノードの圧縮(`NodeContext::compress_node`)は、レコードをそのまま LAZ の圧縮器に渡します。広い形のときだけ `wide_to_output_records` で i32 にします。
- 出力の scale/offset が違う spill は `write_copc_from_spill` が拒否します(spill の整数がそのまま出力の整数になるため)。
  LAS/LAZ の変換・結合・Web の変換・抽出は、ヘッダーから作った `CopcWriteMetadata` の `transform()` を渡します。
- octree の分割で点がどの子に入るかは、保存された整数から `scale * i + offset` で戻した座標で決めます(`RecordFormat::xyz`)。
  LAS の点は出力と同じ scale/offset で読めば元の f64 とビットまで同じなので、LAS からの変換では以前と同じ決定になります。
  格子の上に無い点が、2つの子の境目から scale の半分以内にあると、以前と違う子に入ることがあります(出力は正しい COPC のままです)。
- 出力が変わらないことの確認: `tests/compact_records_match_wide.rs`(i32 の spill と f64 の spill で COPC がバイト単位で一致)と、
  渋谷4枚(30,043,046点)を旧版と新版で 1 スレッド圧縮して SHA-256 が一致したこと(`TaskSheets/BENCH-conversion-profile.md` の "after L3-C")。
- なくなったもの: `SpillReader` の `xyz_at`・`record_at`・`record_into`(1レコードの乱数アクセス。本番では使われていませんでした)と `RecordDecoder`。

## vendor/laz: 可変長チャンクの seek の修正

[`vendor/laz`](https://github.com/dOtOb9/point-cloud-viewer/tree/main/vendor/laz) は crates.io の `laz` 0.12.2 の複製に、**1箇所だけ**直しを当てたものです([`vendor/laz/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/laz/PATCH.md))。

- 場所: `src/laszip/sequential/decompression.rs` の `LasZipDecompressor::seek`。
- 問題: 目的の点を含むチャンクを見つけたあと、チャンクの中の位置を `point_idx % チャンクの点数` で求めていました。これは全チャンクの点数が同じときだけ正しい式です。
  COPC は**可変長チャンク**(laszip VLR の `chunk_size = 0xFFFFFFFF`、1ノード=1チャンクで点数が違う)なので、seek のあとに誤った点から読み始めました。
- 直し: `delta = point_idx - points_before_chunk`(目的のチャンクより前のチャンクの点数の合計を引く)。固定長のチャンクでは従来と同じ値になります。
- 症状: Web の結合・変換は、入力を点の範囲に分けて各 Worker が `las::Reader::seek(start)` します。COPC(autzen、10,653,336点)を入力にすると範囲の先頭がずれ、チャンクの末尾を越えて次のチャンクのバイト列を「レイヤーのサイズ」として読み、
  wasm32 の `Vec::resize` が `capacity overflow` で panic しました(64ビットでは `failed to fill whole buffer` のエラーで済む)。**逐次読みは最初から正しかった**ので、症状が出るのは分担展開だけです。
- 副作用の疑い(コードとテストからの推測で、内容の比較はしていない): 失敗しなかった範囲も誤った点から始まっていた可能性があり、点数は合っていても点が欠落・重複していたかもしれません。
- 回帰テスト: `crates/pcv-wasm/src/convert.rs` の `range_of_variable_chunk_copc_matches_the_same_slice_of_a_full_read`(8個の等分の範囲と6個の半端な範囲をバイト比較。パッチ前は落ち、後は通る)。
- 設定の場所: ルートの `Cargo.toml` と `crates/pcv-wasm/Cargo.toml` の**両方**の `[patch.crates-io]`(`copc-reader`・`copc-writer` と同じ。片方を忘れると、その側だけ直っていない)。
- 外せる条件: 上流の `laz` が可変長チャンクのオフセットを正しく計算するようになったとき。上のテストが `[patch.crates-io]` の `laz` 行なしで通ることを確かめてから外す。

## いつ削除するか

`PATCH.md` の「いつ削除するか」節を参照してください。この改修は上流に
取り込まれる見込みのある一般的な抽象化ではなく、本プロジェクト固有の
事情（Web 版での利用）によるものなので、当面維持する前提です。

## まず読むファイル

- [`vendor/copc-writer/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/PATCH.md) — 改修の全文と実機不具合の調査記録
- [`crates/pcv-wasm/src/opfs.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/opfs.rs) — `OpfsScratchFs` の実装
- [`vendor/copc-writer/src/lod.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/src/lod.rs)・[`node_pipeline.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/src/node_pipeline.rs) — ADR-0019 の LOD とノード圧縮
- [`vendor/laz/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/laz/PATCH.md) — seek の修正
