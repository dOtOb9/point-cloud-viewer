# CM-4: コメントを消す（`crates/pcv-core/`・`crates/pcv-wasm/`）

- 共通の決まり・例外・「なぜ」の移し方: [CM-0-no-comments.md](./CM-0-no-comments.md)（CM-0 が先に main に入っていること）
- 範囲: `crates/pcv-core/`・`crates/pcv-wasm/`（`Cargo.toml` の `#` のコメントも）。範囲の外のファイルは触らない（並行して別の作業役が消している）
- 方針: 振る舞いは変えない。push しない

## 受け入れ基準

- **AC-1** 範囲のファイルについて `scripts/comment-baseline.json` の項目が無くなり（上限 0）、`npm run check:comments` が通る。例外（CM-0 の「例外」）だけが残る
- **AC-2** 消したコメントが、コードから読めない意図を持っていた所では、CM-0 の順（名前 → テストの名前 → このシートの「移した理由」）で移す。
  名前を変えたら使い手を全部直す（`grep` の数を作業報告に書く）。名前の変更と関数の切り出し以外の変更はしない（振る舞いを変えない）
- **AC-3** コメントだけの行を消した後に、空行が2行以上続く・ブロックの先頭が空行になる、などの跡を残さない（整形ツールが通る）
- **AC-4** `src/code-limits.test.ts` の BASELINE など、行数に依存する検査・文書（ADR-0024 などの `path:line` の参照）を、縮んだ行数に合わせて直す（`npm run check:docs` が通る）
- **AC-5** `npm run check:all` が全部 OK
- `pcv-wasm` の `///` は wasm-bindgen が `src/wasm/pcv-wasm/*.d.ts`・`*.js` に写すので、消したら `npm run build:wasm` で作り直し、生成物もコミットする（`npm run check:wasm-glue` が通ること）
- `cargo test -p pcv-core -p pcv-wasm` と、`cargo build -p pcv-wasm --target wasm32-unknown-unknown` が通ること

## 移した理由の記録

