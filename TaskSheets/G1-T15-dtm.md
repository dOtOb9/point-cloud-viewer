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

---

# 実施の記録（2026-10-22）

状態: 実装・テスト・測定・実ブラウザでの確認まで済み。QGIS・デスクトップのウィンドウ・Android は**未確認**（下の「確かめていないこと」）。

## 1. やったこと

| 層 | 追加したもの |
|---|---|
| `pcv-core` | `crates/pcv-core/src/dtm.rs`（`DtmJob`・`DtmSurface`・`DtmRequest`・`GroundAgreement`）、`dtm/landxml.rs`（LandXML 1.2 の書き出し・`utc_date_time`）、`dtm/tests.rs` |
| `pcv-convert` | `src/dtm.rs`（`dtm_path`。ジョブを反復子に包んで `copc-writer` へ流し、そのあと GeoTIFF・LandXML をファイルへ書く）、`examples/dtm_bench.rs`（計測用） |
| Tauri | `conversion.rs` の `dtm_copc`（`run_tool` に乗せた。panic は文字列のエラー）、`lib.rs` に登録 |
| `pcv-wasm` | `src/dtm.rs` の `WasmDtm`（`advance` / `finish` / `info` / `geotiff` / `landxml`） |
| データ入口 | `src/datasource/dtm.ts`（型）、`tauri.ts` の `dtmCopc`・`chooseLandXmlDestination`、`web-protocol.ts` の `dtmStart`、`copc.worker.ts` の `runDtm`、`web.ts` の `dtmCopc` |
| 手順（`src/app/`） | `point-cloud-tools.ts` の末尾に `makeDtm`・`saveDtmFile`、`dtm.ts`（プリセットの表示単位への換算・リクエストの組み立て・LandXML の単位）。`runTool` に `showAsPercent`（割合で出す）を足した |
| 状態 | `state/dtm-setting.ts`（出力形式の保存。`motion-setting.ts` と同じ作り）、`useDtmOutput.ts`（`useDisplayUnit.ts` と同じ小さな外部ストア）、`layers.ts` の `ViewerLayer.dtm`・`setLayerDtmInList` |
| 画面 | `DtmButton`（リボン）、`DtmDialog`（プリセット・セルの大きさ・詳細設定・「出力するファイル」の注記）、`DtmInfoSection`（レイヤー情報。Web はダウンロードリンク、デスクトップは「保存…」）、設定の「DTM の出力」（`DtmOutputDialog`） |

仕様どおりの点: 読み1 → 布のシミュレーション → 読み2（分類して書く）→ TIN（辺の長さの上限なし）。分類規則 Q7（CSF の地表 → 2、元が 2 で地表でない → 1、それ以外は元のまま）。
1セル1点は「セルの中心に最も近い地表の点」（`section_line` と同じ）。LandXML の座標は **北 東 標高（Y X Z）**（コメントとテスト `landxml_points_are_north_east_elevation` に書いた）。
ボタンは独立（ラスタ化のウィンドウには入れない）。形式は設定画面で選ぶ（Q18）。

## 2. 設計の選択と、採らなかった案

- **ジョブは「反復子に包める」形にした**: `DtmJob::advance` を呼ぶたびに少し進み、読み2の分類済みの点は `take_records()` で取り出す。
  デスクトップの `copc-writer` は点の反復子を受け取るので、反復子の `next()` の中でジョブを進める（最初の `next()` が読み1と布のシミュレーションを全部やる）。Web は `advance` のあとに取り出した点を `SpillWriter` へ入れる。
  採らなかった案: `advance` に「点を受け取る関数」を渡す形。デスクトップの反復子に包めず、書き出しの前に分類結果を溜めることになる（点数に比例）。
