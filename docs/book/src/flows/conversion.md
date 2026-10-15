# 変換の中身(LAS/LAZ・PCD → COPC)

この章は「処理の流れ(入口つき)」の1つです。リファクタリングの前に
「どこから呼ばれて、どの順に何をするか」を見失わないための地図として書いています。
各クレートの背景は [pcv-convert](../rust/pcv-convert.md)・[vendor/copc-writer](../rust/copc-writer.md)・
[pcv-wasm](../rust/pcv-wasm.md)・[src-tauri](../rust/tauri-backend.md) の章を見てください。

## 1. 何をするか

生の点群(LAS/LAZ、E57/PLY/PCD、複数の LAS/LAZ)を、ビューアが開ける COPC(`*.copc.laz`)にします。
元のファイルは書き換えません。変換結果は別のファイルとして作り、そのまま新しいレイヤーとして開きます。

全点をメモリに載せると数億点で足りなくなる(M4-1 の素朴な実装は約62バイト/点で、3.64億点なら約22GBと見積もられて不採用)ため、
ディスクの一時ファイル(spill と run)を使う out-of-core の作りです。

## 2. 入口

| 場所 | 最初に呼ばれるもの |
|---|---|
| デスクトップ・Android の単一ファイル | `src-tauri/src/conversion.rs` の `start_las_conversion`(Tauri コマンド) |
| デスクトップの複数ファイル(LAS/LAZ を1つにまとめる) | 同 `start_multi_las_conversion` |
| Web の LAS/LAZ | `src/datasource/web.ts` の `WebSource.startConversion` → `src/datasource/copc.worker.ts` の `handleConvertStart` |
| Web の複数ファイル | `WebSource.startMultiConversion` → `copc.worker.ts` の `handleConvertMultiStart` |
| Web の PCD | `WebSource.startPcdConversion` → `copc.worker.ts` の `handlePcdConvertStart` |

画面側の呼び出し元は `src/state/useFileOpen.ts` です(`startLasConversion`・`startMultiLasConversion`・`source.startConversion` などを呼ぶ)。
進捗・完了・失敗の受け取りは `src/state/useConversionSession.ts` です。

## 3. 流れ

変換の本体は、デスクトップも Web も同じ `vendor/copc-writer` を使います。違うのは「入力を読んで spill に書くところ」と「一時ファイルの置き場所」です。

### 3-A. デスクトップ・Android

1. `src-tauri/src/conversion.rs` `start_las_conversion` — パスか `content://` URI かを振り分けて `decide_and_start` を呼ぶ。
2. 同 `decide_and_start` — 次を順に確かめ、変換が要るときだけ別スレッドを起こす。
   - `pcv_convert::cache::fingerprint_of_file` と `copc_detect::is_copc_reader`: 既に COPC なら `AlreadyCopc` を返して終わり。
   - `output_path::resolve_output_path`: 出力先(元ファイルの隣、書けなければアプリのキャッシュ)。
   - `cache::needs_reconversion`: 変換済みなら `Cached` を返して終わり。
   - `resolve_spill_dir` と `redirect_os_temp_dir`: 一時ファイルの置き場所を決め、`std::env::temp_dir()` も同じ場所に向ける(copc-writer が OS の一時領域を使うため)。
   - `disk_space::free_bytes_at` / `has_enough_free_space`: 入力の約11倍の空きが無ければ `InsufficientSpace`。
3. 同 `run_conversion_thread` — 拡張子で経路を選ぶ(`import::detect_format`)。LAS/LAZ は `pcv_convert::streaming::convert_and_timings`、E57/PLY/PCD は `pcv_convert::import::convert_to_copc_and_timings`。
   進捗は `conversion-progress` イベント、完了は `conversion-done`、失敗は `conversion-failed`。
