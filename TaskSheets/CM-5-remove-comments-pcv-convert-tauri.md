# CM-5: コメントを消す（`crates/pcv-convert/`・`src-tauri/`）

- 共通の決まり・例外・「なぜ」の移し方: [CM-0-no-comments.md](./CM-0-no-comments.md)（CM-0 が先に main に入っていること）
- 範囲: `crates/pcv-convert/`・`src-tauri/`（各 `Cargo.toml` の `#` のコメントも。`src-tauri/tauri.conf.json` は JSON なので無い）。範囲の外のファイルは触らない（並行して別の作業役が消している）
- 方針: 振る舞いは変えない。push しない

## 受け入れ基準

- **AC-1** 範囲のファイルについて `scripts/comment-baseline.json` の項目が無くなり（上限 0）、`npm run check:comments` が通る。例外（CM-0 の「例外」）だけが残る
- **AC-2** 消したコメントが、コードから読めない意図を持っていた所では、CM-0 の順（名前 → テストの名前 → このシートの「移した理由」）で移す。
  名前を変えたら使い手を全部直す（`grep` の数を作業報告に書く）。名前の変更と関数の切り出し以外の変更はしない（振る舞いを変えない）
- **AC-3** コメントだけの行を消した後に、空行が2行以上続く・ブロックの先頭が空行になる、などの跡を残さない（整形ツールが通る）
- **AC-4** `src/code-limits.test.ts` の BASELINE など、行数に依存する検査・文書（ADR-0024 などの `path:line` の参照）を、縮んだ行数に合わせて直す（`npm run check:docs` が通る）
- **AC-5** `npm run check:all` が全部 OK
- `cargo test -p pcv-convert` と、`src-tauri` のクレートの `cargo test`（または `cargo check`）が通ること

## 移した理由の記録