- **点は溜めない**: 持つのは布（粒子ごとに約 17 B）・代表点の格子（セルごとに 16 B）・TIN だけ。読みは1ノードずつ、取り出し待ちのバッファは `advance` 1回分（約 20 万点＋最後のノード）。
  テスト `memory_does_not_grow_with_the_point_count`（点数が 16 倍でも `memory_bytes()` が同じ、バッファが 1 回分に収まる）で確かめた。上限（粒子数・セル数）は点を1つも読む前に断る（`caps_refuse_before_any_point_is_read`、デスクトップ側は進捗が1回も出ないことまで見た）。
- **GeoTIFF の値は一度 `Vec<f32>`（セルごとに 4 B）に作ってから書く**: 色付きは最小〜最大が要るため。採らなかった案: 2回補間する（遅い）。メモリはセル数に比例する（上限で抑える）。
- **LandXML はファイルへ流して書く（デスクトップ）**。Web は書き出し先のファイルが無いので `Vec<u8>` に作る。その代わり **Web で LandXML を選ぶとセル数の上限を 800 万から 200 万に下げた**。
  採らなかった案: Web でも OPFS に書いてダウンロードさせる（実装が増える。要望が出たら別タスク）。
- **P と F の行にインデントを付けない**: 計測のあとで気づいて外した（LandXML のファイルは点・面が数千万行になるため、インデントだけで約2割増える）。下の LandXML の大きさは**インデントありの形式での値**。
- **米国測量フィートと国際フィートの取り違えを直した**: 差は 6e-7 m/ft なので、許容を 1e-6 にすると同じに見える。テストで見つけて 1e-8 にした（`landXmlUnitFor`）。
- **LandXML の日時**: `pcv-core` は時計を読まない（wasm で `SystemTime::now` は panic する）。呼び出し側が UNIX 秒を渡す（デスクトップは `SystemTime`、Web は `Date.now()`）。
- **Android は Web と同じ小さい上限**にした（`cfg!(target_os = "android")`。スマホのメモリはデスクトップより小さいため）。**Android での動作は未確認**。
- **CSF と元の分類の一致を `DtmJob::ground_agreement()` に入れた**（4つの数を数えるだけ。計測用 example が使う）。

## 3. 上限値（粒子数・セル数）と根拠

| | 布の粒子数 | DTM のセル数 | 根拠 |
|---|---|---|---|
| デスクトップ | 40,000,000（変えない） | 40,000,000（変えない） | 渋谷（3200 m × 2400 m）の布 0.5 m・セル 0.5 m が **粒子 約 3,080 万（6404 × 4804 前後）・セル 30,720,000 でピーク 3,088.8 MiB**（実測）。40,000,000 までの直線の延長は約 4.0 GiB（**推定。上限ぎりぎりは測っていない**） |
| Web | 16,000,000（変えない） | GeoTIFF のみ 8,000,000 / LandXML も作るとき 2,000,000 | 推定。実ブラウザで測ったのは autzen（粒子 約 595 万＝範囲 1,045 m × 1,420 m を 0.5 m で割った推定・セル 1,483,900）だけ。上限ぎりぎりのメモリは**測っていない**。LandXML は 200 万頂点・400 万面で約 230 MB の文字列（Vec が伸びる間は一時的にその倍）になる見込み（デスクトップのインデントありで 1 要素あたり約 48 B、P 約 52 B・F 約 33 B と見積もった。**推定**） |
| Android | Web と同じ | Web と同じ | 推定。実機で測っていない |

渋谷の布 1.0 m（粒子 約 770 万）はピーク 2,401.3 MiB なので、粒子が約 +2,300 万で +687.5 MiB（1 粒子あたり約 30 B。布の 17 B とセルの 16 B などの合計と矛盾しない）。
ピークの大半は TIN（地表の頂点 約 1,365 万個で約 1.5 GiB と見込める。1 頂点あたり約 100 B。**推定**）。

## 4. 実行したコマンドと出力

テスト（`C:\rust\point-cloud-viewer\.claude\worktrees\agent-af16e8de239738fc3`、すべて緑）:

```text
cargo test -p pcv-core -p pcv-convert
  pcv-convert lib: test result: ok. 100 passed（うち dtm:: 4 件）
  pcv-core lib:    test result: ok. 184 passed; 1 ignored（うち dtm:: 13 件）
cargo build -p pcv-core --target wasm32-unknown-unknown      -> Finished
cargo test --manifest-path crates/pcv-wasm/Cargo.toml        -> test result: ok. 57 passed; 1 ignored
cargo clippy --workspace --all-targets -- -D warnings        -> Finished（警告・エラーなし。vendor/laz の既存の警告は -D の対象外）
cargo fmt --all -- --check / cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check  -> 差分なし
npm test        -> Test Files 82 passed (82), Tests 807 passed (807)
npm run lint    -> エラーなし
npm run typecheck -> エラーなし
```

CI（push `ff56b82` のあと）: CI run **39649616826** = success（e2e・frontend・invariants・rust・build すべて）、Pages run **39649616728** = success。
最後の push のあとの run id は、この文書の最後に書く。

主なテスト（受け入れ基準との対応）:

- `flat_ground_with_a_building_and_vegetation`: 平地＋10 m 四方の建物（下に地面なし）＋植生 → 内側の全セルで |z| < 0.05（建物の下の (25, 25) も）、屋根・植生の点は分類 2 にならない
- `slope_is_followed`: z = 0.2x を 0.05 以内で追う
- `classification_follows_the_owners_rule`: 元 6 の屋根は 6 のまま、元 5 の植生は 5 のまま、浮いた元 2 は 1、元 1 の地面は 2、元 7 の地面は 2
- `every_point_is_read_and_written`（小さいノード＝粗いレベルにも点がある）: 読んだ点数＝ヘッダー、書いた点数＝ヘッダー、どの点も1回だけ
- `values_geotiff_reads_back` / `colored_geotiff_reads_back`（`tiff` で読み戻し）、`landxml_points_are_north_east_elevation` / `landxml_order_differs_from_xy_when_x_and_y_differ`（点の数・面の数・順）
- デスクトップ（`pcv-convert`）: 分類済みの COPC の点数＝元、地表は 2、箱は 6 のまま、キャンセルで3つのファイルが全部消える、上限は点を読む前に断る
- TS: `makeDtm`（成功で新レイヤー＋元を非表示＋分類で着色＋`dtm` を保存／失敗・キャンセルで元は表示のまま／点群でないレイヤーを断る）、`saveDtmFile`、設定の保存と読み込み、リクエストの換算（m・ft・単位不明）

## 5. 測定

`crates/pcv-convert/examples/dtm_bench.rs`（release）。起動は `measure.ps1`（このセッションの作業用。コミットしていない。`Start-Process` で起動し、`ProcessorAffinity = 0xFFF`（P コア）に固定、200 ms ごとに `PrivateMemorySize64` の最大を取る）。
上限は外して実行した（上限の値を決めるため）。出力は COPC・GeoTIFF（値のまま）・LandXML の3つ全部。標準プリセット。

```text
dtm_bench.exe <入力> <出力フォルダ> <布の間隔> <セルの大きさ> standard both
```

| 入力 | 布 / セル | 時間 | ピーク private | 点数 | 地表の点 | 格子 | TIN（頂点 / 三角形） |
|---|---|---|---|---|---|---|---|
| 渋谷 `tokyo-shibuya-merged-v2.copc.laz`（m） | 1.0 / 0.5 | **737.3 s**（12.3 分） | **2,401.3 MiB** | 347,797,138 | 99,661,664 | 6400 × 4800 | 13,654,828 / 27,309,619 |
| 渋谷 | 0.5 / 0.5 | **1,114.1 s**（18.6 分） | **3,088.8 MiB** | 347,797,138 | 111,793,547 | 6400 × 4800 | 15,485,558 / 30,971,080 |
| autzen `autzen-classified.copc.laz`（ft） | 1.5 / 1.5 | 166.1 s | 727.1 MiB | 10,653,336 | 5,723,290 | 2285 × 3105 | 3,680,658 / 7,361,271 |