| ファイル:識別子 | 消したコメントの要点 | 移し先（名前／テスト名／ここ） |
|---|---|---|
| `crates/pcv-wasm/src/extract.rs:WasmExtractor::feed`・`section_line.rs:WasmSectionLine::advance`・`thin_filter.rs:WasmThinFilter::advance` | Worker は長い呼び出しの途中で止められないので、仕事を小さく刻み、呼び出しの間に JS 側がイベントループに戻ってキャンセルを受ける。`finish`（octree の構築と書き出し）の途中は止められない | ここ |
| `crates/pcv-wasm/src/thin_filter.rs:TILE_CAP_POINTS` | デスクトップの 2,000,000 より小さい 500,000。Worker はメモリが少なく、タイルが点の全レコードとフィルタの格子を持つため | ここ |
| `crates/pcv-wasm/src/write_metadata.rs:copc_write_metadata_from_source_header` | Web 版は WKT の CRS VLR だけを引き継ぎ、GeoTIFF キーだけの入力は CRS を失う（デスクトップの `resolved_wkt_crs_for_header` を持ち込んでいない。M4-6b の範囲外）。変換は失敗しない（`validate_streaming_layout_supported` は GeoTIFF のみを拒否しない） | ここ（`ADR-0006-conversion-strategy.md` の Web 版の節にもある） |
| `crates/pcv-wasm/src/http_reader.rs:send_range_request` | 同期の `XMLHttpRequest` は Worker の中でだけ許される。`fetch` は常に非同期なので使えない | ここ（`open_with_async` に渡す変数 `is_async = false`。理由の詳細は `ADR-0012-web-worker-sync-io.md`） |
| `crates/pcv-wasm/src/http_reader.rs:is_partial_content` | 200（Range を無視して全体を返した）を許すと「全体を読まない」が崩れるので 206 だけを成功にする | テスト `a_200_that_ignored_the_range_header_is_rejected_so_the_whole_file_is_never_read` |
| `crates/pcv-wasm/src/stats.rs:BytesReadCounter` | 実際に JS から受け取ったバイト数を数え、「ファイル全体を読んでいない」ことを確かめる。wasm32 は単一スレッドなので `Rc<Cell<_>>` で足りる | 名前（`Stats` から改名）。単一スレッドの前提は `ADR-0012` |
| `crates/pcv-wasm/src/alloc_guard.rs:ReportingAllocator` | メモリ確保の失敗は panic を通らず、`handle_alloc_error` から wasm の `unreachable` で落ちる（stable では `#[alloc_error_handler]` が使えない）。panic フックがあっても何も残らないので、`System` を包んで null を返した瞬間に console へ出す。確保の結果は変えない | ここ |
| `crates/pcv-wasm/src/alloc_guard.rs:report_allocation_failure` の `REPORTING` | console へ出す処理も小さな確保をするので、それも失敗して戻ってきたときに無限に再入しないための旗。ネイティブ（`cargo test`）では JS が無いので何もしない | ここ |
| `crates/pcv-wasm/src/alloc_guard.rs:LAST_FAILURE_MESSAGE` | JS 側には `unreachable` としか伝わらないので、トラップの前に文言を残し、Worker の catch が `last_allocation_failure_message()` で読んで画面に出す。トラップは wasm のインスタンスと `thread_local` を壊さない。一度読んでも消さない（直後に Worker を終わらせる前提） | ここ |
| `crates/pcv-wasm/src/lib.rs:init_panic_hook` | panic の理由を devtools の console に出す（専用のクレートを足さず、標準のフックを `console.error` に繋ぐ）。`#[wasm_bindgen(start)]` で自動で1回呼ばれ、Worker の `ensureWasmReady` が読みやすさのためにもう一度呼ぶ（副作用なし） | ここ |
| `crates/pcv-wasm/src/lib.rs:opfs_scratch_pool_size` | TS 側（`src/datasource/opfs.ts`）が前もって開く OPFS の一時ファイルの数を、Rust の `OPFS_SCRATCH_POOL_SIZE` と二重に持たないために JS に出す | ここ |
| `crates/pcv-wasm/src/dto.rs` の DTO のフィールド名 | `src-tauri` の JSON（serde の既定の snake_case）と同じ名前にして、TS 側の `TauriSource` と `WebSource` が `src/datasource/copc-dto.ts` などの同じ変換関数を使う。片方を変えたらもう片方も直す | ここ |
| `crates/pcv-wasm/src/dto.rs:ConversionStageBreakdownDto` の `opfs_*` | Web だけが持つ OPFS の時間・回数（デスクトップは常に `None`）。逐次読み（`opfs_seq_read_*`）は、実機相当の規模の BEFORE 計測で「ノードの圧縮」のほぼ全部を占めていた（`encode_node_points` が LOD 順の索引を1点ずつ無バッファで読む）ので別に数える | ここ（M4-13 の記録） |
| `crates/pcv-wasm/src/raster.rs:MAX_CELLS_WEB` | 全部が Worker の wasm のメモリ（最大 4 GiB）に載るので、デスクトップの 4 分の 1 | ここ（決め方は `G1-T6-rasterize-tool.md`） |
| `crates/pcv-wasm/src/ply_import.rs`・`pcd_import.rs`・`e57_import.rs`（と `pcd_import.rs:choose_scale_offset`） | `crates/pcv-convert/src/import/` の写し。pcv-wasm はルートのワークスペースの外の独立したワークスペースなので、`pcv-convert` にパスで依存するとワークスペースの二重定義で cargo が失敗し（試して確かめた、と元のコメント）、`pcv-convert` の `copc-writer` の `parallel-lod`・`parallel-compress` が wasm32 のビルドに rayon を持ち込む。片方を直したらもう片方も直す | ここ（依存の理由は `crates/pcv-wasm/Cargo.toml` のコメントにあったもの。下の Cargo.toml の行） |
| `crates/pcv-wasm/src/e57_import.rs:E57Stream` | `pointcloud_simple` の反復子は reader を借りる。`feed` の間で反復子を持ち続けるため、reader を `Box::into_raw` の生ポインタにして自分を指す構造体を手で作る（`E57Stream` が動いても借用が壊れない）。毎回作り直すと先頭からデコードし直して O(n^2)、1回の wasm の呼び出しで全部すると Worker がキャンセルを受けられない。`points` を先に宣言し、`Drop` で reader より先に放す | ここ（unsafe の根拠は `// SAFETY:` の1行） |
| `crates/pcv-wasm/src/pcd_import.rs:MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES`・`peek_binary_compressed_uncompressed_size` | `pcd-rs` は `binary_compressed` を見た所で全体を展開し、さらに行優先の写しを作る（展開後の最大2倍のメモリ）。重い展開の前にヘッダー直後の8バイトから展開後の大きさだけを読み、上限を超えたら断る。値はデスクトップと同じ見積もり（実測でない）。Web はモバイルも対象なので、なお大事 | ここ（テスト `peek_binary_compressed_size_reads_header_declared_uncompressed_size`） |
| `crates/pcv-wasm/src/ply_import.rs` の行の読み込み | 要素の数はファイルから来るので `with_capacity(count)` を使わない（壊れたファイルで巨大な確保をしない）。知らない宣言の行は無視する（取り込みを止めるほどではない） | ここ |
| `crates/pcv-wasm/src/point_file_import.rs:WasmPointFileConverter::new`・`point_merge.rs:MergedPoints::start` | ファイルは渡された順に読むので、出力が選んだ順に依存しないよう呼び出し側（Worker）が名前で並べ替えて渡す。ヘッダーの読み（色の有無・点数・CRS）は最初の点より前（spill の形を決めるため） | ここ |
| `crates/pcv-wasm/src/point_merge.rs:MergedPoints::start` | 1つ目のファイルだけ開いたまま残し、1つだけのときに二度開かない。他はヘッダーを読んだらすぐ閉じる（同時に開くのは1つ） | ここ |
| `crates/pcv-wasm/src/point_file_import.rs:WasmPointFileConverter::finish` の CRS | PLY・PCD・E57 は CRS を持たない（E57 は持ちうるが、`pcv-convert` と同じく渡さない。ADR-0008）。CRS はマージの LAS/LAZ からだけ取り、無ければ推測しない | ここ |
| `crates/pcv-wasm/src/opfs.rs:OpfsScratchFs`・`take_free_pool_slot` | `copc-writer` は octree の再帰の奥から同期で `create_temp` を何千回も呼ぶが、OPFS でファイルを開くのは非同期。変換の前に TS（`src/datasource/opfs.ts`）が固定の数のハンドルを開き、ここでは借りて返すだけにする（`truncate` で 0 にして使い回す）。使い切ったら壊れたファイルを作らずに分かるエラーにする | ここ（テスト `take_free_pool_slot_returns_clear_error_when_exhausted`） |
| `crates/pcv-wasm/src/opfs.rs:OPFS_SCRATCH_POOL_SIZE` | 逐次の LOD 構築で同時に開く一時ファイルは、祖先の reader・まだ降りていない兄弟・書き込み中の最大8個と `order` の1個で、理論上の上限は `8 * (D + 1) + 1`。深さの上限 30 で 249。`tests/sequential_lod_open_files_bounded.rs` で深さ 0〜16 のピーク 5〜117 を測って裏付けた。約3割の余裕で 256（前は 600。モバイルで準備に 600 個を順に開く時間を減らす。M4-11） | ここ（テスト `sequential_lod_open_files_bounded.rs`） |
| `crates/pcv-wasm/src/opfs.rs:OpfsTempReader::read_at`・`ReadCache`・`READ_CACHE_BLOCK_BYTES`・`READ_CACHE_MAX_BLOCKS` | OPFS には mmap が無い。前は一時ファイルを丸ごと `Vec` に読み、数千万点で wasm32 の 4 GiB を超えて `unreachable` で止まった（M4-6b）。範囲読みにし、1 レコードごとの JS の往復を減らすため 64 KiB のブロックを 64 個（4 MiB で固定）の LRU に持つ | ここ（テスト `read_cache_never_exceeds_max_blocks_regardless_of_insert_count`） |
| `crates/pcv-wasm/src/opfs.rs:check_opfs_len` | ブラウザが OPFS の `read`・`write` のバイト数に 4294967288（2^32 - 8。Chromium の `FILE_ERROR_NO_SPACE` = -8 を符号なしにした値と推定、未検証）を返すことがあり、そのまま使うと `BufWriter` が範囲外で panic する | テスト `check_opfs_len_rejects_2_pow_32_minus_8_with_clear_message`。0 の意味は型 `ZeroLength`（`EndOfFile`・`Error`。引数 `allow_zero` を `zero_length: ZeroLength` にした） |
| `crates/pcv-wasm/src/opfs.rs:OpfsIoTimer`・`OpfsReadCounters`・`OpfsSeqReadCounters` | 所有者向けの内訳で OPFS の時間を別に見せる。`Instant::now()` はキャッシュを外したときの実際の JS 呼び出しの単位でだけ呼び、点ごとに測る観測者効果を避ける。逐次読み（`open_at`）にはキャッシュが無く、BEFORE の計測（50 万点で `read` 500,020 回・118.6 秒、ノードの圧縮 120.4 秒のほぼ全部）で主な原因と分かった。変換1回に `OpfsScratchFs` は1つなので `Rc<Cell<_>>` で共有する | ここ（M4-12・M4-13 の記録） |
| `crates/pcv-wasm/src/opfs.rs:OpfsTempWriter`（`finish_temp` を呼ばずに捨てたとき） | 借りた添字をプールに返さない。この経路は必ず変換全体の失敗で、TS 側がハンドルと OPFS のファイルを丸ごと片付け、プールも変換1回で使い捨てるので、ずれても害が無い | ここ |
| `crates/pcv-wasm/src/opfs.rs:OpfsOutputWriter` | 一時名で書いて rename する置き換えをしない。OPFS はオリジンごとの非公開の領域で、途中の内容を人に見せる心配が無い。失敗・キャンセルのときの出力の削除と、全ハンドルを閉じる後片付けは Worker（TS）がする | ここ |
| `crates/pcv-wasm/src/opfs.rs:OpfsTempReader::read_opfs_exact` | 1回の `read()` で全部読める保証が仕様に無いので、読み切るまで繰り返す | ここ |
| `crates/pcv-wasm/src/convert.rs:WasmConverter::feed`・`finish` | デスクトップは別スレッドで変換し `AtomicBool` で止めるが、Web は Worker 1 本（ADR-0012）で、キャンセルの `postMessage` は Rust の長い同期呼び出しの途中では処理されない。`SharedArrayBuffer`＋`Atomics.wait` には COOP/COEP のヘッダーが要り、GitHub Pages では付けられない。それで読み込みを TS から小さなバッチ（`feed`）で回す。`finish` の途中は止められないので、キャンセル済みなら TS が `finish` を呼ばない。`finish` は `feed` が尽きたかを確かめない（単純さを優先） | ここ（`ADR-0006-conversion-strategy.md` の Web 版の節にもある） |
| `crates/pcv-wasm/src/convert.rs:READ_BUFFER_BYTES` | `FileRangeReader::read` は呼ぶたびに `File.slice`・`FileReaderSync`・コピーをする重い処理で、`las::Reader` は生の LAS を1点（20〜38 バイト）ずつ読むので、そのまま渡すと実機で進捗が出ないほど遅かった（M4-6b）。4 MiB は 1 回の `feed`（既定 64Ki 点 × 最大 36 バイト ≈ 2.36 MiB）がほぼ1回の補充で済む値 | ここ（テスト `tests/buffered_file_reader_reduces_read_calls.rs`） |
| `crates/pcv-wasm/src/convert.rs:LazRangeDecompressor`・`RangeDecompressorCore` | Web では rayon が使えない（スレッドも `SharedArrayBuffer` も無い）ので、LAZ の展開は別の Worker を複数立てて点の範囲を分ける。各 Worker は自分の `las::Reader` を開いて範囲の先頭へ `seek` する（`File` は不変なので競合しない）。範囲全体を1回で返した前の設計は Worker ごとのメモリが点数に比例して wasm32 の 4 GiB を圧迫したので、`feed(batch_size)` で1バッチずつ返す pull 型にし、TS の `BoundedBatchFlow` が背圧をかける。範囲が点数を超えたら、読める分だけにする（端数をそのまま渡せる） | ここ（テスト `feed_batch_size_stays_bounded_regardless_of_total_point_count`・`concatenated_ranges_match_a_single_full_range_read`） |
| `crates/pcv-wasm/src/convert.rs:WasmConverter::push_serialized_records` | 並列展開の結果は Worker 間で届いた順に push する。順に並べ直すには届いたバッチを貯める必要があり、メモリの上限の前提を崩すため。`SpillWriter::push` の検証と統計は1点ごとに閉じていて順序に依存しない。長さが `recordWidth()` の倍数でなければ、余りを黙って捨てずにエラーにする | テスト `tests/parallel_push_order_point_set.rs`（順序）。倍数の確かめはここ |
| `crates/pcv-wasm/src/convert.rs:WasmConverter` の時間の内訳（`source_read_and_decode` など） | `Instant::now()` はバッチごとに2回だけ呼ぶ。点ごとに測ると、Web の本来の遅さ（小さな処理を点の数だけ JS の境界越しに繰り返す）を計測自体が再現してしまう | ここ（M4-12 の記録） |
| `crates/pcv-wasm/src/convert.rs:WasmConverter::open_next_file` | TS が `inspectLasHeaderSummary` で全ファイルの point format と CRS の一致を前もって確かめているが、ここでももう一度確かめて、食い違いを分かるエラーにする。`layout_key`・`crs_label` は `Debug` の表示のままで、TS は文字列の比較だけに使う | ここ |
| `crates/pcv-wasm/Cargo.toml` の空の `[workspace]` | このファイルを根とする独立したワークスペースにする。ルートの `exclude` だけだと、git worktree で外側にある別の `[workspace]` を見つけて cargo が「メンバーでも除外でもない」と失敗することがある。`[patch.crates-io]` がここで効くのもこのため | ここ |
| `crates/pcv-wasm/Cargo.toml` の `crate-type = ["cdylib", "rlib"]` | cdylib は wasm-bindgen が読む .wasm を作るため、rlib はネイティブの `cargo test` でこのクレートのテストを動かすため（ADR-0012） | ここ |
| `crates/pcv-wasm/Cargo.toml` の `copc-writer`（`default-features = false`）・`web-time`・`e57 = "=0.11.13"`・`pcd-rs` | `native-fs` を切って wasm32 で使えない tempfile・memmap2 を外し、`OpfsScratchFs` を `&dyn ScratchFs` で渡す（`vendor/copc-writer/PATCH.md`）。`std::time::Instant` は wasm32 で panic するので `web_time::Instant`（clippy.toml の `disallowed-methods` が守る）。E57 は `pcv-convert` と同じ版に固定（wasm32 でビルドできる）。PLY・PCD・E57 を写した理由は上の行 | ここ |
| `crates/pcv-wasm/Cargo.toml` の `[patch.crates-io]` | 上流の copc-reader 0.9.0 は hierarchy が複数ページの大きな COPC を開けない（小さいファイルは開けて大きいものだけ壊れる。ADR-0003）。copc-writer の OPFS 向けの入口と、laz の可変チャンクの `seek` の修正（`vendor/laz/PATCH.md`）も vendor にしか無い。ルートのワークスペースの外なので、ルートとは別にここにも要る | ここ（各 `vendor/*/PATCH.md`） |
| `crates/pcv-core/Cargo.toml` の `las` | copc-reader は COPC・LASzip 以外の VLR を捨てるので、CRS（GeoTIFF キー・WKT）を読むためにヘッダーを `las` で開き直す。版は copc-reader と同じ 0.10 系にして1つの `las` に解決させる。tauri を入れない（規約1）。copc-core・copc-reader は wasm32 でビルドできることを確かめて選んだ（ADR-0003） | ここ |
| `crates/pcv-core/clippy.toml`・`crates/pcv-wasm/clippy.toml` | `std::time::Instant::now`・`SystemTime::now` は wasm32 で panic する（2026-10-07 の緊急修正の再発防止）。理由は各項目の `reason` に残っている | `reason`（設定の値） |
| `crates/pcv-wasm/tests/buffered_file_reader_reduces_read_calls.rs` | 生の LAS は `las` がバッチを1回の `read_exact` で読むので不具合が再現しない。LAZ の復号器が下の `Read` を細かく呼ぶので LAZ で試す。バッファ無しの下の `read` の回数は実測で点数の約9割だったので、閾値は「半分を超える」と緩くした | ここ |
| `crates/pcv-wasm/tests/sequential_lod_open_files_bounded.rs` | Web が使う逐次の LOD（`parallel-lod` 無し）の同時に開く一時ファイル数を測る。`vendor/copc-writer` には並列版の測定しか無く、当時 vendor は別の作業役の担当だったので、公開 API（`MemoryScratchFs`）越しにこのクレートで測る。人工データは各レベルに番兵7点と本流2点を置き、8分木を深さ D まで全部分岐させて最悪の場合を作る | ここ（理論値は `opfs.rs:OPFS_SCRATCH_POOL_SIZE` の行） |
| `crates/pcv-core/examples/open_bench.rs`・`parallel_bench.rs` の `#![allow(clippy::disallowed_methods)]` | `Instant::now` は wasm32 で panic するので clippy.toml が禁じているが、この2つはネイティブ専用の計測で、wasm32 のビルド（CI の規約1）は examples を含めない | ここ。測る物の説明は `M1-point-rendering.md`・`ADR-0007-pcv-protocol-concurrency.md` |
| `crates/pcv-core/src/color_depth.rs:detect` | 16 bit の欄に 0〜255 を書くエンコーダが実在し（`beer.laz`、M2-2）、無条件に `>> 8` すると真っ黒になる。ファイルを開いたときにルート（相当）の1ノードで1回だけ決め、ノードごとには決めない（暗いノードだけ 8 bit と誤り、境界で明るさが変わるため）。本当に暗いだけの 16 bit を 8 bit と誤っても、真っ黒よりは元に近い | テスト `detects_sixteen_bit_when_any_single_channel_exceeds_255` など。ノードごとにしない理由はここ |
| `crates/pcv-core/src/node_format.rs:encode_node` | Rust と TS の間の唯一の重いデータの形式で、TS の読み手は `src/datasource/node-format.ts`。変えるときは両方を同じコミットで直す。座標はノードの原点からの相対の f32（世界座標をそのまま f32 にすると mm〜cm が消える）。相対座標は f32 に丸めた原点から引く（丸める前の原点から引くと丸め誤差だけずれる） | テスト `relative_position_absorbs_the_origin_rounding_error`・`header_and_stride_constants_match_the_documented_layout`。形式の約束はここ |
| `crates/pcv-core/src/copc.rs:NodeKey`（`Display`・`FromStr`） | `pcv://` の URL は1つのセグメントしか扱えない（M0 で分かった `convertFileSrc` の制約）ので、`"{level}-{x}-{y}-{z}"` の1つの文字列にする。COPC のキーは負にならないので `-` で単純に分けてよい | テスト `node_key_display_and_parse_round_trip`・`node_key_parse_rejects_wrong_segment_count`。URL の制約はここ |
| `crates/pcv-core/src/copc.rs:CopcFile::read_node` | `copc-reader` の `read_node`（`vendor/copc-reader/PATCH.md`）が hierarchy の位置へ直接 seek して、そのノードの LAZ チャンクだけを伸長する。前のレベル全体を読んで bbox で絞る実装は深いレベルほど遅かった（ADR-0007 の追記）。1チャンク＝1ノードなので、読んだ点は全部そのノードの点 | ここ |
| `crates/pcv-core/src/copc.rs:LAS_SPEC_COLOR_DEPTH` | 色の bit 深度を決められない（判定するノードが無い）ときは、前からの振る舞いの 16 bit に倒す | 名前（定数に切り出した） |
| `crates/pcv-core/src/copc.rs:voxel_bounds` | copc-reader の中にも同じ式があるが非公開なので写す（hierarchy を作るときに一度だけ計算して持つ） | ここ |
| `crates/pcv-core/src/crs/transverse_mercator.rs:gsi_signed_gamma` | 河瀬(2011) の式(7)・(15) のままだと、子午線収差角の符号が国土地理院 API（`bl2xy.pl`）の `gridConv` と逆になる（X・Y・縮尺係数は 0.1 mm・1e-7 で一致するので、正の向きの定義の違い）。画面の値を GSI の公開値に合わせるために反転する | 名前（関数に切り出した。テスト `gsi_api_ix_system_tokyo_station_area` など `gsi_api_*` の `gridConv` との比較） |
| `crates/pcv-core/src/crs/transverse_mercator.rs` の級数 | 河瀬(2011) の式番号（順変換は式(5)〜(12)、逆変換は式(13)〜(22)）。記号は GSI の測量計算サイトの解説（Ā, S̄φ0）に合わせた。α・β・δ は5項（6項）で打ち切る（河瀬が「通常の計算機の精度では5項で十分」とする）。係数は原点と楕円体だけで決まるので1回だけ計算する（3.2.1 節） | ここ（下の「出典」） |
| `crates/pcv-core/src/crs/ellipsoid.rs:GRS80`・`WGS84` | 長半径は同じで扁平率が 9 桁目でわずかに違うだけだが、確かめていないことを同じと書かないため別の定数にする（ADR-0008）。JGD2000 と JGD2011 は同じ GRS80（違いは測地成果で、投影の計算には効かない） | ここ（下の「出典」） |
| `crates/pcv-core/src/crs/plane_rectangular.rs:JgdEpoch` | JGD2000⇄JGD2011 の補正はしない（パラメータファイルが要る。ADR-0008）が、東日本では最大 1 m 前後違うので取り違えないよう型で分ける | ここ |
| `crates/pcv-core/src/crs/utm.rs:MIN_SUPPORTED_ZONE`・`MAX_SUPPORTED_ZONE` | 日本に関係する北半球の 51N〜56N（沖縄・南西諸島から北海道東部・南鳥島）だけ。ほかは `Crs::Unknown`（ADR-0008） | ここ |
| `crates/pcv-core/src/crs/mod.rs:detect_crs_from_las_header`・`crs_id_from_las_header` | `copc-reader` は COPC・LASzip 以外の VLR を捨てるので、CRS は `las` の `get_geotiff_crs`・`get_wkt_crs_bytes` でヘッダーを開き直して読む。GeoTIFF は ProjectedCRSGeoKey（3072）を使い、地理座標系だけなら対応外。空の WKT（beer.copc.laz の 1 バイトのもの）は「CRS 無し」。`CrsId` は `Crs` の範囲外（EPSG:2992 など）の EPSG と WKT を持ち、2つの範囲外のファイルが「CRS 無し」と同じに見えて警告していたのを直した（L2-G） | テスト `crs_id_separates_missing_unsupported_and_unnamed`。VLR の読み方はここ |
| `crates/pcv-core/src/crs/mod.rs:epsg_from_wkt` | WKT は GEOGCS の EPSG が先に、PROJCS 自身の EPSG が最後に出るので、`VERT_CS`・`VERTCRS` より前で最後の `AUTHORITY["EPSG","N"]` を採る（`las-crs` 0.1.1 の `get_wkt_epsg` と同じ考え方。`las-crs` は `las` 0.9 系で `copc-reader` の 0.10 系と衝突するので依存しない） | ここ |
| `crates/pcv-core/src/crs/describe.rs:describe_crs_from_las_header`・`read_crs_info` | `Crs` は対応外の系の EPSG も名前も失うので、画面向けに別の型にまとめる。読み取りの失敗は `Result` でなく `CrsInfo::error` に入れて、CRS が読めなくてもファイルを開ける（ADR-0015）。点データと EVLR（COPC の階層は数 MB になりうる）は読まない。WKT1 の長さの単位は、`keyword` の要素の直下の `UNIT` だけを読む（入れ子の `GEOGCS` の度を読まない）。WKT2 は単位を推測せず `None`。鉛直の系が無ければ鉛直の単位は水平と同じとみなす（仮定）。JGD 平面直角と UTM は定義上メートル | ここ |
| `crates/pcv-core/src/crs/describe.rs`・`mod.rs` の、実データを読むテスト | 実データが無い環境（CI）では何もしない | ここ |
| `crates/pcv-core/src/extract.rs:ExtractFilter::may_intersect` | ノードの間引きは保守的: 交わらないと言い切れるときだけ `false`。迷う（カメラの面をまたぐ、など）ときは `true` で読み、点ごとの `contains` が正確に決める。斜めの箱と軸に沿った箱の分離軸判定は、6 本の軸だけを見て辺の外積の 9 本を省く（省くと「交わらない」と言える場合が減るだけで、誤りは `true` の側に寄る） | ここ |
| `crates/pcv-core/src/extract.rs:ExtractPoints::all` | `ExtractFilter` の変種にせず別のコンストラクタにする。`ExtractFilter` は TS から来る JSON で、その形は約束だから | ここ |
| `crates/pcv-core/src/extract.rs:ExtractPoints::set_node_callback` | 当たる点が少ないと書き手に長い間何も届かず、書き手のキャンセルの確かめだけでは遅すぎるので、ノードを読むたびに呼ぶ | ここ |
| `crates/pcv-core/src/extract.rs:ExtractPoints` のメモリ | 読んでいるノードの点だけを持ち、次のノードの前に捨てる。1ノードは `max_points_per_node`（既定 10 万）以下なので、点の総数にもノードの数にもよらない | テスト `buffer_is_bounded_by_largest_node`（`crates/pcv-convert/src/extract.rs`） |
| `crates/pcv-core/src/profile.rs:PROFILE_HEADER_BYTES` と形式 | 形式はヘッダー 24 バイト（`u32 count, u32 flags, f32 s_min, s_max, z_min, z_max`）の後に `count * 12`（`f32 s, f32 z, u8 r, g, b, classification`）。24 バイトにしてレコードを 4 バイト境界から始め、ブラウザが `Float32Array`・`Uint32Array` で見られるようにする。`cap` を超えるときは `(s, z)` の固定の格子に最初の点を残すので、残る数は格子の数を超えず、追加の間引きは要らない | ここ |
| `crates/pcv-core/src/thin.rs:thin_tile`・`thin_points` | セルは原点から測る大域の格子（タイルの角から測らない）。セルの中心の XY を持つタイルがそのセルを出し、セルの全部の点（余白の点も）から最良を選ぶので、結果はタイルの切り方に依存しない。範囲の外に中心があるセルは、中心を範囲に寄せて持ち主を決める。同じスコアは z・x・y で決め、座標まで同じで属性が違うときだけ先に読んだ方が勝つ（タイルの切り方が結果を変える唯一の場合）。タイルの境界をセルの倍数にする案は、点の数で決まるタイルの切り方をセルの大きさに縛るので採らない | テスト `result_does_not_depend_on_the_tiling`。持ち主の決まりはここ |
| `crates/pcv-core/src/thin.rs:MARGIN_PER_CELL_SIZE` | タイルが読む余白はセルの大きさの 0.51 倍＝半セルに 1 % の余裕（浮動小数の丸めで点を落とさない） | 名前（定数に切り出した） |
| `crates/pcv-core/src/thin.rs:ThinSettings::check_coordinates` | セルの大きさが座標に比べて小さすぎると、セルの番号が `i64` で飽和して全点が1つのセルに入り、黙って誤った結果になるので断る | ここ |
| `crates/pcv-core/src/thin_filter_job.rs:ThinFilterJob` | デスクトップは1回の長い呼び出し（`pcv_convert::thin_filter`）で、Web は Worker を止められないので同じ仕事を1タイルずつの `advance` に刻む。判定の関数と `TileReader` は同じなので残る点も同じ。SOR は2パス（1パス目は統計だけ）で、進捗の分母は点の数の2倍。開く関数は SOR の2パス目でもう一度開くので `Rc` で共有し、Web 側が型を名指しできるよう `dyn` にする。タイルの一辺は余白の2倍以上 | テスト `crates/pcv-convert/src/thin_filter/tests.rs`（デスクトップと比べる）。ほかはここ |
| `crates/pcv-core/src/tiles.rs:Tile::owns` | 点は、核の長方形が X・Y とも半開区間 `[min, max)` で含むタイルの核の点。範囲全体の外側の最大の辺だけ閉じる（端の点を落とさない）。隣のタイルは同じ `f64` の境界値を共有する（1回だけ計算する）ので、どの点もちょうど1つのタイルの核になる | テスト `boundary_and_outer_edge_points_are_owned_once`。決まりはここ |
| `crates/pcv-core/src/tiles.rs:estimate_points`・`plan_tiles` | 読む前に分かるのは hierarchy だけなので、ノードの点が XY の足跡に一様に広がると仮定して重なりの面積で配る（上限でなく見積もり）。平均で `cap / 2` 点の一様な格子から始め、見積もりが `cap` を超えるタイルを `min_tile_size` まで4分割する。分けられないタイルは `cap` を超えてもそのまま。分割の深さの上限 `MAX_DEPTH` は、浮動小数の丸めで終わらなくなるのを防ぐため | ここ |
| `crates/pcv-core/src/tiles.rs:header_extent` | ヘッダーの範囲を各辺1スケール単位ずつ広げる。書き手が丸める前の座標で範囲を出し、保存する座標は丸めるので、点が範囲のわずかに外に出ることがあり、広げないとどのタイルの核にもならず黙って落ちる | ここ |
| `crates/pcv-core/src/tiles.rs:TileReader` | `ExtractPoints` は reader を消費するので、タイルごとに新しい `CopcReader` を開く関数を受け取る（ヘッダーと hierarchy は小さい）。粗いレベルのノードは重なる全タイルが読み直す（費用は `G3-T4-tiles.md` に測った）。軸に沿った箱は中心と半分の大きさの形の丸めで端の点を落とさないよう少し広げ、正確な判定は後でする | ここ |
| `crates/pcv-core/src/outlier.rs:MARGIN_SLACK`・`RorSettings::margin`・`SorSettings::margin` | ROR の余白は `r`、SOR は探索半径 `R` に、ちょうど半径の位置の近傍を丸めで失わないための余裕を掛ける。SOR は孤立した点の k 近傍が遠くにありうるので `R` より遠くは探さず、足りない近傍は距離 `R` と数える。これでスコアは点と点群だけの関数になり、タイルの切り方によらない。`R` は点の間隔の数倍にする（小さいと多くのスコアが上限に張り付き、標準偏差が意味を失う。画面が勧めるべき） | ここ |
| `crates/pcv-core/src/outlier.rs:RunningStats`・`sor_accumulate`・`sor_keep` | SOR は2パス: 1パス目はスコアを Welford の方法（母分散 `m2 / count`）で足すだけで保存せず、2パス目で同じスコアを計算し直す（メモリを時間で払う。メモリはタイルの大きさだけで決まる）。2パスのスコアは同じ計算・同じ順なのでビット単位で同じ。平均と標準偏差がタイルの切り方で違うのは足す順の丸め（相対 1e-12 程度）だけ | ここ |
| `crates/pcv-core/src/outlier.rs:PointGrid` | 近傍探索は手書きの一様格子。kd-tree のクレートは悪いデータで速いが追いにくいので採らない（測って遅ければ置き換える） | ここ |
| `crates/pcv-core/src/csf.rs` の全体 | Zhang et al. 2016 "An Easy-to-Use Airborne LiDAR Data Filtering Method Based on Cloth Simulation", Remote Sensing 8(6):501 と、作者の実装（jianboqi/CSF、Apache-2.0。振る舞いを読んだだけでコードは写していない）。論文でなく実装に従った所・違う所は `G1-T3-csf-core.md` にある。点は持たず2回流す（IHV → `step` を何回かに分けて → `is_ground`・`height_at`）。点群を上下反転して布を落とす（論文 2.1）。乱数とハッシュマップを使わず、結果は入力の値だけで決まる | ここ（`G1-T3-csf-core.md`） |
| `crates/pcv-core/src/csf.rs:GRAVITY`・`DAMPING`・`MARGIN_CELLS`・`START_ABOVE_TOP`・`MIN_GROUP_FOR_POST`・`SINGLE_MOVE`・`DOUBLE_MOVE`・`NEIGHBOURS` | 2026-10-21 に参照実装（`CSF.cpp`・`Particle.h`・`Particle.cpp`・`Cloth.cpp`・`Rasterization.cpp`）と照らした値。加速度は実装どおり `time_step^2` を2回掛ける（1歩で `GRAVITY * time_step^4` 落ちる）。`SINGLE_MOVE`・`DOUBLE_MOVE` は 0.3 の移動を `rigidness` 回した閉じた形（15 以降は 1 と 0.5）。`NEIGHBOURS` の順は実装が拘束を作る順（x が外、y が内、距離1の後に距離2） | ここ |
| `crates/pcv-core/src/csf.rs:NEVER_REJECTING_SLOPE_HEIGHT_THRESHOLD` | 参照実装は斜面の後処理の `heightThreshold` に 9999 を渡すので、その判定は何も落とさない。実装に忠実にするため定数として残す | 名前（`SLOPE_HEIGHT_THRESHOLD` から改名、使い手 2） |
| `crates/pcv-core/src/csf.rs:Cloth::add_point_for_ihv` | 点は最も近い粒子に入り、粒子は XY で最も近い点を持つ（`RasterTerrian`）。距離が同じとき実装は先の点を残すが、ここは反転後の高い方を残して点の順序によらない結果にする（実装との違い） | テスト `deterministic`。ほかはここ |
| `crates/pcv-core/src/csf.rs:Cloth::finish_ihv` | 点の無い粒子は、行を右・左、列を小さい方・大きい方に走査して最初に見つかった値をとる（`findHeightValByScanline`。最も近い物ではない）。行も列も空なら 16 近傍の幅優先探索（`findHeightValByNeighbor`） | ここ |
| `crates/pcv-core/src/csf.rs:Cloth::step` と `active`・`REBUILD_INTERVAL` | 実装は `0 < max_diff < threshold` で止めるが、`max_diff == 0` でもすることが無いので止める。動ける粒子とその隣の固定粒子だけを訪ねる（固定で隣も固定なら全体を回しても変わらない）。古い一覧は余分を含むだけで正しいので、作り直しは何かが変わって数歩たったときだけ。拘束の段は添字の順にその場で更新する（実装と同じ。順を保つ）。固定粒子に 0.0 を足すと -0.0 が +0.0 になりうるので値をそのまま残す | テスト `same_bits_as_full_pass`（`old_one_step` と比べて同じビット）・`batches_equal_one_call` |
| `crates/pcv-core/src/csf.rs:Cloth::slope_post_process` | 論文 2.4（`movableFilter`・`findUnmovablePoint`・`handle_slop_connected`）。結果が順序に依存するので、列を先に（x が外、y が内）走査し、近傍は左・右・y-1・y+1 の順に訪ねる | ここ |
| `crates/pcv-core/src/csf.rs:Cloth::is_ground` | 所有者の非対称の決まり（Q20）: `-class_threshold_lower <= z - cloth_height <= class_threshold_upper`。論文と実装は対称の1つの閾値 | ここ |
| `crates/pcv-core/src/csf.rs` のテストの閾値 | 雑音の無い平らな場面なので、建物と外れ値の周りの縁の影響だけを見て 2 % の損失まで許す。急斜面の設定は、樹冠が重い（地面の反射 10 %）30・45 度の斜面でだけ recall が +0.19・+0.20 と一貫して上がった（`G1-T3-csf-core.md`）ので、その場合だけ確かめる（recall +0.1 以上、precision の悪化 0.05 以内） | ここ |
| `crates/pcv-core/src/dtm.rs:DtmJob` | 断面の線（`section_line`）と同じ作り方を点群全体に。分類の決まり（所有者の回答 Q7）: CSF の地面 → 2、元が 2 で地面でない → 1、ほかは元のまま（建物は建物のまま）。地面の点は DTM のセルの中心に最も近い1点だけを持つ（Q16）。TIN は `spade` の Delaunay で辺の長さの制限なし（建物の下は三角形が橋を架ける）。点は持たず、布と最良点の格子は面積で決まり、点を読む前に上限で断る。`z_base` を引いて大きな座標でも f32 の精度を保つ | ここ |
| `crates/pcv-core/src/dtm.rs:DTM_MAX_PARTICLES_DESKTOP`・`DTM_MAX_PARTICLES_WEB`・`DTM_MAX_CELLS_*` | デスクトップの布の上限は 1 粒子約 17 B で約 680 MB の最初の見積もり。Web は wasm のメモリ（最大 4 GiB）を reader と writer と分け合う。LandXML を作る Web は文をメモリで組むので小さい（TIN の頂点と面で約 70 バイト、デスクトップで測った） | ここ（測った根拠は `G1-T15-dtm.md`） |
| `crates/pcv-core/src/dtm.rs:ROUND_UP_TOLERANCE`・`with_exponent` | 2桁に切り上げるときに引く 1e-9 は、すでに丸い値（`0.3 / 0.01 = 30.000000000000004`）をそのまま残す。`with_exponent` は 10 進の文字列を経由して最も近い double にする（`71 * 0.1` は 7.1000000000000005） | 名前（定数に切り出した）。テスト `round_up_keeps_two_digits` |
| `crates/pcv-core/src/dtm.rs` の上限の文言 | 布の上限の文言はラスタ・断面と共有なので、DTM のセルの大きさの話に置き換える。勧める大きさは画面の単位で探し、確かめるときだけファイルの単位に戻す。4 桁の有効数字で単位の往復の雑音（0.5 m → ft → 1.6404199…）を隠す | ここ |
| `crates/pcv-core/src/dtm/landxml.rs` | 標準の要素だけ書く（J-LandXML の仕様は読んでいない）。`<P>` は northing easting elevation（Y X Z）。`spade` の面は反時計回りで、LandXML も上から見て反時計回りなのでそのまま書く。時刻は呼び出し側が読む（wasm32 で `SystemTime::now` は panic する）。日付は H. Hinnant の "civil from days" | テスト `landxml_points_are_north_east_elevation`。ほかはここ |
| `crates/pcv-core/src/raster/geotiff.rs` | 手書きの GeoTIFF の書き手（`G1-raster-and-dtm.md` 3節）: 汎用のタグ API でも結局タグは自分で書くうえ、形は単純（classic TIFF、little-endian、無圧縮、ストリップ）。`tiff` クレートはテストで読み戻すだけ。オフセットは書く前に全部分かるので前へ書くだけで、どんな `Write` にも書ける。画素は約 64 KiB のストリップずつで、画像の2つ目の写しを作らない。PixelIsArea なので画素 (0, 0) はセルの左上の角。EPSG が無いときは GeoKey を書かない（CRS 無しで「投影」と書くと知っている以上を主張する）。空のセルは黒でなく透明（alpha 0）。`ProjectedCSTypeGeoKey` は SHORT で、0 と 32767 以上は EPSG でない | TIFF のタグと値は名前（`TAG_*`・`COMPRESSION_NONE`・`GT_MODEL_TYPE_GEO_KEY` などの定数に切り出した）。ほかはここ |
| `crates/pcv-core/src/raster/grid.rs:GridSpec` | 行 0 は北（GeoTIFF と画像の画素の順）。原点はセルの倍数に切り下げ、隣のレイヤーのラスタとセルが揃う。グリッドの最大の辺の点は最後の列・行 0 に入れる（点群の最大の点がはみ出さない）。セルの数の上限で断る（面積に比例するので、巨大な点群や小さなセルでメモリを食い尽くさない） | テスト `cell_index_row_zero_is_north`・`points_on_max_edge_belong_to_last_cell`。ほかはここ |
| `crates/pcv-core/src/raster/color.rs:ELEVATION_RAMP` | `src/renderer/colormap.ts` の `ELEVATION_INTENSITY_RAMP`（CloudCompare の青 > 緑 > 黄 > 赤）の写し。Rust と TS で共有できないので、両方に同じ値のテストがある。プレビューと書き出しで同じ関数を使い、書き出しはプレビューの範囲を受け取って色を合わせる | テスト `ramp_matches_colormap_ts` と `colormap.test.ts` の「the Rust raster ramp」 |
| `crates/pcv-core/src/raster/output.rs` | ラスタは点群のレイヤーにしない（所有者の決定 2026-10-21、計画 13 節）。ファイルが成果物。デスクトップと Web の両方がここで終わるので出力が同じになる | ここ |
| `crates/pcv-core/src/raster/preview.rs:PREVIEW_POINT_BUDGET`・`CoarsePoints` | 全点を読むと大きな点群で分かかる（Shibuya で約3分）ので、窓を開いたときに上のレベルだけを予算まで読んで持ち、設定を変えるたびにそこから描く。持つ点は1点 32 バイトで `cap` まで。値は測って決めた（`G1-T11-raster-window.md`） | テスト `held_points_never_exceed_the_cap`・`depth_limit_skips_deeper_nodes`。値の根拠はここ |
| `crates/pcv-core/src/raster/preview.rs:FILL_MIN_NEIGHBOURS`・`fill_isolated_holes` | プレビューは間引いた点（1セル2〜3点）なので、たまたま空いたセルは周りが埋まっている。8近傍のうち 5 つ以上に値があれば平均で埋め、本当の隙間（川の縁・データの端）は残す。角は近傍が3つなので埋まらない。元の `cells` に対して判定し、連鎖させない。書き出しは埋めない。範囲は埋める前のセルからとる（埋めた値は範囲の内側なので凡例が変わらない） | テスト `the_fill_does_not_chain`・`edge_cells_count_only_existing_neighbours_and_corners_never_fill`・`export_colouring_leaves_holes_empty_while_the_preview_fills_them`。ほかはここ |
| `crates/pcv-core/src/raster/preview.rs:PreviewImage::to_bytes` | Tauri の `Response` と Worker の転送に共通のバッファ。ヘッダー 32 バイト（`u32 width, u32 height, u32 flags (bit 0: 範囲あり), f32 range min, f32 range max, f32 cell size, u32 points, u32 filled cells`）の後に RGBA。読み手は `src/datasource/raster-preview.ts` | ここ |
| `crates/pcv-core/src/section_line.rs:SectionLineJob` | 薄い断面だけに布を落とすと隙間から抜けるので、元のレイヤーの線 A→B の周りの広い帯（回廊）で地面を探す。布は (s, t) 平面に置き、格子を断面に揃える（ファイルの X・Y 軸でない）。布は線の両端より少し先まで広げて、端が布の縁にならないようにする。各セルで中心に最も近い地面の点だけを持ち（Q16）、TIN は `spade` の Delaunay で辺の長さの制限なし。凸包は直線を1区間で切るので、折れ線の途中に切れ目は無く、地面の届かない端で短くなるだけ | テスト `flat_ground_with_a_building_is_bridged`・`works_for_a_line_that_is_not_along_x`・`line_is_cut_where_the_ground_ends`・`bridges_a_gap_in_the_ground`。ほかはここ |
| `crates/pcv-core/src/section_line.rs` の結果のバッファ | ヘッダー 16 バイト（`u32 count, u32 flags (0), u32 ground_points, u32 cells`）の後に `count * 8`（`f32 s, f32 z`）。`s` は A から、`z` は `up` に沿った絶対の高さ（断面パネルと同じ） | ここ |
| `crates/pcv-core/src/section_line.rs` の既定値と `#[doc(hidden)]` の診断用の関数 | 回廊の既定の半幅はメートル（呼び出し側がファイルの単位に直す）。布の粒子の既定の上限は 5 km の線を 0.5 m で約 160 万。CSF のプリセット（標準・急勾配）は TS の `src/app/csf-params.ts` の1か所に置き、ここにはファイルの単位で届く。`debug_vertices` などは examples の診断用で、ジョブを何も変えない | ここ |
| `crates/pcv-core/src/crs/mod.rs:is_geotiff_epsg_code`・`MAX_GEOTIFF_EPSG_CODE` | GeoTIFF の `ProjectedCSTypeGeoKey` は SHORT で、0 と 32767（"user defined"）以上は EPSG でない。読む側（`crs/mod.rs` の2か所・`crs/describe.rs`）と書く側（`raster/geotiff.rs`・`raster/output.rs`）が同じ 1..=32766 を使う | 名前（関数1つにした）。テスト `geotiff_epsg_code_is_1_to_32766` |
| `crates/pcv-core/src/csf.rs` のテストの定数 | `MIN_RECALL_AND_PRECISION` 0.98: 雑音の無い平らな場面なので、建物と外れ値の周りの布の縁の影響だけ（2 %）を許す。`STEEP_SLOPE_DEG` 30・`HEAVY_CANOPY_GROUND_FRACTION` 0.1・`MIN_RECALL_GAIN` 0.1・`MAX_PRECISION_DROP` 0.05: 急斜面の設定が一貫して効いたのはこの場合だけで、測った recall の上がり幅は +0.19・+0.20（`G1-T3-csf-core.md`）なので +0.1 で確かめる。`SMALL_PARTICLE_CAP` 1,000,000 と `LARGE_PARTICLE_CAP` 4,100,000: 1000 m を 0.5 m で 2000 セル、余白 2 × 2 で一辺 2004 粒子、2004² = 4,016,016 のすぐ上。`EXTENT_M` 498（timing）: floor(498 / 0.5) = 996 セル、余白 4 で一辺 1000 粒子 | ここ |
| `crates/pcv-core/src/dtm/tests.rs` のテストの定数 | `MAX_BUFFERED_POINTS` = `POINTS_PER_ADVANCE` 2,000 + `POINTS_PER_NODE` 500: 1回の advance で読む点に、上限を越えて読み切る最後のノードを足す。`SMALL_PARTICLE_CAP` 1,000: 60 m を 0.5 m の布は約 124 × 124 ≈ 1万5千粒子なので断られる。`SMALL_CELL_CAP` 100: 60 m を 1 m の DTM は 61 × 61 = 3721 セルなので断られる。`LARGE_CAP` 2,000,000: 止めない側。`METRES_PER_FOOT`: ファイルはメートル、画面はフィート | ここ |
| `crates/pcv-core/src/section_line/tests.rs`・`profile/tests.rs`・`extract/all_points_tests.rs`・`raster/preview.rs`・`outlier.rs`・`tiles.rs` のテストの定数 | section_line: 線 10 m と両側の余白 5 m で `CORRIDOR_LENGTH_CELLS` 20、半幅 5 m の両側で `CORRIDOR_WIDTH_CELLS` 10（1 m のセル）。`MIN_POINTS` 50,000 はセルの数よりずっと多い点（実際は約 6 万点）。profile: `WALL_SIDE_POINTS` 200 で 4 万点の壁を `CAP` 1000 に間引く。all_points: `SIDE_POINTS` 40 で 1600 点、`POINTS_PER_NODE` 300 でノードが多数。preview: `SMALL_CAP` 50 はルートのノード（200 点）より小さいので途中で切れ、`LARGE_CAP` 1000 は上のレベルが収まる。outlier: `RELATIVE_TOLERANCE` 1e-9 は足す順だけが違うことに対する緩い許容。tiles: 点の密度 1 点/m² で、見積もりが `cap` 以下のタイルは約 cap + 周の長さ × 余白の点を持つので、周の上限 `PERIMETER_M_BOUND` 4 × 40 と見積もりの誤差 `ESTIMATE_ERROR_FACTOR` 2 倍で上限をとる | ここ |
| `crates/pcv-wasm/src/convert.rs`・`e57_import.rs`・`ply_import.rs`・`tests/buffered_file_reader_reduces_read_calls.rs` のテストの定数 | convert: `POINT_COUNT` 300,000 は LAZ のチャンク（約5万点）が約6個、`BATCH_SIZE` 1,000 はチャンクの境界をまたぐ、`boundaries_of_three_workers` は3つの Worker の範囲。e57: `BATCH_SIZE` 777 は `feed` のようなバッチで、走査の点数を割り切らない。ply: `BUFFER_BYTES` 64 はファイルを持てない小ささ（流れで読むことを確かめる）。buffered: `over_half_of_the_points` はバッファ無しの `read` の回数の下限（実測は点数の約9割、復号器の状態で 1:1 にならないので半分で確かめる）、`READ_BUFFER_BYTES` は `convert.rs` と同じ 4 MiB、`HEADER_READS` 4 はヘッダーの分の余裕 | ここ |

