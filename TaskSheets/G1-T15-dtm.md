# G1-T15: DTM ツール（CSF で地表を分類 → 間引いた地表の点の TIN → 格子・LandXML）

- 日付: 2026-10-22
- 状態: **依頼（コーディネーターが書いた受け入れ基準）**。実施の記録は、この文書の下に「実施の記録」の節を足して書く
- 計画: [G1-raster-and-dtm.md](./G1-raster-and-dtm.md) の 2.2・2.3・9.2・9.3（Q16・Q18）・12 節（Q3・Q7・Q20）。G1-6・G1-7・G1-8・G1-10 を1本にまとめたもの
- 使う部品（既にある）: `pcv_core::csf::Cloth`（[G1-T3](./G1-T3-csf-core.md)）、`pcv_core::section_line`（帯の CSF → セル中心に最も近い地表の点 → `spade` の TIN。
  [G2-T9](./G2-T9-section-line.md)。**作り方の手本**）、`pcv_core::raster`（`GridSpec`・`geotiff::write_f32` / `write_rgba_u8`・`color::ramp_color`）、
  `src/app/csf-params.ts`（`CSF_PRESETS_METRES`・`csfParamsInFileUnits`。プリセットの表はここ1か所）、`src/app/point-cloud-tools.ts` の `runTool`

## 1. 利用者から見た形

リボンに **「DTM」ボタン**（`src/ui/toolbar/buttons/DtmButton.tsx`）。選んだ点群レイヤー1つに対してダイアログ（`src/ui/tools/DtmDialog.tsx`、`SectionDialog` と同じ `Dialog`）を開く。

- プリセット: 標準 / 急勾配 / カスタム（計画 2.2 の「ダイアログ」の段落どおり。詳細設定のトグルは既定で閉じ、開くと CSF の全パラメータを m（表示単位）で直せる。直したら「カスタム」）
- DTM のセルの大きさ（表示単位。既定 0.5 m。断面と同じ `displayLengthToFile` で換算）
- 出力形式の表示: 「GeoTIFF（色付き）」などの今の設定と、「設定で変えられます」の一文。**形式は設定画面で選ぶ**（所有者の回答 Q18）

設定画面（`src/ui/settings/`）に項目「DTM の出力形式」を足す: **GeoTIFF / LandXML / 両方**、GeoTIFF の種類 **色付き（RGBA 8bit。既定）/ 値のまま（float32）**。
保存のしかたは既存の設定（例: `src/state/motion-setting.ts`）と同じにする。

実行すると（進捗とキャンセルは既存のツールの進捗のウィンドウ。割合で出す）:

1. **地表を分類した点群レイヤー**「地表 - 元の名前」ができる（ADR-0018。元のレイヤーは `runTool` が非表示にする）。最初の着色は分類（あれば）
2. DTM のファイル（GeoTIFF・LandXML の一方か両方）。デスクトップは保存ダイアログで保存するボタン（ラスタ化と同じ `save_tool_file`）、Web はダウンロードリンク。
   置き場所は新しいレイヤーのレイヤー情報（`ViewerLayer.dtm` に、セルの大きさ・列×行・ファイル。`DtmInfoSection`）

DTM ボタンを、ラスタ化のウィンドウに入れない理由（計画 13.6 の末尾の一文から変えた。コーディネーターの判断）: DTM はプリセットと CSF の詳細設定が要り、
点群レイヤーも作る（ラスタ化のウィンドウは「レイヤーを作らない、プレビューで確かめる」道具）。所有者の回答 Q5「ボタン1つ」に合わせて独立したボタンにした。

## 2. 中身（Rust）

`crates/pcv-core/src/dtm.rs`（新規）に **`DtmJob`**（`SectionLineJob` と同じく、`advance()` を繰り返して進む。Web が合間にイベントループへ戻れるように）:

1. 読み1: 全レベルの全ノードの全点（粗いレベルも。COPC のレベルは点が重ならない）を `Cloth::add_point_for_ihv` に。布の範囲はヘッダーの XY の範囲
2. シミュレーション: `Cloth::step` をバッチで
3. 読み2: 各点を分類し、**点はそのまま `copc-writer` に流す**（メモリに抱えない）。分類の規則（Q7）: CSF で地表 → 2、元が 2 で地表でない → 1、それ以外は元のまま。
   同時に、地表の点のうち **DTM のセルの中心に最も近い点** を1セル1点だけ残す（Q16。`section_line` と同じ選び方）
4. TIN: 残した点を `spade` で Delaunay（辺の長さの上限なし。Q16）。格子の各セル中心で重心座標の補間。凸包の外は NoData
5. 出力: GeoTIFF（色付き: 値の最小〜最大で `ramp_color`、NoData はアルファ 0 / 値のまま: `write_f32` と `GDAL_NODATA`）。CRS の扱いはラスタ化と同じ（EPSG が無ければ警告）。
   LandXML 1.2 の `<Surface><Definition surfType="TIN"><Pnts>…<Faces>…` を**ファイルへ流して書く**（文字列を全部メモリに作らない）。座標の順は LandXML の慣例どおり「北 東 標高」（Y X Z）にし、そのことをコメントとテストに書く。
   J-LandXML 固有の要素は今回は入れない（仕様を読んでいない。計画 9.3）