渋谷の各段階（進捗の割合が 250・550・900・950 に届いた時刻。単位は秒）: 布 1.0 → 206.9・363.2・543.5・691.3、布 0.5 → 243.4・767.5・948.1・1075.2。
つまり 布 1.0 では 読み1 約 207 s、シミュレーション 約 156 s、読み2＋書き出しへの供給 約 180 s、COPC の仕上げ（八分木・圧縮）約 148 s、TIN とファイル 約 46 s。
布 0.5 ではシミュレーションが約 524 s に増える（粒子が 4 倍）。

出力の大きさ（バイト。LandXML は P・F のインデントがあった形式）: 渋谷 布 1.0 → COPC 4,638,568,589 / GeoTIFF 122,899,504 / LandXML 1,984,076,620、布 0.5 → COPC 4,638,805,109 / GeoTIFF 122,899,504 / LandXML 2,260,507,754、autzen → 97,110,623 / 28,383,556 / 525,916,519。

**元の分類 2 と CSF の地表の一致**（全点で数えた。元の分類も「正解」ではないので目安）:

| | 両方 | CSF のみ | 元のみ | どちらも違う | 適合率（CSF の地表のうち元も地表） | 再現率（元の地表のうち CSF が見つけた） |
|---|---|---|---|---|---|---|
| autzen 1.5 ft | 5,323,465 | 399,825 | 1,585,940 | 3,344,106 | **0.930** | **0.770** |
| 渋谷 布 1.0 m | 72,569,494 | 27,092,170 | 6,692,294 | 241,443,180 | 0.728 | 0.916 |
| 渋谷 布 0.5 m | 76,579,704 | 35,213,843 | 2,682,084 | 233,321,507 | 0.685 | 0.966 |

（渋谷の元の分類が地表をどこまで塗っているかは確かめていない。適合率が低いのは、標準プリセットの「地表とみなす幅」＝上 0.1 m・下 1.0 m に、地面すれすれの低い物が入るためと考えられるが、**未検証**。）

測定の条件の注意: 同じ PC で他のプロセス（ブラウザ・ランチャーなど）が動いていた。他の重い変換が走っていないことは確かめたが、別のエージェントの作業が重なった可能性は排除していない。
各条件1回ずつの測定（繰り返していない）。

## 6. 画面（Web ビルド・実 GPU のブラウザ）

`scripts/dtm-browser-check.mjs`（コミットした開発用スクリプト。使い方は先頭のコメント）。`GITHUB_PAGES_BUILD=true npm run build` のあと、`GITHUB_PAGES_BUILD=true npm run preview -- --port 4417 --strictPort --host 127.0.0.1`
（`vite preview` にも同じ環境変数が要る。無いと JS が HTML で返って画面が真っ白になる）。終わったあと、自分が起動した preview のプロセス（コマンドラインを確かめて3つ）だけを止めた。

```text
node scripts/dtm-browser-check.mjs 4417 C:\rust\point-cloud-viewer\data\autzen-classified.copc.laz <scratchpad>\dtm-shots 1
adapter: {"vendor":"nvidia","architecture":"lovelace"}   <- 実 GPU（SwiftShader ではない）
seconds: 272.333（「作る」を押してから新しいレイヤーが出るまで）, crashed: false, error: null
rows: ["autzen-classified.copc.laz", "地表 - autzen-classified.copc.laz"]
info: DTM のセル: 1 m（1,045 列 × 1,420 行）/ 地表の点: 7,111,819 / 三角形の網: 頂点 1,190,722 / 三角形 2,381,400 / GeoTIFF（autzen-classified-dtm.tif）ダウンロード
```