| ファイル:識別子 | 消したコメントの要点 | 移し先（名前／テスト名／ここ） |
|---|---|---|
| `crates/pcv-convert/src/writer.rs:HeaderFields::write` | global encoding の WKT ビット（0x10）を、WKT の VLR を書かないのに立てる。`pcv-core` の読み込み側が COPC（点フォーマット 6〜10）にこのビットを必須にしているため。M4-1 のスパイクは CRS を運ばない（M4-5 の範囲） | 名前 `GLOBAL_ENCODING_WKT_BIT_REQUIRED_BY_PCV_CORE_FOR_COPC` ＋ここ |
| `crates/pcv-convert/src/writer.rs:HeaderFields::write` | ヘッダの各フィールド（file source id・GUID・版・VLR の数・LAZ 圧縮ビット・1.4 で 0 の旧点数・波形・EVLR の数・リターン別点数） | 名前 `NO_FILE_SOURCE_ID`・`UNUSED_PROJECT_GUID`・`LAS_VERSION_MAJOR`/`MINOR`・`VLR_COUNT_LASZIP_AND_COPC_INFO`・`POINT_FORMAT_LAZ_COMPRESSED_BIT`・`LEGACY_POINT_COUNT_UNUSED_IN_LAS_1_4`・`NO_WAVEFORM_DATA_PACKET`・`EVLR_COUNT_ONE_HIERARCHY_PAGE`・`NO_POINTS_BY_RETURN_CARRIED`・`VLR_RESERVED` |
| `crates/pcv-convert/src/writer.rs:write` | 最初の `compress_one` の前に `reserve_offset_to_chunk_table` を呼ぶ。呼ばないと `compress_one` が自分で 8 バイトを予約し、根ノードの `Entry.offset` が 8 バイトずれて、根の `read_node` が EOF になる不具合を実際に踏んだ。COPC info の VLR は仕様で最初の VLR（offset 375）なので LASzip の VLR より先に書く | ここ |
| `crates/pcv-convert/src/writer.rs:classification_point` | 分類 12（重複点）は `las::point::Classification::new` が拒むので、`Unclassified`＋`is_overlap` に読み替える。他の不正な値も変換を止めず `Unclassified` に落とす | 名前 `LAS_1_4_OVERLAP_CLASS_REJECTED_BY_LAS_CRATE` ＋ここ |
| `crates/pcv-convert/src/import/convert.rs:StreamingLayout` | `point_format` は `copc-writer` の検証・書き出しで使われない（色の有無で 6/7 を決める。`vendor/copc-writer` の `validate_streaming_layout_supported`・`write_copc_inner`） | 名前 `POINT_FORMAT_IGNORED_BY_COPC_WRITER_WHICH_PICKS_6_OR_7_FROM_COLOR` |
| `crates/pcv-convert/src/import/convert.rs:source_read_and_decode` | E57/PLY/PCD の読み込み（パース）を直接測るフックが無いので、`for_each_point` 全体の時間から `spill.push` の時間を引く。`Instant` の揺れでマイナスになりうるので `saturating_sub` | ここ |
| `crates/pcv-convert/src/crs_override.rs`・`merge.rs` のテストの GeoKey ディレクトリ | GeoKeyDirectoryTag のバイナリの並び（版・改訂・キーの数・ProjectedCRSGeoKey 3072・値を直に置く 0・個数 1） | 関数 `geo_key_directory_with_one_projected_crs_key` と、その中の変数名 |
| `crates/pcv-convert/src/disk_space.rs:free_bytes_at`（unix） | `f_bfree` でなく `f_bavail` を使うのは、Windows の `GetDiskFreeSpaceExW` の「呼び出し元が使える空き」と揃えるため。`TEMP_SIZE_FACTOR` の 11 は ADR-0006 の実測（sofi.copc.laz） | ここ（11 倍の根拠は ADR-0006） |
| `crates/pcv-convert/src/merge.rs:MergeError` | CRS の食い違いの `Crs` を `Box` に入れるのは、`Crs` が 128 バイトあり `clippy::result_large_err` に当たるため | ここ |
| `crates/pcv-convert/src/import/pcd.rs` のヘッダの判定 | `DATA` 行の判定を `pcd-rs` の `load_meta` と同じ（空白区切りの先頭トークン、大文字小文字を区別）にして、本読み込みと食い違わないようにする。`rgb` が想定外の型なら変換を止めず色無しにする | ここ |
| `crates/pcv-convert/src/import/e57.rs:E57Source` | `CartesianCoordinate::Valid` でない点（方向だけ、グリッドの欠測スロット）は書かない。そのため `visit` の回数が E57 の申告点数 `pc.records` より少なくなりうる | ここ |
| `crates/pcv-convert/src/cache.rs` の複数ファイルの指紋 | (名前, サイズ, 更新日時) を並べ替えてから1本のハッシュに畳む。XOR で合成する案は、同じファイルを2回選ぶと打ち消し合うので採らなかった。エポックより前の更新日時は 0 に丸める（作り直す側にしか転ばない） | テスト `multi_fingerprint_is_order_independent` ＋ここ |
| `crates/pcv-convert/src/streaming.rs:READ_BATCH_SIZE` ほか | 別プロセスを起こさず `AtomicCancel` で止める（Android はアプリごとに別プロセスを立てられない）、LAZ の展開の並列化とバッチの大きさ（1Mi 点）は実測で選んだ | `TaskSheets/M4-import-and-conversion.md` の M4-1b・M4-7（既にある） |
| `crates/pcv-convert/Cargo.toml` の features | `laz-parallel`（M4-7）・`parallel-lod`（M4-8）・`parallel-compress`（M4-10。出力のバイトは変わるが点の集合は同じ、と所有者が 2026-10-03 に承認）。`crates/pcv-wasm` は別のワークスペースで `default-features = false` なので rayon が wasm に入らない | テスト `parallel_compress_point_set_matches_sequential`、`TaskSheets/M4-import-and-conversion.md`、`vendor/copc-writer/PATCH.md`（既にある） |
| `crates/pcv-convert/Cargo.toml` の `chrono`（dev） | 合成 LAS の作成日を固定しないと、`copc-writer` が今日の日付で埋めて出力のハッシュが日ごとに変わった | テスト `native_output_hash_matches_recorded_value` |
| `src-tauri/src/conversion.rs:redirect_os_temp_dir` | `copc-writer` の LOD の一時ファイルは `spill_dir` を無視して OS の一時ディレクトリに作られるので、`TMPDIR`（Windows は `TMP`/`TEMP`）を書き換える。`set_var` は他のスレッドが環境変数を読んでいると競合するので、起動直後の `setup` か、変換のスレッドを立てる前にだけ呼ぶ | `// SAFETY:` の1行（`unsafe` の直前）＋ここ（ADR-0006 の追記） |
| `src-tauri/src/conversion.rs:supports_custom_temp_dir` | Android の SAF が返す木は `content://` で、`tempfile` が要る実在のパスにならないので、一時ディレクトリの手動選択はデスクトップだけ | ここ |
| `src-tauri/src/conversion.rs`・`copc_state.rs` のファイルの開き直し | `File::try_clone` はシーク位置を共有するので、判定用と変換用（プールの各リーダー）で別々に開く | テスト `independently_opened_file_handles_have_independent_seek_positions` |
| `src-tauri/src/conversion.rs` の LAS/LAZ の点数 | `convert_and_timings` は点数を返さないので、進捗の最後の `points_read` を内訳の点数に使う（最後に必ず `points_read == total_points` で呼ばれる） | ここ |
| `src-tauri/src/copc_state.rs:CopcPool` | `read_node` の panic を `catch_unwind` で受け、その `CopcFile` はプールに戻さず捨てて `replenish_after_panic` で1本開き直す（`&mut self` の途中の状態を信用しない）。`idle` の Mutex は panic の間持たない。プールの大きさ（論理コア数）は ADR-0007 の追記で実測 | 名前 `replenish_after_panic`・`default_pool_size`、ADR-0013・ADR-0007（既にある） |
| `src-tauri/src/copc_state.rs:PANIC_ON_NEXT_READ` | テスト専用の一回限りのフラグ。`cargo test` はテストを別スレッドで並行に走らせるので、スレッドローカルにする | ここ |
| `src-tauri/src/lib.rs:stale_generation_response` | 開き直しの後に届いた古い世代の要求は、クライアントの誤り（400）でもサーバーの失敗（500）でもない普通の競合なので、警告のログを出さず 409 を返す。フロントの `StaleNodeRequestError` が黙って捨てる | 名前 `stale_generation_response` ＋ここ |
| `src-tauri/src/lib.rs:init_logging` | Android の標準出力・標準エラーは logcat に出ないので、`log` を通して Android は `android_logger`、デスクトップは `env_logger` に出す。panic のフックは、落ちる前にメッセージを残すため（ADR-0013） | ADR-0013（既にある） |
| `src-tauri/src/main.rs` の `windows_subsystem` | リリースビルドの Windows で余分なコンソールの窓を出さないための属性。消さない（Tauri のひな形のコメント「DO NOT REMOVE」） | ここ |
| `src-tauri/Cargo.toml` の `[lib] name = "pcv_tauri_lib"` | `_lib` の接尾辞は bin の名前とぶつからないため（Windows でだけ問題になる。rust-lang/cargo#8519。Tauri のひな形のコメント） | ここ |
| `src-tauri/Cargo.toml` の `percent-encoding` | フロントの `convertFileSrc` が引数全体を `encodeURIComponent` するので `/` が `%2F` で届き、`parse_pcv_path` でデコードする。`url` が既に同じ版を入れているので、新しいクレートは増えない | ここ |
| `crates/pcv-convert/src/import/convert.rs` のテスト・`tests/streaming_conversion.rs`・`tests/import_merge_memory_is_bounded.rs` の小さいメモリ予算（64 KiB・256 KiB） | 小さい予算にすると octree がディスク上で分けられる。既定ではメモリの中で終わり、その経路を通らない（ADR-0019）（監査 F-1） | 定数 `MEMORY_BUDGET_SMALL_ENOUGH_TO_SPLIT_THE_OCTREE_ON_DISK`（3 ファイルに1つずつ） |
| `src-tauri/src/lib.rs` の `pcv://` の応答の `Access-Control-Allow-Origin: *` | 開発中は devUrl `http://localhost:1420` から fetch するので `pcv://` とオリジンが違い、無いと "Failed to fetch"（`tauri::app::register_uri_scheme_protocol` のドキュメント）（監査 F-2） | 関数 `allow_fetch_from_dev_server_origin`、テスト `every_pcv_response_allows_fetch_from_the_dev_server_origin` |
| `crates/pcv-convert/src/import/ply.rs:scale_channel_to_u16` ほか | 8 bit（0〜255）を 16 bit（0〜65535）へ過不足なく写す（255 × 257 = 65535） | 定数 `U8_TO_U16_FULL_RANGE_FACTOR` |
| `crates/pcv-convert/src/import/pcd.rs:MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES` | 512 MiB は実測でなく見積もり。`pcd-rs` の展開は展開後の大きさの2倍のバッファを同時に持つので、ピークが 1〜1.5 GiB に収まり、RAM 4 GB の Android（ADR-0006 の基準）でも動く見込み、という判断 | ここ |
| `src-tauri/src/conversion.rs:RASTER_MAX_CELLS_DESKTOP` | 1 セル最大 36 バイト（RGB）で約 2.3 GB の格子（見積もり。測ったのは 30.7M セルの RGB でピーク 1.29 GiB） | ここ（値の選び方は `TaskSheets/G1-T6-rasterize-tool.md`） |
| `src-tauri/src/copc_state.rs:default_pool_size` | 論理コア数を取れないときの `4` は仮の値（論理コア数にする根拠は ADR-0007 の追記） | ここ |