### 出典の記録（`crates/pcv-core/src/crs/` のコメントから移した）

- 横メルカトルの式: 河瀬和重(2011)「Gauss-Krüger投影における経緯度座標及び平面直角座標相互間の座標換算についてのより簡明な計算方法」国土地理院時報 121, 109-124（<https://www.gsi.go.jp/common/000061216.pdf>）。順変換は式(5)〜(12)、逆変換は式(13)〜(22)。記号は GSI の測量計算サイトの解説（<https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/algorithm/bl2xy/bl2xy.htm>・<https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/algorithm/xy2bl/xy2bl.htm>）に合わせた（2つの資料が同じ式であることは元の作業で突き合わせた、と元のコメント）
- GRS80: 河瀬(2011) p.119 のプログラム例（`a=6378137 ; rf=298.257222101`）。WGS84: NGA.STND.0036、a=6378137 m、1/f=298.257223563（EPSG:7030 と一致）。`n = 0.5/(rf-0.5)` は `1/(2F-1)` と同じ式（テストで確かめる）
- 平面直角座標系の原点: 国土地理院「平面直角座標系」<https://www.gsi.go.jp/LAW/heimencho.html>。河瀬(2011) p.119 の `phi0`・`lmbd0`（経度は分）とも19系すべてで一致することをテストで確かめる。縮尺係数 0.9999 は全系共通
- EPSG の対応: JGD2011 平面直角は 6668 + 系番号（<https://epsg.io/6669>・<https://epsg.io/6677>）、JGD2000 は 2442 + 系番号（<https://epsg.io/2443>）、UTM（WGS84 北半球）は 32600 + 帯番号。UTM の中央子午線は `6 * zone - 183`
- `crs::tests` の期待値（2026-09-24 に取得）: 国土地理院 測量計算 API（<https://vldb.gsi.go.jp/sokuchi/surveycalc/api_help.html>）。再現は `curl -sL "https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/bl2xy.pl?outputType=json&refFrame=2&zone=<系番号>&latitude=<緯度>&longitude=<経度>"`（逆は `xy2bl.pl?…&publicX=…&publicY=…`）。使った点: IX系 (35.681236, 139.767125)、I系 (33.1595, 129.7233)、XIX系 (26.5, 154.5)、IX系の端 (36.0, 141.3)、VII系の逆 (X=50000, Y=-20000)。`gridConv` は 9 桁で打ち切られるので 2e-6 度まで、緯度経度は 8 桁なので 2e-8 度（約 2 mm）まで許す
- 中央子午線から遠い所の検証: Karney (2011) "Transverse Mercator with an accuracy of a few nanometers", J. Geodesy 85:475-485 の `TMcoords.dat`（<https://sourceforge.net/projects/geographiclib/files/testdata/TMcoords.dat.gz>、WGS84・中央子午線 0 度・k0=0.9996）。2.4 GB を超えるので先頭 2,000,001 バイトだけ取って 1124 行目と 1063 行目を使った（`curl -s -r 0-2000000 "<URL>/download" | gzip -dc 2>/dev/null | sed -n '1124p;1063p'`）。リテラルは `clippy::excessive_precision` に合わせて f64 で意味のある桁に丸めた