置き場所（このセッションの作業用フォルダ。コミットしていない）: `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\a0939245-9319-4ed2-bf2a-f43a24adb383\scratchpad\dtm-shots\`
`dtm-before.png`（開いた直後）、`dtm-dialog.png`（DTM のダイアログ）、`dtm-result.png`（結果）、`dtm.tif`（ダウンロードした GeoTIFF）、`dtm-tif.png`（`dtm.tif` を自分で PNG にして見たもの）。

**自分で開いて見た**: `dtm-result.png` は、元のレイヤーのチェックが外れ、「地表 - autzen-classified.copc.laz」が選ばれ、分類で着色された点群（茶＝地表、緑＝植生、赤＝建物など）が出ていて、左のレイヤー情報に DTM の節とダウンロードボタンがある（真っ黒・空ではない）。
`dtm.tif` は 1045 × 1420、RGBA 8bit、95 ストリップ、画素のバイト数が期待値（5,935,600）と一致。ジオタグあり（ピクセルの大きさ 3.2808 = 1 m を ft で、タイポイント、EPSG キー）。
不透明 1,390,500・透明 93,400（TIN の外側）。PNG にして見ると、競技場を中心にした等高の色分けが北上げで出ていた。

## 7. 確かめていないこと

- **QGIS で GeoTIFF・LandXML を開くこと**（所有者）。LandXML はスキーマ（XSD）に対する検証をしていない（手元に無い）。`CoordinateSystem` の `epsgCode` 属性は記憶による（**未検証**）。J-LandXML 固有の要素は入れていない（仕様を読んでいない）
- **デスクトップのウィンドウでの動作**: `dtm_copc` は `cargo clippy --workspace` を通り、`pcv-convert` の `dtm_path` はテストと計測で動いたが、Tauri の画面（ボタン・ダイアログ・保存ダイアログ・進捗・キャンセル）は**操作していない**
- **Android**: 動かしていない。上限（Web と同じ小さい値）も実機で測っていない
- **Web のメモリ**: autzen（セル 148 万 3,900）だけ。上限（粒子 1,600 万・セル 800 万、LandXML 時 200 万）ぎりぎりの実行は**していない**。Web の LandXML 生成は実ブラウザで**まだ実行していない**（既定は GeoTIFF のみ）
- **Web のキャンセル・設定画面の操作**はブラウザで押していない（Rust のキャンセルの単体テストと TS の単体テストのみ）
- 計測は各条件1回。渋谷の元の分類の質は見ていない。適合率・再現率は目安
- 進捗: デスクトップは COPC の仕上げの間（渋谷で約 2.5 分）、割合が 90〜95% のまま止まって見える
- 地表が1点も無いとき（`NoGround`）は、COPC を全部書いたあとで失敗する（デスクトップは出力を消す）。先に知る方法は作っていない

## 8. 所有者の確認手順

1. **デスクトップ**: アプリを起動し、`autzen-classified.copc.laz`（または自分の点群）を開く → レイヤーを選ぶ → リボンの「DTM」→ 標準・セル 1 m で「作る」。
   進捗が % で出ること、終わると「地表 - …」が増えて元が非表示になり、分類で着色されること。レイヤー情報の「保存…」で GeoTIFF の保存ダイアログが出て、保存できること。
2. **QGIS**: 保存した GeoTIFF を開き、点群の座標系（autzen は EPSG:2992）で位置が合うこと、TIN の外側が透明なこと。「値のまま」（設定の「DTM の出力」→「GeoTIFF の種類」）にすると標高の数値（NoData -9999）になること。
3. **LandXML**: 設定で「両方」か「LandXML」にして作り直し、LandXML を読めるソフト（Civil 3D・TREND-POINT など手元のもの）で開く。点の座標の順が 北 東 標高 で、点群と重なること。大きな範囲ではファイルが非常に大きくなる（渋谷で約 2 GB）。
4. **Web**: GitHub Pages の版で同じ手順。ダウンロードリンクから GeoTIFF が保存できること。LandXML を選んだときは範囲の上限が小さい（セル 200 万）ので、超えるとメッセージで断られること。
5. **Android**: 小さい点群で実行して、上限のメッセージや動作を確かめる。
6. 画面の見た目: ダイアログのプリセット・詳細設定を開く・カスタムに自動で切り替わること。
