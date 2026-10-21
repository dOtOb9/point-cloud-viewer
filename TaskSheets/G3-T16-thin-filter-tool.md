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