## 記録

（作業エージェントが足す）

### 実装の記録 R1（作業役）

#### やったこと

- 範囲（`crates/pcv-core/`・`crates/pcv-wasm/`）の `.rs` のコメント 3,837 個（CM-0 の baseline の範囲の合計）を消し、`scripts/comment-baseline.json` から範囲の項目を全部消した（`node scripts/check-comments.mjs --lower-baseline` で、ファイルのまとまりごとに下げた）。残るコメントは例外の `// SAFETY:` の 6 行だけ（`git grep -n "// SAFETY" -- crates/pcv-core crates/pcv-wasm` で 6 件）
- 複数行の `// SAFETY:` と、`SAFETY` の形でなかった `unsafe impl` の理由を、`unsafe` の直前の1行にまとめた（`e57_import.rs` 2・`opfs.rs` 1・`file_reader.rs` 2・`http_reader.rs` 1）
- `Cargo.toml`（pcv-core・pcv-wasm）と `clippy.toml`（同じ2つ）の `#` のコメント 102 行を消した（`git diff d05c858 -- 'crates/*.toml' | grep -c "^-\s*#"`）。`Cargo.lock` は生成物なので触っていない
- `pcv-wasm` の文書コメントが写っていた生成物（`src/wasm/pcv-wasm/pcv_wasm.d.ts`・`pcv_wasm.js`・`pcv_wasm_bg.wasm`）を作り直してコミットした。d.ts・js の差分は削除だけ（`git diff --stat` で 514 行の削除、追加 0）
- 消し方: CM-0 の `findRustCommentRanges` と `findCountedComments`（例外を除く）で範囲を出す一時スクリプト（コミットしていない）で、コメントだけの行は行ごと、行末のコメントは前の空白ごと消した。消した所の前後だけで、2行以上の空行・ブロックの先頭と末尾の空行を詰めた（文字列の中の空行を触らないため、消した所の隣だけを見る）。その後 `cargo fmt`
- 振る舞いを変えない名前の変更・切り出し（下の表）。テストを1つ足した（`a_200_that_ignored_the_range_header_is_rejected_so_the_whole_file_is_never_read`）