4. `crates/pcv-convert/src/streaming.rs` `convert_and_timings` — `las::Reader` を作り、ヘッダーから `StreamingLayout`(`copc_core`)と出力メタデータ(`write_metadata::copc_write_metadata_from_source_header`)を作る。点を1バッチずつ読む `BatchedLasPoints`(イテレータ)を作る。
5. `vendor/copc-writer/src/writer.rs` `write_streaming_with_cancel_and_timings` — イテレータの点を1点ずつ `SpillWriter::push` で一時ファイル(spill)に書く。ここまでが「読み込み」段階で、`push` が座標の範囲検査と bbox・点数の集計も行う(2回目の全点パスは無い)。
6. `vendor/copc-writer/src/spill.rs` `SpillWriter::finalize` — spill を閉じて `SpillReader` にする。
7. `writer.rs` `write_copc_from_spill`(`write_copc_from_spill_with_fs` から呼ばれる非公開の本体) — 出力ファイルのヘッダー・VLR を書き、`SpillReader::into_run` で spill を LOD の根の run にして `RunTask`(キーは根)を作る。
8. `vendor/copc-writer/src/node_pipeline.rs` `write_chunks` → `run_tasks` — run を順に処理する(次の節)。
9. `writer.rs` に戻り、`hierarchy_pages.rs` の `plan_hierarchy_pages`・`write_hierarchy_page_tree` で hierarchy EVLR を書き、COPC info を埋め戻して `finish_output`(一時名から本来の名前へ rename)。

### 3-B. LOD の分割(ADR-0019 の新方式、step 8 の中身)

`vendor/copc-writer/src/node_pipeline.rs` の `NodeContext::run_task` が1つの run(あるノードとその下に属する点のレコードを並べたファイル)を処理します。

1. `vendor/copc-writer/src/lod.rs` `expand_run` — run がメモリ予算に収まるか(`LodParams::fits_in_memory`)を見る。
2. 収まらないとき(`Expanded::Split`): `lod.rs` `partition` が run を**頭から順に1回だけ読み**、各点のレコードを8つの子 run のファイルへ追記する。
   親ノードに残す点は各子オクタントの列全体から等間隔に取る(`Picker`。M4-16 で決めた規則)。親の取り分の数は先に数えた点数から決める(`decide_selected_counts`)。
   子 run の「子自身の8分割ごとの点数」は書きながら数えておく(`RunTask::counts`)ので、数え直しの読みは根の run だけ。
   分割し終えた親 run のファイルは、その場で削除される(`drop(run)`)。
3. 収まるとき(`Expanded::FitsInMemory`): `lod.rs` `read_run` で run を丸ごとメモリに読み、`build_in_memory` で残りの部分木をメモリ上の `Vec<u8>` だけで作る。ノードを1つ作るたびに `emit` で渡す。
4. `node_pipeline.rs` `NodeContext::compress_node` — ノードのレコードを LAS の点形式に詰め直し(`writer.rs` の `encode_point_record`)、そのノード1つを独立した LAZ チャンクに圧縮する(`compress_standalone_chunk`)。
5. `node_pipeline.rs` `ChunkWriter::push` — チャンクを出力に追記し、hierarchy の項目と LAZ のチャンクテーブルを作る。COPC はチャンクの順序を要求せず、hierarchy が各ノードの offset を持つため、順序は部分木ごと(複数スレッドなら終わった順)でよい。
6. スレッド数: `run_tasks_inline`(1スレッド、深さ優先)か、`parallel-compress` フィーチャ有効時の `threaded::run_tasks_threaded`(`max_concurrent_subtrees` 本。新しい task から取る=スタック)。
   デスクトップは有効、Web は無効(`crates/pcv-wasm` は `default-features = false`)。

なぜ「点の番号」ではなく「点のレコード」を運ぶのか: 旧方式は点の番号を分割していたため、同じノードの点が spill の中に散らばり、spill が RAM を超えると**1点ごとに4KBのページ読み**になった。
計測では 0.73B 点の変換で、38.6 GB の spill から約 490 GB を読んでいた(約13倍。`TaskSheets/ADR-0019-record-carrying-lod.md` の Context)。

