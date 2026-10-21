# G3-T16: 間引き・フィルタの画面と入口（デスクトップ・Web）（G3-5）

- 日付: 2026-10-22
- 状態: **依頼（コーディネーターが書いた受け入れ基準）**。実施の記録は、この文書の下に「実施の記録」の節を足して書く
- 計画: [G1-raster-and-dtm.md](./G1-raster-and-dtm.md) の 11 節。Rust の中身は済んでいる（[G3-T7](./G3-T7-thin-filter-core.md): `pcv_core::thin`・`outlier`・`tiles`、`pcv_convert::thin_filter::thin_path` / `filter_path`）
- 手本: ラスタ化・断面線の入口（`src-tauri/src/conversion.rs` の `run_tool`、`crates/pcv-wasm/src/extract.rs`・`section_line.rs`、`src/app/point-cloud-tools.ts` の `runTool`）

## 1. 利用者から見た形

リボンに **「間引き」**（`ThinButton.tsx`）と **「フィルタ」**（`FilterButton.tsx`）。選んだ点群レイヤー1つに対してダイアログ（`SectionDialog` と同じ `Dialog`）を開く。
長さはすべて表示単位（m / ft）で入れ、ファイルの単位に換算して Rust に渡す（断面と同じ `displayLengthToFile`）。

- `ThinDialog.tsx`: 方式 **グリッド（2D）/ ボクセル（3D）**、大きさ（既定 0.1 m）、残す点（グリッド: セル中心に最も近い / 最も低い / 最も高い。ボクセル: 中心に最も近い だけ）
- `FilterDialog.tsx`: 方式 **ROR（半径）/ SOR（統計）**。ROR: 半径 r（既定 0.5 m）・最小の近傍数 m（既定 4）。SOR: 近傍数 k（既定 8）・倍率 n（既定 2.0）・探す範囲 R。
  R の既定は、レイヤーのヘッダーの点数と XY の面積から点の平均の間隔を見積もり、その 10 倍（G3-T7 の「R は点の間隔の数倍以上」）。見積もりの式は `src/app/` の純粋な関数にして単体テストを置く。
  SOR は点を2回読むので時間が2倍かかる、と一文添える
- それぞれのプリセットの値（既定）は `src/app/` の1つの表（定数）に置く。ダイアログはそれを表示するだけ

実行すると（進捗・キャンセルは既存のツールの進捗のウィンドウ。SOR は2回分を1本の進捗にする）、新しいレイヤー **「間引き - 元の名前」/「フィルタ - 元の名前」** ができ、
元のレイヤーは `runTool` が非表示にする（G0-2。消さない、書き換えない）。0点になったときは `ThinFilterError::EmptyResult` の日本語の文言をエラーログに出し、レイヤーは作らない。

## 2. 入口

- デスクトップ: Tauri コマンド `thin_copc`・`filter_copc`（`run_tool` に乗せる。panic は文字列のエラー。出力は `tool_output_path`）
- Web: `crates/pcv-wasm/src/thin_filter.rs`（`WasmThinFilter`: タイルごとに少しずつ進む `advance` / `isDone` / `finish`。バッチの合間でキャンセルが効き、長いループを `finish` に持たない）。
  Worker のメッセージ `thinStart` / `filterStart`、`WebSource` のメソッド。Web のファイルの読み方で `TileReader` がそのまま使えなければ、
  `pcv-core` 側に読み方を受け取る小さな口を足してよい（`thin.rs`・`outlier.rs` の判定そのものは変えない。変えるならテストが同じ結果を確かめること）
- TS の手順: `src/app/point-cloud-tools.ts` の**末尾に** `thinLayer(ctx, layerId, request)`・`filterLayer(ctx, layerId, request)` を足す（T15 も同じファイルに足すため）

## 3. 受け入れ基準

- [ ] `cargo test -p pcv-core -p pcv-convert`、`cargo build -p pcv-wasm --target wasm32-unknown-unknown`、`npm test` が緑
- [ ] Web の `WasmThinFilter` のテスト（wasm のテストが難しければ、`advance` を回す Rust 側の状態機械を `pcv-core` / ネイティブで試す）: 結果の点の数が `thin_path` / `filter_path`（デスクトップ）と同じ。タイル1枚の点数の上限を超えて抱えない
- [ ] TS の単体テスト: 成功で新しいレイヤー＋元を非表示、失敗・キャンセル・0点で元は表示のまま、点群でないレイヤーを断る、単位の換算（ft のファイル）、R の既定の見積もり
- [ ] **測定**（`run_in_background`、結果はファイルから読む）: Web の実ブラウザで autzen をグリッド 1 ft・ROR・SOR それぞれの時間（G3-T7 のネイティブの値と並べる）。ブラウザのタブが落ちないこと
- [ ] **画面**: Web ビルドを実 GPU のブラウザで（`PCV_E2E_PORT` で空いているポート。`adapter.info` を記録し SwiftShader でないことを確かめる）、
  autzen と渋谷の一部（先にカットで切り出してよい）を間引き・フィルタしたスクリーンショット。元が非表示になっていること。スクリーンショットは**自分で開いて見る**