#### 名前を変えた識別子と使い手（`git grep -nw <名前> -- crates` の数）

| 前 → 後 | ファイル | 使い手（定義を含む行数） |
|---|---|---|
| `Stats` → `BytesReadCounter` | pcv-wasm の 8 ファイル | 23 |
| 引数 `allow_zero` → `zero_is_end_of_file`（`check_opfs_len`） | `opfs.rs` | 2 |
| `SLOPE_HEIGHT_THRESHOLD` → `REFERENCE_SLOPE_HEIGHT_THRESHOLD_THAT_NEVER_REJECTS` | `csf.rs` | 3 |
| 引数 `id` → `unique_id`（`test_support::field`） | `test_support.rs` | 2（呼び出しは位置引数なので変わらない） |
| テストの定数 `FT` → `METRES_PER_FOOT` | `dtm/tests.rs` | 6 |
| テストの変数 `crs_a`・`crs_b` → `jgd2011_plane_ix`・`utm_54n` | `convert.rs` | 2・2 |
| 引数 `end` → `last_byte_inclusive`（`send_range_request`） | `http_reader.rs` | 関数の中だけ |

新しく切り出した名前（値・式は前と同じ）: `SYNCHRONOUS_ONLY_IN_A_WORKER`・`HTTP_PARTIAL_CONTENT`・`is_a_range_response_and_not_the_whole_file`（`http_reader.rs`）、`ZERO_IS_END_OF_FILE`・`ZERO_IS_AN_ERROR`（`opfs.rs`）、`PADDING_BYTE`（`node_format.rs`）、`LAS_SPEC_COLOR_DEPTH`（`copc.rs`）、`gamma_with_the_sign_of_gsi_grid_conv`（`transverse_mercator.rs`。`-(a).atan2(b)` を `a.atan2(b)` に分け、符号の反転を関数にした）、`HALF_A_CELL_PLUS_ONE_PERCENT_SLACK`（`thin.rs`）、`KEEP_ALREADY_ROUND_VALUES`（`dtm.rs`）、`TAG_*`・`COMPRESSION_NONE`・`PHOTOMETRIC_*`・`SAMPLE_FORMAT_*`・`GEO_KEY_*`・`GT_*`・`MODEL_TYPE_PROJECTED`・`RASTER_PIXEL_IS_AREA`・`ONE_VALUE`・`FIRST_USER_DEFINED_GEO_KEY_CODE`・`NO_NEXT_IFD`（`raster/geotiff.rs`、行末のコメントにあったタグの名前）、テストの変数 `compressed_size`・`uncompressed_size`（`pcd_import.rs`）