### 3-C. 複数ファイルの結合(デスクトップ)

1. `src-tauri/src/conversion.rs` `start_multi_las_conversion` — パスを `sort()` し(選んだ順に関わらず出力を同じにする)、`cache::multi_fingerprint_of_paths`・`output_path::resolve_multi_output_path`・空き容量の確認を経て `run_merge_conversion_thread` を別スレッドで起動。1ファイルだけなら `start_las_conversion` に委譲。`content://` が混じると未対応のエラー。
2. `crates/pcv-convert/src/merge.rs` `merge_paths_and_timings` — `summarize_headers_lenient` で全ファイルのヘッダーだけ読み、レイアウト(点形式・色・extra bytes)の一致を確認する。
3. 同 `MultiFileLasPoints::with_progress` — ファイルを順に開いて1本のイテレータにする。以降は 3-A の step 5 以降と同じ(`write_streaming_with_cancel_and_timings`)。
4. CRS の扱い(寛容モード、L2-C):
   - `pcv_core::crs::crs_id_from_las_header` が各ファイルの `CrsId`(`Missing` / `Epsg(u32)` / `Other(String)`)を作る。
   - CRS が無い(`Missing`)ファイルは通し、`HeaderSummary::missing_crs_paths` に記録する。結果の CRS は CRS を持つファイルのものになる。警告文は `HeaderSummary::crs_warnings` が作り、`ConversionDoneEvent.warnings` でエラーログに出る。
   - CRS を持つファイル同士が食い違うと `MergeError::CrsMismatch` で止める。
   - 厳格なモード(`summarize_headers`)は開発ツール(`examples/merge_las_to_copc.rs`)用。`--assume-missing-crs-is-first` はその CLI の指定。
   - scale/offset が違っていても止めない(点は実座標の f64 で運ぶので、出力の scale/offset で量子化し直されるだけ)。

### 3-D. E57・PLY・PCD(デスクトップ)

`crates/pcv-convert/src/import/mod.rs` `convert_to_copc_and_timings` が形式ごとの `PointSource`(`e57::E57Source`・`ply::PlySource`・`pcd::PcdSource`)を作り、
`import/convert.rs` `run_import` が点を1点ずつ spill に書いて、あとは 3-A の step 6 以降と同じです(中間の LAS ファイルは作りません。M4-9 で廃止)。
CRS は推測せず「不明」のままです(ADR-0008)。

### 3-E. Web

Web は1本の Worker(`copc.worker.ts`)の中で動き、OPFS に一時ファイルを置きます。

1. `src/datasource/web.ts` `WebSource.startConversion` — `opfs.findCachedOutput`(変換済みなら `cached`)、`opfs.isOpfsAvailable`、`checkInsufficientSpace`(空き容量)を確かめ、`buildConvertStartRequest` を Worker に `postMessage`。
2. `copc.worker.ts` `handleConvertStart` — `opfs.withConversionLock`(Web Locks で他のタブと同時に変換しない)の中で `runConversion` を呼ぶ。
3. `runConversion` — `opfs.cleanupStaleScratchDirs`(前回の残骸掃除)、`opfs.createScratchPool`(OPFS の一時ファイルを事前に256個開く)、`opfs.createOutputHandle` の後、`new WasmConverter(...)`(`crates/pcv-wasm/src/convert.rs`)。
4. 読み込み段階。入力が `PARALLEL_MIN_POINTS`(500,000点)以上で、`decompressWorkerCountFor` が2以上を返すとき(モバイルは1)は `runParallelReadPhase`:
   - `src/datasource/laz-decompress.worker.ts` を最大8本起こし、`pointRangesFor` で点の範囲を分担する。各 Worker は `LazRangeDecompressor`(`convert.rs`)で自分の範囲を seek して展開する。
   - バッチ(64Ki点)ごとに `requestBatch` で引き取り(pull 型)、`WasmConverter::push_serialized_records` に渡して即座に捨てる。`BoundedBatchFlow` が「要求済みで未消費」のバッチ数に上限を付ける(背圧)。
   - 分担しないとき: `converter.feed(CONVERT_BATCH_SIZE)` のバッチループ。バッチの間に `yieldToEventLoop` してキャンセルを受け取る。