## 記録

（作業エージェントが足す）

### 実装の記録 R1（作業役）

#### やったこと

- 範囲の Rust 65 ファイルのコメント 3,237 個（`scripts/comment-baseline.json` の範囲の項目の合計。コミットごとに消した項目の数を足した: 1098＋482＋390＋462＋388＋244＋173）を消し、baseline から範囲の 65 項目を全部消した。残したのは `unsafe` の直前の1行の `// SAFETY:` 4 つ（`crates/pcv-convert/src/disk_space.rs` 2・`src-tauri/src/conversion.rs` 1・`crates/pcv-convert/tests/import_merge_memory_is_bounded.rs` 1）。複数行だった 3 つ（disk_space.rs 2・conversion.rs 1）は1行にまとめた
- `crates/pcv-convert/Cargo.toml`（約 70 行）と `src-tauri/Cargo.toml`（約 15 行）の `#` のコメントを消した（検査の対象外なので数は baseline に無い）
- 消し方: `scripts/check-comments.mjs` の `findRustCommentRanges` と `findCountedComments` で、検査が数えるコメントだけを選び、コメントだけの行は行ごと、行末のコメントは前の空白ごと消す一時的なスクリプト（コミットしていない）で消し、`cargo fmt --all` で整えた。消した後に、ブロックの先頭の空行・3 行以上の改行・ファイル先頭の空行・属性の後の空行が無いことを一時的なスクリプトで確かめた（当たり 0）
- 名前・関数にした所（上の「移した理由の記録」の表）: `writer.rs` の LAS ヘッダの値と分類 12 に定数 15 個（`NO_FILE_SOURCE_ID`・`LAS_1_4_OVERLAP_CLASS_REJECTED_BY_LAS_CRATE` など）、`import/convert.rs` に `POINT_FORMAT_IGNORED_BY_COPC_WRITER_WHICH_PICKS_6_OR_7_FROM_COLOR`、`crs_override.rs`・`merge.rs` のテストに関数 `geo_key_directory_with_one_projected_crs_key`（同じ 8 行の並びを、各テストモジュールに1つずつ）。どれも新しい名前で、既存の識別子の名前は変えていない（使い手を直す必要は無い）
- 「移した理由の記録」の表に 26 行を書いた（移し先の欄に、名前・テスト名・既にある ADR とタスクシート・「ここ」のどれに移したかを書いた）。3,237 個のうち多くは、関数・型の名前から読める説明か、経緯（M4 などのタスク番号）で、移さずに消した
- `TaskSheets/ADR-0024-progressive-open.md` の `path:line` 参照（`streaming.rs:270→114`、`merge.rs:506→360`）と「数えた物」の行番号（`import/merge.rs:47`・`import/mod.rs:96`・`merge.rs:360`・`streaming.rs:114`）を、`grep -rn -E "pub fn convert_and_timings|pub fn merge_paths_and_timings|pub fn convert_paths_to_copc_and_timings|pub fn convert_to_copc_and_timings" crates/pcv-convert/src` の出力に合わせた。`src/code-limits.test.ts` に範囲のファイルは無い