#### 採らなかった案

- 理由を全部名前とテストに移す: 3,837 個のうち多くは設計の理由・出典・測った値で、名前にすると長すぎる。名前・テストにできる物（魔法の数・真偽の引数・符号の反転）だけを移し、残りは上の「移した理由の記録」の表（99 行）と下の「出典」に書いた
- `ELEVATION_RAMP` などの行末のコメント（青・緑…）を名前にする: 値と `colormap.ts` との対応はテスト `ramp_matches_colormap_ts` が固定しているので、消すだけにした
- `Stats` のモジュール名 `stats.rs` も変える: ファイルの名前の変更で baseline のキーの付け替え（CM-0 の F-4）が要り、関心事が増えるので変えなかった

#### 確かめ方（実行したコマンド）

- `cargo test -p pcv-core` → `192 passed; 0 failed; 1 ignored`。`pcv-wasm` はルートのワークスペースの外なので `cargo test --manifest-path crates/pcv-wasm/Cargo.toml` → lib `58 passed; 1 ignored` と統合テスト 5 本が ok
- `cargo build -p pcv-core --target wasm32-unknown-unknown`、`cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown`（`-p pcv-wasm` はルートから選べないので manifest で）、`cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --all-targets -- -D warnings`（pages.yml と同じ。警告は vendor の copc-writer だけで終了コード 0）、`cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check`
- `npm run build:wasm` は `CARGO_TARGET_DIR` を共有の場所にしていると wasm-bindgen が `crates/pcv-wasm/target/...` を探して失敗するので、同じ cargo build の後に `wasm-bindgen --target web --out-dir src/wasm/pcv-wasm --out-name pcv_wasm C:/workspace/pcv-cargo-target/wasm32-unknown-unknown/release/pcv_wasm.wasm` を実行した。その後 `npm run check:wasm-glue` が終了コード 0
- `npm run check:docs` → OK（範囲のファイルの `path:line` を持つ文書は `git grep -nE "crates/pcv-(core|wasm)/[^ )]*\.rs:[0-9]+" -- TaskSheets docs` で 0 件。`src/code-limits.test.ts` の BASELINE に範囲のファイルは無い）
- 表に書いたテスト名は `git grep -lw "fn <名前>" -- crates` で全部あることを確かめた