- [ ] 未確認として残すもの（記録に書く）: デスクトップのウィンドウ・Android での動作

## 4. 作業の決まり

- worktree で作業し、始める前に `git fetch origin && git rebase origin/main`。1コミット1関心事、逐次 `git push origin HEAD:main`
- **同時に T15（DTM）が同じファイル**（`point-cloud-tools.ts`・`tauri.ts`・`web.ts`・`copc.worker.ts`・`conversion.rs`・`src-tauri/src/lib.rs`・`pcv-wasm/src/lib.rs`・`Toolbar.tsx`）**に足している**。
  自分の追加はまとまった塊で足し、rebase でぶつかったら**両方を残す**。生成した wasm がぶつかったら、手で混ぜず、rebase のあとに作り直してコミットする
- `src/` のコメントに `@tauri-apps/` の文字を書かない（CI の invariants が落ちる）
- 新しいコードで `unwrap` / `expect` / `panic!` を使わない。`pcv-core` / `pcv-wasm` で `Instant::now` を使わない
- コードのコメントは英語、この文書の「実施の記録」とコミットメッセージは日本語。`TaskSheets/HANDOFF.md` は触らない

## 実施の記録（2026-10-22、実装担当）

### 作ったもの

| 場所 | 内容 |
|---|---|
| `crates/pcv-core/src/thin_filter_job.rs` | `ThinFilterJob`（1タイルずつ進める状態機械。SOR は統計→書き出しの2パス）、JSON の指定 `ThinRequest` / `FilterRequest`、`JobMode` |
| `crates/pcv-wasm/src/thin_filter.rs` | `WasmThinFilter`（`forThin` / `forFilter` / `advance` / `finish`。書き出しは `WasmExtractor` と同じ SpillWriter + OPFS） |
| `crates/pcv-wasm/src/extract.rs` | `Source` 型と `open_source` を `pub(crate)` にしただけ |
| `src-tauri/src/conversion.rs`・`lib.rs` | Tauri コマンド `thin_copc` / `filter_copc`（`run_tool` に乗せ、出力は `tool_output_path`。0点は `ThinFilterError::EmptyResult` の文言のまま返す） |
| `src/datasource/thin-filter.ts` | `ThinRequest` / `FilterRequest` の型（長さはファイルの単位） |
| `src/datasource/{tauri,web,web-protocol,copc.worker}.ts` | `thinCopc` / `filterCopc`、Worker のメッセージ `thinStart` / `filterStart` |
| `src/app/thin-filter.ts` | プリセットの表 `THIN_FILTER_PRESETS`、点の間隔の見積もり `estimatePointSpacing`、SOR の R の既定 `defaultSorSearchRadius`、表示単位→ファイルの単位の `thinRequestFor` / `filterRequestFor` |
| `src/app/point-cloud-tools.ts` | **末尾に** `thinLayer` / `filterLayer`（`runTool` を使う） |
| `src/ui/tools/{ThinDialog,FilterDialog}.tsx`、`src/ui/toolbar/buttons/{ThinButton,FilterButton}.tsx`、`Toolbar.tsx`、`AppShell.tsx` | ボタンとダイアログ。値を表示して `src/app/` の関数を呼ぶだけ |
| `scripts/thin-filter-browser-bench.mjs` | 実ブラウザでの計測とスクリーンショット（開発用。CI では動かさない） |

### 決めたこと

- **Web の読み方は `TileReader` をそのまま使えた**（`pcv-core` の `thin.rs`・`outlier.rs`・`tiles.rs` は変えていない）。`TileReader::new` に、ファイルを開く関数
  （`CopcReader::open(BufReader<FileRangeReader>)`）を渡すだけで済んだ。
- **状態機械は `pcv-core` に置いた**（デスクトップの `thin_path` / `filter_path` に手を入れずに済む）。`advance` は1タイル分を読んで判定し、残る点を返す。
  タイルは返したあとに捨てるので、保持するのは1タイル分だけ。呼び出し側（`WasmThinFilter`）が返った点を SpillWriter に書く。
- **`ThinFilterJob` の型引数は読み手 `R` だけ**にした。最初は「ファイルを開く関数」も型引数にしたが、`WasmThinFilter` の構造体にその型を書けない（クロージャの型は名前を付けられない）ので、
  `Rc<dyn Fn()>` に包んで `dyn` にした。理由はこのコメントとして `thin_filter_job.rs` の `OpenFn` にも書いてある。