#### 採らなかった案

- `redirect_os_temp_dir` の名前に前提（他のスレッドが走る前に呼ぶ）を入れる: `docs/book/` と `TaskSheets/M4-*.md` がこの名前で参照しており、範囲の外のファイルを触ることになるので、`// SAFETY:` の1行とこの表に書いた
- `streaming.rs` などの `READ_BATCH_SIZE`（実測で選んだ値）の名前を変える: 範囲の 5 ファイル（examples を含む）にあり、根拠は M4-7 の記録に既にあるので変えなかった

#### 確かめていないこと

- 消したのはコメントと、新しい定数・関数への置き換えだけで、実機（Android・デスクトップの画面）での動きは確かめていない（未確認。振る舞いを変える変更はしていないつもりで、根拠は下のテスト）
- `src-tauri` の Android 向けの分岐（`cfg(target_os = "android")`）はこの PC でビルドしていない（未確認）

#### 確かめ方

- `npm run check:comments` → `comments OK (342 files with 9024 comments left in scripts/comment-baseline.json)`。`grep -cE '"(crates/pcv-convert|src-tauri)' scripts/comment-baseline.json` → 0
- `cargo test -p pcv-convert`、`src-tauri` で `cargo test -p pcv-tauri`、`npm run check:all`（結果は作業報告）
- 所有者の確認: `git diff d05c858..HEAD -- crates/pcv-convert src-tauri` で、消えた行がコメントだけで、足した行が上の定数と関数、1行にまとめた `// SAFETY:`、`cargo fmt` の折り返しだけであることを見る