#### 確かめていないこと

- ブラウザでの Web 版の動き（変換・開く・ラスタなど）は見ていない（未確認）。Rust の名前の変更と、生成物の d.ts・js の文書コメントの削除だけで、JS に出る名前（`js_name`）は変えていない
- 生成物の `pcv_wasm_bg.wasm` は大きさが変わった（2,084,497 → 2,082,842 バイト）。R1 では「panic の行番号などの文字列が縮んだため」と推定したが誤り。監査（CM-4-RP F-1）が確かめた主な原因は、panic の位置に埋め込まれたビルドしたディレクトリの絶対パス（37 か所。base は `C:\rust\point-cloud-viewer\.claude\worktrees\…`、R1 は `C:\workspace\pcv-wt-CM-4\…`）で、パスの頭を揃えると差は 27 バイト、エクスポート 72・インポート 76 は同じ。下の「CM-4-RP R1」を見よ

#### 触ったファイル

- `crates/pcv-core/**`・`crates/pcv-wasm/**`（`.rs`・`Cargo.toml`・`clippy.toml`）、`src/wasm/pcv-wasm/`（生成物）、`scripts/comment-baseline.json`、このシートの記録

### 実装の記録 R1 追補（作業役）

- 追加の指示（コメントを名前に移すときは「何が起きるか」を名前にし、使い手のいない戻り値を作らない／テストの数値の理由も定数名に移す）で見直した
- R1 で足した名前: 値を返す関数（`is_a_range_response_and_not_the_whole_file`・`gamma_with_the_sign_of_gsi_grid_conv`）の戻り値は全部使われている。void の関数は足していない。変えた名前は無い
- テストの数値に名前を付けた（値は変えていない）:
  - `csf.rs`: `ONLY_THE_CLOTH_EDGE_AROUND_THE_BUILDING_AND_THE_OUTLIER_MAY_BE_LOST`（0.98）、`STEEP_SLOPE_DEG`・`HEAVY_CANOPY_GROUND_FRACTION`・`MEASURED_RECALL_GAIN_ABOUT_0_19_ASSERTED_AS`・`PRECISION_MAY_DROP_AT_MOST`、`CAP_FAR_BELOW_THE_CLOTH`・`CAP_JUST_ABOVE_2004_SQUARED_PARTICLES_OF_1000_M_AT_0_5_M_PLUS_MARGIN`、`EXTENT_GIVING_996_CELLS_PLUS_4_MARGIN_IS_1000_PARTICLES_PER_SIDE`
  - `dtm/tests.rs`: `POINTS_PER_NODE`・`POINTS_PER_ADVANCE`・`ONE_ADVANCE_PLUS_THE_LAST_NODE`、`PARTICLE_CAP_BELOW_THE_ABOUT_15_THOUSAND_OF_60_M_AT_0_5_M`・`CELL_CAP_BELOW_THE_3721_OF_60_M_AT_1_M`・`CAP_THAT_DOES_NOT_STOP_IT`
  - `section_line/tests.rs`: `MANY_MORE_POINTS_THAN_CELLS`・`CELLS_OF_A_20_BY_10_M_CORRIDOR_AT_1_M`。`outlier.rs`: `ONLY_THE_SUMMATION_ORDER_DIFFERS`。`tiles.rs`: `ROOM_FOR_THE_ESTIMATE_ERROR`・`PERIMETER_POINTS_PER_M_OF_MARGIN_AT_ONE_POINT_PER_M2`
  - `raster/preview.rs`: `POINTS_PER_NODE`・`CAP_SMALLER_THAN_THE_ROOT_NODE`・`CAP_THE_UPPER_LEVELS_FIT_IN`。`profile/tests.rs`: `WALL_SIDE_GIVING_40_000_POINTS`・`CAP_FAR_BELOW_THE_WALL`。`extract/all_points_tests.rs`: `SIDE_GIVING_1600_POINTS`・`NODE_SIZE_GIVING_MANY_NODES`
  - `convert.rs`: `ABOUT_SIX_LAZ_CHUNKS_OF_POINTS`・`BATCH_THAT_CROSSES_CHUNK_BOUNDARIES`・変数 `three_workers`。`e57_import.rs`: `FEED_LIKE_BATCH_THAT_DOES_NOT_DIVIDE_THE_SCAN`。`ply_import.rs`: `TOO_SMALL_TO_HOLD_THE_FILE_BYTES`。`tests/buffered_file_reader_reduces_read_calls.rs`: `MEASURED_ABOUT_90_PERCENT_SO_ASSERT_OVER_HALF`・`SAME_AS_READ_BUFFER_BYTES_IN_CONVERT_RS`（`READ_BUFFER_BYTES` から改名、使い手 4）・`ROOM_FOR_THE_HEADER_READS`