5. `converter.finish()`(`WasmConverter::finish`) — `copc_writer::write_copc_from_spill_with_fs_and_timings` を `OpfsScratchFs`(`crates/pcv-wasm/src/opfs.rs`)で呼ぶ。以降は 3-B と同じ(1スレッド)。**この間はキャンセルできない。**
6. `opfs.writeCacheMeta` の後 `convert-done` を返す。成功・失敗・キャンセルのどれでも `finally` で一時ファイルを消す(失敗時は出力も消す)。
7. 複数ファイルは `runMultiConversion`: 先に `inspectLasHeaderSummary` で全ファイルのヘッダーを見て、レイアウトの食い違いと(CRS を持つファイル同士の)CRS の食い違いを止める。1本の `WasmConverter` に `setDeclaredTotals` で合計点数を渡し、`openNextFile` で読み元だけを切り替える。
8. PCD は `runPcdConversion` → `WasmPcdConverter`(`crates/pcv-wasm/src/pcd_import.rs`)。並列展開は無い(逐次の `feed` のみ)。

#### vendor/laz のパッチ(Web の分担展開に必須)

分担展開は各 Worker が `las::Reader::seek(start)` で自分の範囲の先頭に飛びます。
COPC のチャンクは**可変長**(ノードごとに点数が違う)ですが、上流の `laz` 0.12.2 の `LasZipDecompressor::seek` は「チャンクの中の位置」を `point_idx % チャンクの点数` で求めており、固定長のチャンクでしか正しくありません。
このため COPC を入力にした Web の結合で範囲の先頭がずれ、チャンクの境界を越えて**ごみのレイヤーサイズ**を読み、wasm32 の `Vec::resize` が `capacity overflow` で panic しました。
`vendor/laz`(`PATCH.md`)は `delta = point_idx - points_before_chunk`(チャンクより前の点数の合計を引く)に直しています。
回帰テストは `crates/pcv-wasm/src/convert.rs` の `range_of_variable_chunk_copc_matches_the_same_slice_of_a_full_read`。
ルートの `Cargo.toml` と `crates/pcv-wasm/Cargo.toml` の**両方**の `[patch.crates-io]` に `laz = { path = ... vendor/laz }` が要ります。

## 4. データの形・メモリとディスクの上限

| 項目 | 値 | 出典 |
|---|---|---|
| ノードあたりの最大点数(既定) | 100,000(`CopcWriterParams::default`、Web は `DEFAULT_MAX_POINTS_PER_NODE`) | `vendor/copc-writer/src/writer.rs`、`src/datasource/web-protocol.ts` |
| spill・run のレコード幅 | Tokyo の点形式3(GPS時刻+RGB)で 57 B/点。x,y,z の f64 が先頭24バイト | `TaskSheets/BENCH-multi-billion.md` §3 |
| 小さな部分木をメモリで仕上げる予算(既定) | デスクトップ 1 GiB、Android 256 MiB、Web 64 MiB。1つの run は `予算 / (2 × スレッド数)` 以下ならメモリで仕上げる | `writer.rs` の `default_memory_budget_bytes`、`write_copc_from_spill`(`in_memory_run_bytes`) |
| 同時に部分木を作るスレッド | 論理 CPU 数(最大8)。`parallel-compress` が無い Web は1 | `writer.rs` の `default_max_concurrent_subtrees` |
| ディスクのピーク | 上位の段で親 run と8つの子 run が同時に在るため、レコードのデータ約2コピー(+最後に出力) | ADR-0019 の Decision 4、`vendor/copc-writer/tests/lod_runs_bounded.rs`(一時ファイルのバイト数は spill の 2.1 倍を超えない) |
| 変換前の空き容量の見積もり | 入力サイズの 11 倍(デスクトップは `TEMP_SIZE_FACTOR`、Web は `SCRATCH_SIZE_FACTOR`) | `crates/pcv-convert/src/disk_space.rs`、`src/datasource/opfs.ts` |
| Web の OPFS 一時ファイルのプール | 256 個(`OPFS_SCRATCH_POOL_SIZE`) | `crates/pcv-wasm/src/opfs.rs` |
| Web の読み込みバッファ | 4 MiB(`READ_BUFFER_BYTES`)。展開 Worker のバッチは 64Ki 点、1 Worker あたり未消費2バッチまで | `crates/pcv-wasm/src/convert.rs`、`src/datasource/decompress-partition.ts` |