メモリ: 持つのは布（約 13〜17 B/粒子）と DTM の格子（代表点）と TIN だけ。**点数に比例しない**ことを、点を増やしても `memory_bytes()` 相当が変わらないテストで確かめる。
上限: 布の粒子数と DTM のセル数に上限を置き、超えたら日本語で断る（「解像度を粗くするか、先に範囲を切り出してください」）。
最初の値はデスクトップ 40,000,000 粒子・Web 16,000,000 粒子（推定）。**下の測定で決め直し、根拠を記録に書く**。

入口: デスクトップ `crates/pcv-convert/src/dtm.rs` と Tauri コマンド `dtm_copc`（`run_tool` に乗せる。panic は文字列のエラー）。
Web `crates/pcv-wasm/src/dtm.rs`（`WasmDtm`: `advance` / `isDone` / `finish`。`extract.rs` と `section_line.rs` を手本に）、Worker のメッセージ `dtmStart`、`WebSource` のメソッド。
TS の手順は `src/app/point-cloud-tools.ts` に `makeDtm(ctx, layerId, request)`（ファイルの**末尾に**足す。T16 も同じファイルに足すため）。

## 3. 受け入れ基準

- [ ] `cargo test -p pcv-core -p pcv-convert`、`cargo build -p pcv-core --target wasm32-unknown-unknown`、`npm test`、`npm run lint`（あれば）が緑
- [ ] 合成データのテスト（`dtm.rs`）: 平地＋箱の建物（下に地面なし）＋植生 → DTM の格子が建物の下も含めて |z| < 0.05、建物の屋根の点は分類 2 にならない。斜面 z = 0.2x を 0.05 以内で追う
- [ ] 分類の規則 Q7 のテスト（元 6 の建物の点は 6 のまま、元 2 で地表でない点は 1）
- [ ] 読んだ点の数＝ヘッダーの点数、書いた点の数＝ヘッダーの点数（粗いレベルの点を落とさない）
- [ ] メモリが点数に比例しないテスト（上の段落）。上限を超えた設定は点を読む前に断る
- [ ] GeoTIFF を `tiff`（dev-dependency）で読み戻すテスト（色付き・値のまま）。LandXML を読み戻して点の数・面の数・座標の順を確かめるテスト
- [ ] TS の単体テスト: `makeDtm` が成功で新しいレイヤー＋元を非表示、失敗・キャンセルで元は表示のまま、点群でないレイヤーを断る。設定の保存と読み込み
- [ ] **測定**（release、`run_in_background` で走らせ、結果はファイルから読む。他の重い変換が走っていないことを先に確かめる）:
  `C:\rust\point-cloud-viewer\data\tokyo-shibuya-merged-v2.copc.laz` を布 1.0 m と 0.5 m・DTM セル 0.5 m で、時間とピークの private memory。
  `autzen-classified.copc.laz` で、元の分類 2 と CSF の地表の一致（再現率・適合率。正解ではなく目安）。計測用の example を `crates/pcv-convert/examples/` に置く
- [ ] **画面**: Web ビルドを実 GPU のブラウザで（`PCV_E2E_PORT` で空いているポート。`adapter.info` を記録し SwiftShader でないことを確かめる）、autzen で DTM を作り、
  分類のレイヤーが出て元が非表示になったスクリーンショットと、ダウンロードした GeoTIFF を保存する。スクリーンショットは**自分で開いて見る**（真っ黒・空でないこと）
- [ ] 未確認として残すもの（記録に書く）: QGIS で GeoTIFF・LandXML を開くこと（所有者）、デスクトップのウィンドウ・Android での動作

## 4. 作業の決まり

- worktree で作業し、始める前に `git fetch origin && git rebase origin/main`。1コミット1関心事、逐次 `git push origin HEAD:main`
- **同時に T16（間引き・フィルタの画面）が同じファイル**（`point-cloud-tools.ts`・`tauri.ts`・`web.ts`・`copc.worker.ts`・`conversion.rs`・`src-tauri/src/lib.rs`・`pcv-wasm/src/lib.rs`・`Toolbar.tsx`）**に足している**。
  自分の追加はまとまった塊で足し、rebase でぶつかったら**両方を残す**。生成した wasm（`npm run` の wasm のビルドの出力）がぶつかったら、手で混ぜず、rebase のあとに作り直してコミットする
- `src/` のコメントに `@tauri-apps/` の文字を書かない（CI の invariants が落ちる）
- 新しいコードで `unwrap` / `expect` / `panic!` を使わない。`pcv-core` / `pcv-wasm` で `Instant::now` を使わない
- コードのコメントは英語、この文書の「実施の記録」とコミットメッセージは日本語。`TaskSheets/HANDOFF.md` は触らない