- 確かめ方: `cargo test -p pcv-core`（192 passed、1 ignored）、`cargo test --manifest-path crates/pcv-wasm/Cargo.toml`（lib 58 passed、1 ignored）、pcv-wasm の wasm32 の clippy（`-D warnings`、終了コード 0）。テストの中だけの変更なので wasm の生成物は変わらない

### 監査の指摘への対応（CM-4-RP R1、作業役）

- F-1（should、wasm の大きさの理由）: 上の「確かめていないこと」の1行を直した。差の主な原因はビルドしたディレクトリの絶対パスで、監査役の調べ（37 か所、頭を揃えると 27 バイト、エクスポート 72・インポート 76 は同じ）を写した。自分では測り直していない。絶対パスが入って再現できない件は、メインが別タスクに起こす（直さない）
- F-2（should、同じ境界が数値のまま）: `crs/mod.rs` に `MAX_GEOTIFF_EPSG_CODE`（32766）と `is_geotiff_epsg_code(code: u32) -> bool`（`1..=32766`）を置き、`crs/mod.rs:detect_crs_from_las_header`・`crs/mod.rs:crs_id_from_las_header`・`crs/describe.rs:describe_names`（`(1..=32766).contains`）、`raster/output.rs:missing_crs_warning`（`code != 0 && code < 32767`）、`raster/geotiff.rs:write_tiff`（`code == 0 || code >= 32767` で断る。`!is_geotiff_epsg_code` にした）の5か所から呼ぶ。どれも 1..=32766 が通る・0 と 32767 以上が通らない、で元と同じ。`FIRST_USER_DEFINED_GEO_KEY_CODE` は消した。テスト `geotiff_epsg_code_is_1_to_32766`（0・1・32766・32767）。監査は3か所と書いたが、`crs/mod.rs` にもう1か所（`crs_id_from_las_header`）と `crs/describe.rs` にあった
- F-3（should、読み違えやすい名前）と F-5（nit）、それに名前の決まり（名前は「それが何か」だけ。文の形と計算を入れない）での見直し。R1 と R1 追補で足した名前を全部見直した:

  | 前 → 後 | 使い手（定義を含む） |
  |---|---|
  | `SYNCHRONOUS_ONLY_IN_A_WORKER`（定数） → 変数 `is_async = false` | 1 |
  | `is_a_range_response_and_not_the_whole_file` → `is_partial_content` | 4 |
  | 定数 `ZERO_IS_END_OF_FILE`・`ZERO_IS_AN_ERROR`、引数 `zero_is_end_of_file: bool` → 型 `ZeroLength { EndOfFile, Error }`、引数 `zero_length`（テスト名 `check_opfs_len_zero_depends_on_allow_zero` → `…_on_zero_length`） | 呼び出し 4・テスト 7 |
  | `gamma_with_the_sign_of_gsi_grid_conv` → `gsi_signed_gamma`、`gamma_as_kawase_eq_7`・`_eq_15` → `kawase_gamma` | 3・2・2 |
  | `HALF_A_CELL_PLUS_ONE_PERCENT_SLACK` → `MARGIN_PER_CELL_SIZE` | 2 |
  | `KEEP_ALREADY_ROUND_VALUES` → `ROUND_UP_TOLERANCE` | 2 |
  | `REFERENCE_SLOPE_HEIGHT_THRESHOLD_THAT_NEVER_REJECTS` → `NEVER_REJECTING_SLOPE_HEIGHT_THRESHOLD` | 3 |
  | csf のテスト: `ONLY_THE_CLOTH_EDGE_…_MAY_BE_LOST` → `MIN_RECALL_AND_PRECISION`、`MEASURED_RECALL_GAIN_ABOUT_0_19_ASSERTED_AS` → `MIN_RECALL_GAIN`、`PRECISION_MAY_DROP_AT_MOST` → `MAX_PRECISION_DROP`、`CAP_FAR_BELOW_THE_CLOTH` → `SMALL_PARTICLE_CAP`、`CAP_JUST_ABOVE_2004_SQUARED_…` → `LARGE_PARTICLE_CAP`、`EXTENT_GIVING_996_CELLS_…` → `EXTENT_M` | 3・2・2・2・2・3 |
  | dtm のテスト: `ONE_ADVANCE_PLUS_THE_LAST_NODE` → `MAX_BUFFERED_POINTS`、`PARTICLE_CAP_BELOW_THE_ABOUT_15_THOUSAND_…` → `SMALL_PARTICLE_CAP`、`CELL_CAP_BELOW_THE_3721_…` → `SMALL_CELL_CAP`、`CAP_THAT_DOES_NOT_STOP_IT` → `LARGE_CAP` | 3・2・2・3 |
  | section_line のテスト: `MANY_MORE_POINTS_THAN_CELLS` → `MIN_POINTS`、`CELLS_OF_A_20_BY_10_M_CORRIDOR_AT_1_M`（200） → `CORRIDOR_LENGTH_CELLS`（20）× `CORRIDOR_WIDTH_CELLS`（10） | 2・1 |
  | outlier: `ONLY_THE_SUMMATION_ORDER_DIFFERS` → `RELATIVE_TOLERANCE`。tiles: `ROOM_FOR_THE_ESTIMATE_ERROR` → `ESTIMATE_ERROR_FACTOR`、`PERIMETER_POINTS_PER_M_OF_MARGIN_AT_ONE_POINT_PER_M2` → `PERIMETER_M_BOUND` | 3・2・2 |
  | preview: `CAP_SMALLER_THAN_THE_ROOT_NODE` → `SMALL_CAP`、`CAP_THE_UPPER_LEVELS_FIT_IN` → `LARGE_CAP`。profile: `WALL_SIDE_GIVING_40_000_POINTS` → `WALL_SIDE_POINTS`、`CAP_FAR_BELOW_THE_WALL` → `CAP`。all_points: `SIDE_GIVING_1600_POINTS` → `SIDE_POINTS`、`NODE_SIZE_GIVING_MANY_NODES` → `POINTS_PER_NODE` | 4・4・3・4・2・2 |
  | convert のテスト: `ABOUT_SIX_LAZ_CHUNKS_OF_POINTS` → `POINT_COUNT`、`BATCH_THAT_CROSSES_CHUNK_BOUNDARIES` → `BATCH_SIZE`、`three_workers` → `boundaries_of_three_workers`。e57: `FEED_LIKE_BATCH_THAT_DOES_NOT_DIVIDE_THE_SCAN` → `BATCH_SIZE`。ply: `TOO_SMALL_TO_HOLD_THE_FILE_BYTES` → `BUFFER_BYTES` | 5・2・2・3・2 |
  | buffered のテスト: `MEASURED_ABOUT_90_PERCENT_SO_ASSERT_OVER_HALF`（割る数 2） → 結果の変数 `over_half_of_the_points`、`SAME_AS_READ_BUFFER_BYTES_IN_CONVERT_RS` → `READ_BUFFER_BYTES`（元の名前に戻した）、`ROOM_FOR_THE_HEADER_READS` → `HEADER_READS` | 2・4・2 |

  消えた「なぜ」と計算は、上の「移した理由の記録」の表に移した（テストの定数の5行と `is_geotiff_epsg_code` の行を足し、名前の変わった7行を直した）。範囲の名前を `git grep -nE "(const|let|fn|static|struct|enum) [A-Za-z_]*(_THE_|_the_|_AND_|_and_|_THAN_|_than_|_WHEN_|_when_|_SO_|_so_|_IS_|_is_)" -- crates/pcv-core crates/pcv-wasm` で探し、残りは GeoTIFF の仕様の名前（`PHOTOMETRIC_BLACK_IS_ZERO`・`RASTER_PIXEL_IS_AREA`）、`MIN_RECALL_AND_PRECISION`、元からあった `check_layout_and_crs_match`・`crs_is_missing`・`push_order_and_reopen`、テスト名（振る舞いの文にする決まり）だけ。元からある名前はこれ以上変えていない
- F-4（nit）: `ADR-0012-web-worker-sync-io.md` と `G1-T3-csf-core.md` に改名の1行を足した（範囲外、メインの許し）
- 確かめ方: `cargo test -p pcv-core`（193 passed、1 ignored）、`cargo test --manifest-path crates/pcv-wasm/Cargo.toml`（lib 58 passed、1 ignored、統合テストも ok）、pcv-wasm の wasm32 の clippy（`-D warnings`、終了コード 0）、`cargo clippy -p pcv-core --all-targets -- -D warnings`。wasm に見える名前（`js_name`）は変えていない。生成物を作り直して `check:wasm-glue` が通ることを確かめた