- **Web のタイルの目標点数は 500,000**（`TILE_CAP_POINTS`）。デスクトップの 2,000,000 より小さくした理由は、Worker のメモリが少ないため（推定。ブラウザのメモリの上限は測っていない）。
  代わりに読み直しが増える（下の計測）。
- 単位: 方式・大きさなどの既定は**メートルで1つの表に置き**、ダイアログは表示単位に直して出す。SOR の R の既定は、ヘッダーの点数と XY の外接の長方形の面積から
  `sqrt(面積 / 点数)` を点の間隔とし、その10倍。細長い形の点群では間隔が大きめに出る（見積もり）。単位が不明な点群では 0.5 m × 10 を使う。
- 長さの換算は水平の係数（`horizontalToMeter`）だけを使う。ボクセルの z 方向も同じ大きさにしている（垂直の単位が水平と違うファイルは考えていない。未確認）。
- Worker の手順（ロック→スクラッチ→ループ→finish→後始末）は `runExtract` と同じ形なので、複製した（`runThinFilter`）。共通化は、T15 も同じファイルを触っているため今回は見送った。
- 採らなかった案: `thin_path` / `filter_path` を `ThinFilterJob` で作り直して1本にする案。デスクトップの測定済みの経路を壊すおそれがあり、今回の依頼の範囲を超えるため。
  代わりに、両者が同じ点の集合を返すテストを置いた。

### 実行したコマンドと結果

```
cargo test -p pcv-core -p pcv-convert        -> pcv-core 183 passed / 1 ignored、pcv-convert の lib 100 passed（結合テストも全部 ok）。EXIT 0
cargo test -p pcv-convert --lib thin_filter  -> 10 passed（うち新しい2件: the_step_job_keeps_the_same_points_as_thin_path_and_filter_path / the_step_job_rejects_bad_settings）
cargo test -p pcv-core --lib thin_filter_job -> 1 passed（JSON の指定の読み取り）
cargo build -p pcv-core --target wasm32-unknown-unknown            -> Finished
cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown -> Finished
npm run build:wasm                            -> 成功（src/wasm/pcv-wasm を作り直して別コミット）
npx tsc --noEmit / npx eslint src             -> 出力なし（エラーなし）
npx vitest run                                -> 79 files / 783 tests passed
```

- `WasmThinFilter` そのもの（wasm 上）の単体テストは**置いていない**。代わりに、`advance` を回す状態機械 `ThinFilterJob` をネイティブで `thin_path` / `filter_path` と比べた
  （グリッド最も低い・ボクセル・ROR・SOR の残る点の ID の集合が一致、`advance` は5回より多く呼ばれて分割されている、1回に返る点は cap の2倍以下、最大のタイルは全体の半分未満、進捗が最後に総数に一致）。
  wasm の層（SpillWriter への書き出し・OPFS）は、下の実ブラウザの実行で確かめた。
- TS の単体テスト（`src/app/thin-filter.test.ts`・`thin-filter-tools.test.ts`・`web-protocol.test.ts`）: 成功で新しいレイヤー＋元を非表示、0点・失敗・キャンセルで元は表示のまま・レイヤーなし、
  点群でないレイヤーと存在しないレイヤーを断る、他のツール実行中は始めない、ft のファイルの換算（表示 m・ファイル ft / 表示 ft・ファイル ft / 単位不明）、R の既定の見積もり。

### 計測（実ブラウザと、同じ日のネイティブ）

条件: `autzen-classified.copc.laz`（10,653,336 点、単位 ft）。ブラウザは Playwright の Chromium（`channel: "chromium"`、ヘッドレス、`--enable-unsafe-webgpu --ignore-gpu-blocklist`）。
**`adapter.info`: vendor `nvidia`、architecture `lovelace`**（実 GPU。SwiftShader ではない）。Node のプロセスを P コアに固定（Chromium は子プロセスなので引き継ぐはずだが、Chromium 側の affinity は確かめていない）（`ProcessorAffinity = 0xFFF`）。
時間は「ボタンを押してから、新しいレイヤーの行が出るまで」の実時間（`scripts/thin-filter-browser-bench.mjs` 内の `Date.now()`）。**各1回**。
グリッド 1 ft（セル中心に最も近い）・ROR r = 3 ft, m = 4・SOR k = 8, n = 2, R = 15 ft（G3-T7 と同じ値）。