メモリが点数に比例しないことを確かめるテスト:
`vendor/copc-writer/tests/heap_is_bounded.rs`(計数アロケータ。50,000点と400,000点でヒープのピークが 11.6 MB のまま。1スレッド時、`TaskSheets/BENCH-conversion-profile.md`)、
`tests/lod_runs_bounded.rs`(開いている一時ファイルの数が点数に比例しない)、
`tests/scratch_read_is_bounded.rs`(1回の読みのサイズが上限内)。

ADR-0019 の**前**の実測(1,055,184,468点の結合): 全体 4641 秒、spill 56.0 GiB、ディスクのピーク 84.5 GiB、メモリ(private)のピーク 381 MiB(`BENCH-conversion-profile.md`)。
ADR-0019 の**後**に測れたのは渋谷4枚(30,043,046点)だけで、旧 61.8 秒 → 新 35.2 秒、ノードの点の集合は `compare_copc_nodes` で同一でした(1回ずつの計測)。
**3.5億・7億・10億点の再計測は未実施**です(計測中にディスクの空きが足りなくなり中止)。新方式で 10 億点が速くなるかは、まだ数字がありません。

## 5. 関連する ADR・タスクシートと落とし穴

- ADR: [ADR-0006](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md)(変換戦略)、[ADR-0019](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0019-record-carrying-lod.md)(点のレコードを運ぶ LOD)、[ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md)(Web の Worker)、[ADR-0008](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md)(形式と CRS)。
- タスクシート: `TaskSheets/M4-import-and-conversion.md`(M4-6〜M4-16)、`TaskSheets/M4-16-lod-sampling-bias.md`(親ノードの点の選び方)、`TaskSheets/BENCH-conversion-profile.md`、`TaskSheets/BENCH-multi-billion.md`、`TaskSheets/L2-layer-tools.md` の L2-C(寛容モード)・L2-G(可変長チャンク)。
- 落とし穴:
  - Web の後処理(`finish`)は途中で止められません(GitHub Pages では `SharedArrayBuffer` が使えないため)。
  - Web では `std::time::Instant::now` が panic するため、`copc-writer` は `web_time::Instant` を使います。`None` のときでも無条件に呼んでいたため、Web の変換がファイルサイズに関係なく失敗していた事故があります(`writer.rs` の `PostProcessStageTimings` のコメント)。
  - OPFS には mmap が無く、spill をまるごと読むと wasm32 のメモリ上限で落ちました。`ScratchReader` は範囲読み(`read_at`)だけにしてあります([vendor/copc-writer の章](../rust/copc-writer.md))。
  - デスクトップで複数ファイルの結合が失敗したとき、`run_merge_conversion_thread` の `Err(e)` 枝は `log::error!` を出すだけで、`emit_failed`(`conversion-failed` イベント)を呼んでいないように読めます(キャンセルの枝は呼ぶ)。画面に失敗が出ない可能性があります。**コードを読んだだけで、実行して確かめていません。**
  - テストが緑でも、実際の巨大入力・実ブラウザで確かめていない部分があります(上の「再計測は未実施」)。