### 監査の指摘への対応（CM-5 R1 の APPROVE の後、CM-5-RP R1）

- F-1（should）: 3 ファイルの小さいメモリ予算を定数 `MEMORY_BUDGET_SMALL_ENOUGH_TO_SPLIT_THE_OCTREE_ON_DISK` にした（9bb3794）。テストは同じ値で走る
- F-2（should）: `pcv://` の4つの応答の CORS ヘッダを関数 `allow_fetch_from_dev_server_origin` に出し、4つの応答が全部ヘッダを持つことをテスト `every_pcv_response_allows_fetch_from_the_dev_server_origin` で確かめる（9ce7be9）。ヘッダを足す順番が `status` の前に変わったが、HTTP のヘッダの集合は同じ
- 構成の負債（should）: `import/convert.rs` の `PROGRESS_REPORT_STRIDE` を消して `streaming.rs` のものを使う（4410008）。下のスクリプトで見つけた同じ形の `READ_BATCH_SIZE`（`merge.rs`・`import/las.rs`）も `streaming.rs` の1つにした（`pub(crate)`）。examples の `READ_BATCH_SIZE` はクレートの外なので残した
- F-3（nit）: リターン別の旧点数に `LEGACY_POINTS_BY_RETURN_UNUSED_IN_LAS_1_4` を足した（2131c14）
- F-4（nit）: `statvfs` の2つ目の `unsafe` の前にも `// SAFETY:` の1行を置き、1つ目の行は `zeroed` の根拠に書き直した（177954c）
- 再発防止: `scripts/removed-comments-near-literals.mjs` を足した（`TaskSheets/RECURRENCE.md` の「CM-5」）。CM-5 の範囲に当てた結果（186 件）を見て、PLY の `257` を `U8_TO_U16_FULL_RANGE_FACTOR` にし（509f471）、上の表に 6 行を足した。残りはテストのデータ・LAS の書式の固定値・既に名前のある定数で、名前にしなかった

### 監査の記録

| ラウンド | 監査役 | 判定 | 主な指摘 |
|---|---|---|---|
| R1 | ループ | APPROVE | コメントを除いた比較で差は5ファイルの定数化と関数の切り出しだけ。F-1 [should] テストの小さいメモリ予算の理由が消えた、F-2 [should] `pcv://` の CORS ヘッダの理由（開発サーバーのオリジン）が消えた、F-3〜F-5 [nit]、構成の負債 `PROGRESS_REPORT_STRIDE` の重複 |
| RP R1 | ループ | APPROVE | 仕組み `scripts/removed-comments-near-literals.mjs` が R1 のコミットで F-1・F-2 を全部出すことを確かめた（193 件中）。nit F-1〜F-3（行の数値を全部出す、根以外から実行すると 0 件、テスト名が長い）は 4fb7e82・2bd2f7b で直した |
| PR R1 | PR・CI | CHANGES_REQUESTED | CI run 44442780113 は緑。F-1 [must] `docs/book/src/rust/pcv-convert.md:151` が消えた冒頭のコメントを指す。F-2 [should] RECURRENCE のハッシュが付け替え前。F-3 [nit] 6→7 ケース |
| PR R2 | PR・CI | APPROVE | CI run 44444111622 は緑。F-4 [should] この表のハッシュ、F-5 [should] M4-4 の追記へのアンカーのずれ（もとから）→ メインがマージ前に直した |