| 処理 | Web（実ブラウザ、cap 500k） | ネイティブ（cap 500k） | ネイティブ（cap 2M、既定） | 残った点（Web） |
|---|---|---|---|---|
| グリッド 1 ft | 37.53 s | 21.39 s | 14.65 s | 7,631,737 |
| ROR | 44.96 s | 27.30 s | 18.18 s | 9,704,203 |
| SOR | 116.31 s | 95.59 s | 54.82 s | 10,092,932 |

- 残った点の数は、Web・ネイティブ（cap 500k・2M）・G3-T7 の記録のすべてで同じ（7,631,737 / 9,704,203 / 10,092,932）。
- ネイティブの読んだ点（展開）のヘッダー比（1パスあたり）: cap 2M は 1.96 倍、cap 500k は 3.71 倍（SOR は 3.92 倍）。cap を小さくすると読み直しが増え、時間が 1.5〜1.7 倍ほどかかる。
- Web はネイティブ（同じ cap 500k）の 1.2〜1.8 倍の時間（wasm の速度、OPFS への書き出し、レイヤーとして開く時間を含むため。内訳は分けていない）。
- コマンド（ネイティブ）: `target/release/examples/thin_filter_bench.exe <入力> <出力> grid 1 nearest` / `ror 3 4` / `sor 8 2 15`、環境変数 `PCV_TILE_CAP` = 2000000 / 500000。PowerShell で起動し直後に affinity `0xFFF`。
- ブラウザのタブは落ちなかった（`page.on("crash")` が発火しなかった）。**ブラウザのメモリのピークは測っていない。**

渋谷の一部（`tokyo-shibuya-merged-v2.copc.laz` から `extract_copc` で 300 m 四方 `-12150 -37950 -10 -11850 -37650 260` を切り出した 4,774,278 点、64 MB）:

| 処理 | Web の時間 | 残った点 |
|---|---|---|
| ボクセル 0.5 m | 18.74 s | 1,111,124 |
| ROR r = 0.5 m, m = 4 | 26.84 s | 4,497,273 |
| SOR k = 8, n = 2, R = 既定の 1.373 m | 62.52 s | 4,527,140 |

失敗系（渋谷の切り出しで）: ROR m = 100000 → 「点群ツール / 残る点がありません」のエラーダイアログが出て（24.65 s）、新しいレイヤーは作られず、元の行は残った。
ROR を始めて 5 秒後に「キャンセル」→ 「フィルタ（…）をキャンセルしました」のエラーログ、新しいレイヤーなし（開始から 5.9 s）。

### スクリーンショット（自分で開いて見た。黒・空ではない）

`C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\a0939245-9319-4ed2-bf2a-f43a24adb383\scratchpad\` の下:
`shots\grid1ft-result.png`・`shots\ror-result.png`・`shots\sor-result.png`・`shots\grid1ft-dialog.png`（autzen）、
`shots-shibuya\voxel05m-result.png`・`ror05m-result.png`・`sordefault-result.png`・`sordefault-dialog.png`（渋谷の切り出し）、`shots-fail\zero-result.png`。
どれも、元のレイヤーのチェックが外れて（非表示）、新しいレイヤーが点を表示していること、レイヤー情報の点数が上の表と同じであることを見た。
（このフォルダは一時置き場で、リポジトリには入れていない。）

### 確かめていないこと

- デスクトップのウィンドウ（Tauri）と Android での動作。`thin_copc` / `filter_copc` は `cargo check` が通るところまで（実際に呼んでいない）。
- ブラウザのメモリのピーク、Web での渋谷全体（3.48億点）の実行。
- Web の `finish` の間（八分木の構築と書き出し）はキャンセルが効かない（`WasmExtractor` と同じ）。
- 垂直の単位が水平と違うファイルでのボクセルの大きさ。
- 計測は各1回（ぶれは見ていない）。ブラウザの時間の内訳（読み・判定・書き出し・レイヤーとして開く）は分けていない。
- SOR の R の既定（点の間隔の10倍）が適切かは、渋谷の切り出し1つ（R = 1.373 m で 4,527,140 点が残った）以外では見ていない。

### 所有者の確認手順

1. `cargo test -p pcv-core -p pcv-convert`、`npm test`
2. Web: `GITHUB_PAGES_BUILD=true npm run build` のあと `npm run preview -- --port 4391 --strictPort --host 127.0.0.1`、ブラウザで開き、COPC を開いて「間引き」「フィルタ」を押す。
   新しいレイヤー「間引き - 名前」/「フィルタ - 名前」ができ、元が非表示になること、点数が妥当なことを見る。「残る点がありません」とキャンセルも試す。
3. 計測の再現: `node scripts/thin-filter-browser-bench.mjs 4391 C:\...\autzen-classified.copc.laz <出力フォルダ> grid1ft,ror,sor`（P コアに固定して起動すること）
4. デスクトップ（`npm run tauri dev`）で同じ手順を試す（未確認）。
