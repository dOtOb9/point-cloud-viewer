# G1-T11: ラスタ化をウィンドウとプレビューに作り直す（G1-R1〜R3）

- 日付: 2026-10-21
- 計画: [G1-raster-and-dtm.md](./G1-raster-and-dtm.md) の 13 節（所有者の決定）。前の版は [G1-T6](./G1-T6-rasterize-tool.md)（表示用の点群を作る版。この手順で置き換えた）
- 状態: Rust・Web（実ブラウザ・実 GPU）で動作を確かめた。**デスクトップの画面（Tauri のウィンドウ）・Android・QGIS・Windows のフォトで開くことは未確認**（WIC というフォトと同じデコーダーで読めることだけ確かめた）

## 何を作ったか

リボンの「ラスタ化」は、選んだ点群レイヤーのための大きなウィンドウ（`RasterWindow`）を開く。結果は点群ではなく画像のファイルなので**レイヤーにしない**。元のレイヤーも隠さない。

- 左（狭い画面では上）: トグルのボタン。値（RGB / 標高 平均・最小・最大 / 点数 / 強度。色の無いレイヤーでは RGB は押せない）、数える点（すべて / 地表のみ）、セルの大きさ（表示単位 m / ft。換算は今までと同じ）、書き出す TIFF（色付き＝既定 / 値のまま）
- 右（狭い画面では下）: Canvas 2D の `ImageData` のプレビュー。設定を変えるとすぐ描き直す。空のセルは透明（市松模様）。標高・点数・強度のときは凡例（色と値。標高は表示単位）。「プレビューは間引いた点から作っています」と、プレビューが実際に使ったセルの大きさ・点数を書いてある
- 下: 「書き出す」。全点を読む。進捗とキャンセルは今のツールの進捗ダイアログ。デスクトップは**先に**保存ダイアログで場所を聞き（長い読みの後に突然ダイアログが出ないように）、Web はダウンロード（ウィンドウの中にリンクも残す）

### 仕組み（コミット順）

1. **Rust（`f5fca75`）**
   - `pcv-core/src/extract.rs` の `ExtractPoints::coarse(reader, max_points)`: 階層から、レベル 0..=d の点の合計が `max_points` 以下になる最も深い d を選び、そのレベルのノードだけ読む（読む点数は階層から分かるので、読む前に決まる）。
   - `raster/preview.rs`: `CoarseReader`（バッチごとに読む。進捗・キャンセル・イベントループへ戻るのに使う）、`CoarsePoints`（間引いた点を**上限つき**で持つ。1点 32 バイト。`push` は上限で拒否）、`render`（持っている点を長辺 約 1024 セルの格子に足して色を付ける）、`PreviewImage::to_bytes`（デスクトップ・Web 共通の1つのバッファ。ヘッダー 32 バイト＋RGBA）。
   - `raster/color.rs`: 色を付ける関数を1か所に。プレビューも色付きの書き出しも `CellColorizer` を使う。標高・点数・強度は最小〜最大（書き出しはプレビューの範囲を受け取る）を、`colormap.ts` の `ELEVATION_INTENSITY_RAMP` を**写した**段（青→緑→黄→赤）で色に。RGB は u16→u8（8bit 値を 16bit 欄に入れるファイルは `color_depth` の判定で 0 にならないようにした）。空はアルファ 0。
   - `raster/geotiff.rs`: `write_rgba_u8`（8bit RGBA。`ExtraSamples`=2、ModelPixelScale・ModelTiepoint・EPSG はこれまでと同じ）。値のままは今の float32 / 16bit RGBA をそのまま残した。
   - `raster/output.rs`: `RasterOptions` に `tiff`（`colored` / `values`、省略は colored）と `range`（省略可）。
   - 消したもの: `DisplayPoints`・`DisplayCursor`・`display_z_at` のための Z の合計・`filled_cells`、表示用の COPC を書く部分（desktop・wasm・Tauri）。
   - 入口: Tauri `raster_preview_open` / `raster_preview_render`（`tauri::ipc::Response` で生のバイト列）/ `raster_preview_close`、`rasterize_copc`（GeoTIFF だけ）。Web は `WasmRasterPreview`（`feed` / `info` / `render`）と `WasmRasterizer`（OPFS を使わない）。
2. **wasm（`e1e080f`）**: `npm run build:wasm` で `src/wasm/pcv-wasm/` を作り直した（これまでの `📦 build(wasm)` と同じ方法）。
3. **TypeScript（`c42038e`）**: `src/datasource/raster.ts`（型とバッファの読み方）、`src/app/raster-window.ts`（`openRasterWindow`・`changeRasterSettings`・`exportRaster`・`closeRasterWindow`。普通の関数。コンテキストで状態を受け取る）、`src/state/raster-window.ts`（状態の型）と `useRasterWindow.ts`（`useState` を持つだけ）、`src/ui/tools/RasterWindow.tsx`（表示だけ）。
   - 消したもの: `ViewerLayer.raster`、`RasterInfoSection`、`initialColorModeForRaster`、`RasterDialog`、`runTool` のラスタの結果とレイヤーを作る流れ、`rasterizeLayer`・`saveRasterGeoTiff`、元のレイヤーを隠す処理（ラスタ化では）。
   - 古い応答を捨てる: 設定が速く変わると、遅れて届いた古い設定の絵で上書きしないように、`state.settings` の同一性で比べる（テストあり）。

### 読むレベルの選び方（測った）

`C:\rust\point-cloud-viewer\data\tokyo-shibuya-merged-v2.copc.laz`（347,797,138 点）で、上限（cap）を変えた結果（リリースの example、下の「測定」）:

| cap | 選ばれた深さ | 持った点 | 最初の読み |
|---|---|---|---|
| 1,000,000 | 1 | 900,000 | 0.45 秒 |
| 3,000,000 | 2 | 2,915,668 | 1.46 秒 |
| 6,000,000 | 2 | 2,915,668 | 1.44 秒（深さ 3 は 6M を超えるので選ばれない） |

上限は 300 万（`PREVIEW_POINT_BUDGET`）にした。持つ点は最大 約 96 MB（32 B × 300 万）。1M だと渋谷の格子（1025 x 769）の空きが多く、深さ 2 まで読んでも 1.5 秒で済むため。

## 採らなかった案

- 点を持たず、設定のたびに上のレベルを読み直す: 切り替えのたびにファイルを読む。持つほうが 36 ms で済み、上限があるのでメモリも点数に比例しない。
- プレビューを GPU で描く・WebGPU のテクスチャにする: Canvas 2D の `ImageData` で十分（1M セル）で、読みやすい。
- プレビューの格子をユーザーのセルの大きさそのままにする: 渋谷の 0.5 m は 6400 x 4800 で、間引いた点では穴だらけ。長辺 約 1024 セルを上限にし、実際に使ったセルの大きさを画面に出す。
- 色付き TIFF の色の範囲を書き出しの値から決める: 書き出しのセルは細かく、プレビューと最小・最大が違い、見た絵と色がずれる。プレビューの範囲を引き継ぐ。
- 陰影（hillshade）: 所有者が入れないと決めた。
- 書き出した結果をレイヤーにする: 所有者の決定（ファイルが成果物）。

## 触ったファイル

Rust: `crates/pcv-core/src/extract.rs`、`crates/pcv-core/src/raster/{mod,color,preview,output,grid,geotiff}.rs`、`crates/pcv-convert/src/raster.rs`、`crates/pcv-convert/examples/rasterize_copc.rs`、`crates/pcv-wasm/src/{raster,lib}.rs`、`src-tauri/src/{conversion,lib}.rs`。
TypeScript: `src/datasource/{raster,tools,tauri,web,web-protocol,copc.worker}.ts`、`src/app/{raster-window,point-cloud-tools,open-files}.ts`、`src/state/{raster-window,useRasterWindow,useDisplayUnit,layers,useCopcViewer}.ts`、`src/ui/tools/RasterWindow.tsx`、`src/ui/shell/AppShell.tsx`、`src/ui/toolbar/buttons/RasterizeButton.tsx`、`src/ui/layers/LayerInfoSection.tsx`、`src/wasm/pcv-wasm/*`。削除: `RasterDialog.tsx`、`RasterInfoSection.tsx`。
設計書: `docs/book/src/{flows/point-cloud-tools,frontend/datasource,rust/pcv-core,rust/pcv-convert,rust/pcv-wasm}.md`。
`data-testid`: 既存の E2E 用（`open-button` など）は触っていない。新しく `raster-value-*`・`raster-class-*`・`raster-cell-size`・`raster-tiff-*`・`raster-export`・`raster-close`・`raster-canvas`・`raster-legend`・`raster-download-link`・`raster-preview-error` を付けた。

## テスト

- Rust: `pcv-core`（深さの上限が深いノードを読まない `depth_limit_skips_deeper_nodes`、持つ点が上限以下 `held_points_never_exceed_the_cap` / `push_refuses_past_the_cap_and_keeps_memory_flat`、色の段が `colormap.ts` と同じ `ramp_matches_colormap_ts`、RGBA の読み戻しとタグ `rgba_u8_roundtrip_with_geo_tags` / `colored_geotiff_is_rgba8_with_the_given_range_and_the_geo_tags`、バッファの形 `to_bytes_has_the_documented_layout`、設定を変えても読み直さない `render_switches_value_and_class_without_reading_again`）、`pcv-convert`（書き出しが GeoTIFF 以外を書かない、キャンセル、上限、色付きが渡した範囲を使う、プレビュー用の読みの上限とキャンセル）。
- TS: `src/app/raster-window.test.ts`（開く・設定を変える・古い答えを捨てる・書き出す・キャンセル・閉じる）、`src/datasource/raster.test.ts`（バッファの読み方）、`web-protocol.test.ts`（要求の形）、`colormap.test.ts`（Rust と同じ値の対応）。

## 測定（実際に実行した）

### デスクトップ（リリースビルドの example。他の cargo が動いていない時）

コマンド: `cargo build -p pcv-convert --release --example rasterize_copc`、`rasterize_copc preview <渋谷> 0.5 [cap]`。出力の全文: `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\9abf0cdc-f427-4eff-bf22-b8839bdd7c27\scratchpad\preview_shibuya.log`。cap = 300 万のとき:

```
read upper levels: 1.46s
PreviewOpenInfo { held_points: 2915668, depth: 2, truncated: false }
held bytes: 93301376
render rgbMean: 35.37ms (1025 x 769 cells, preview cell 3.125, ...)
render zMean: 36.74ms   render count: 35.67ms   render intensityMean: 37.48ms
render zMean ground: 25.71ms
```

つまり、最初のプレビューまで 約 1.5 秒（読み）、値・分類の切り替えは 約 26〜37 ms（再現: 2 回目の実行で 1.38 秒 / 34〜39 ms）。ピーク private bytes（200 ms ごとの `PrivateMemorySize64` の最大）: **122 MiB**（`r3\preview.peak`）。

書き出し（全点。`rasterize_copc export`）:

コマンド: `rasterize_copc export <渋谷> <出力>.tif <セル> <種類>`（色付きが既定）。計測スクリプト: `scratchpad\r3\measure.ps1`（200 ms ごとに private bytes の最大を取る）。

| 設定 | 格子 | 時間 | ピーク private | 出力 |
|---|---|---|---|---|
| 0.5 m・RGB・色付き | 6400 x 4800（30.7M） | 655.01 秒 | 857 MiB | 122,899,514 B（RGBA 8bit） |
| 1 m・標高 平均・色付き | 3200 x 2400（7.68M） | 516.08 秒 | 123 MiB | 30,724,154 B |

どちらも `max buffered points` は 100,000（1ノード分）で、点数に比例しない。**時間は G1-T6 の測定（178〜185 秒）より大幅に長い**。この計測の間、ほかの作業（Chromium・vitest・他のセッション）が同時に動いていたので、同じ条件の比較ではない。原因の切り分け（読みの処理が遅くなったのか、機械が混んでいたのか）は**していない**（未検証）。メモリは G1-T6 の 1,285 MiB（RGB・Z の合計と表示用の点を含む版）より小さい（表示用の Z の合計をやめたため。ただし格子の形が同じ測定ではないので、推定）。

**切り分け（コーディネーター、2026-10-22）**: 同じ渋谷・1 m・標高 平均で、新旧の example を続けて1回ずつ走らせた（他の重い処理は無し。測り方は同じ200 ms ごとの private bytes）。

| 版 | 時間 | ピーク private |
|---|---|---|
| 新（`origin/main` = `370d409` 時点。`rasterize_copc export … 1 zMean`） | 754.93 秒 | 124 MiB |
| 旧（`d033d67~1`。表示用 COPC も書く版。`rasterize_copc <in> <tif> <copc> 1 zMean`） | 736.50 秒 | 302 MiB |

旧版も今は同じくらい遅いので、**遅くなったのはコードの変更ではなく、この PC の状態**（G1-T6 の 178 秒を測った時と比べて）。
PC の何が違うか（電源の設定・温度・ディスク・ウイルス対策の検査など）は**調べていない**。新しい版はメモリが少ない（124 MiB 対 302 MiB）。

### Web（実ブラウザ・実 GPU）

ヘッドあり Chromium、`adapter.info` = `{"vendor":"nvidia","architecture":"lovelace"}`（SwiftShader ではない）、`data\autzen-classified.copc.laz`、表示単位 m（ファイルは ft）。スクリプトは `scratchpad\r3\check.mjs`。2 回の実行:

- ウィンドウを開く → 最初のプレビュー（キャンバス）: 1913 ms、1961 ms
- RGB → 標高 平均に切り替えて凡例が出るまで: 165 ms、141 ms
- 書き出し（色付き、RGB、1 m = 1,045 x 1,420 セル）: 9.7 秒、7.1 秒。標高の色付き、値のままの標高も成功。`viewer-error` なし、`pageerror` なし

スクリーンショットとファイル（すべて `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\9abf0cdc-f427-4eff-bf22-b8839bdd7c27\scratchpad\r3\`）:

- `1-rgb.png`（RGB のプレビュー）、`2-elevation.png`（標高。凡例 123.79 m〜180.47 m）、`3-count.png`、`4-count-ground.png`、`5-exported.png`（書き出し後のダウンロードのリンク）
- 書き出した TIFF: `autzen-rgb-colored.tif`、`autzen-zmean-colored.tif`、`autzen-zmean-values.tif`。Windows の WIC（フォトと同じデコーダー。`tiff2png.ps1`）で読むと、色付きは `1045 x 1420, Bgra32`、値のままは `Gray32Float`。変換した `autzen-rgb-colored.png`・`autzen-zmean-colored.png` は見たとおりの絵（空のセルは PNG では黒に見えるが、アルファは 0）

## 所有者の確認手順

1. `npm run tauri dev` で点群（渋谷など）を開き、点群レイヤーを選んで「ラスタ化」。1〜2 秒でプレビューが出ること。値・分類・セルの大きさのボタンを押すと、すぐ描き直すこと。元のレイヤーが隠れないこと。
2. 「書き出す」→ 保存ダイアログで場所を選ぶ → 進捗ダイアログ（キャンセルも試す）→ 保存される。**色付き**の `.tif` を Windows のフォトで開いて、プレビューと同じ絵（白黒でない）に見えること。値のままの `.tif`（解析用）は QGIS で。
3. QGIS で色付きの `.tif` を開き、座標系（EPSG）が付いて位置が合うこと、空のセルが透明なこと。
4. Web 版でも同じ操作（書き出しはダウンロード）。

## 確かめていないこと

- デスクトップの画面（Tauri のウィンドウ、保存ダイアログ、`raster_preview_*` コマンドを画面から）。Rust の単体テストと example だけ。Android。
- QGIS・GDAL・Windows のフォトで開くこと（`tiff` クレートと WIC での読み戻しだけ）。
- 渋谷の Web での実行（autzen だけ）。
- 色のずれ: 8bit/16bit の判定は、プレビューと書き出しでそれぞれのセルの平均色から行う（極端に暗いファイルでは食い違いうる。未検証）。
- 64M セル（デスクトップ）・16M セル（Web）の上限は G1-T6 のまま（今回は測り直していない）。

## 追記（2026-10-22）: プレビューの穴埋めと、プレビュー領域の使い方

### 1. プレビューの空セル（穴）を埋める（`✨ feat(raster)`）

**何を**: プレビューだけ、空のセルの周りの8セルのうち 5 セル以上に値があれば、値のある隣の平均でそのセルを埋める。
RGB はチャンネルごとの平均（四捨五入）。1 回だけ、**元の（埋める前の）格子**から判定するので、埋めた値が次のセルに広がらない（連鎖しない）。
色を付ける前の値で行う。凡例の最小・最大は埋める前の格子から取る。埋めたセルは周りの平均なので最小・最大の中に収まり、範囲は変わらない（コメントにも書いた）。
閾値 `FILL_MIN_NEIGHBOURS = 5` は名前付きの定数。角のセルは隣が 3 つ、辺のセルは 5 つしかないので、角は決して埋まらない（辺は 5 つ全部に値があれば埋まる）。

**なぜ**: プレビューは間引いた点（1 セルに平均 2〜3 点）から作るので、点が 0 のセルが散らばって、透明（市松模様）が白・灰色の点々に見える。全点を使う書き出しにはそれが無く、プレビューのほうが悪く見えていた。

**採らなかった案（所有者の判断）**: (a) 点の密度に合わせてプレビューのセルを粗くする（セルの大きさを選ぶ意味が薄れる）。(c) そのままにする。
8 セル中 5 セルとしたのは、川の縁のような本当の隙間は隣の空セルが多いので埋まりにくく、サンプリングの偶然でできた穴だけが埋まるため。

**書き出しは変えていない**: `fill_isolated_holes` は `CoarsePoints::render`（`crates/pcv-core/src/raster/preview.rs`）からだけ呼ぶ。書き出し（`output.rs`）は `CellColorizer` を直接使い、呼ばない。
`grep fill_isolated` で、preview.rs と color.rs の doc コメント以外に使用箇所が無いことを確かめた。書き出し側の色付けが穴を空のままにすることはテスト `export_colouring_leaves_holes_empty_while_the_preview_fills_them` で固定した。

**触ったファイル**: `crates/pcv-core/src/raster/preview.rs`（`fill_isolated_holes`・平均の関数・テスト）、`crates/pcv-core/src/raster/color.rs`（`CellColorizer::rgba` を `rgba_of_rgb` と `rgba_of_value` に分けた。振る舞いは同じ）、`src/wasm/pcv-wasm/pcv_wasm_bg.wasm`（`📦 build(wasm)` で作り直し）。

追加したテスト: 穴の周り 8 セルが埋まっていると平均が入る／隣 4 つでは空のまま・5 つで埋まる／辺は存在する隣だけを数え、角は埋まらない／隣り合う 2 つの穴で連鎖しない／RGB はチャンネルごと／書き出し側の色付けは穴を空のままにする。

### 2. プレビューを領域いっぱいに（縦横比のまま）広げる（`🐛 fix(ui)`）

**何を**: `src/ui/tools/RasterWindow.tsx`。以前は画像（キャンバス）が元のピクセルの大きさのまま左に寄り、右が空いていて、凡例だけが全幅に広がっていた。
今は「画像・凡例・注記」を 1 つの列にまとめ、列の幅の上限を `55vh x 縦横比` にして中央に置き、キャンバスはその幅に CSS で拡大・縮小する（`image-rendering: pixelated` のまま）。凡例と注記は画像と同じ幅になる。縦長のレイヤーは高さ 55vh が上限（凡例が窓の外に出ないように）。
`data-testid` は残した（`raster-canvas`・`raster-legend`・`raster-preview` ほか。`raster-preview-column` を追加）。

### 実行したコマンドと出力

- `cargo test -p pcv-core`: `test result: ok. 170 passed; 0 failed; 1 ignored`
- `cargo clippy --workspace --all-targets -- -D warnings`: 警告なしで `Finished`
- `cargo fmt --all`: 実行済み
- `npm run build:wasm`: `Finished release`（`.js`・`.d.ts` は行末だけの差だったのでコミットせず戻した）
- `npx tsc --noEmit`: 出力なし（通った）
- `npx vitest run`: `Test Files 77 passed (77)`、`Tests 748 passed (748)`

### Web（実ブラウザ・実 GPU）

ヘッドあり Chromium、`adapter.info` = `{"vendor":"nvidia","architecture":"lovelace"}`（SwiftShader ではない）。`npm run build` のあと `vite preview --port 4631`（自分で立て、終わりに自分のプロセスだけ止めた）。スクリプトは `scratchpad\r4\check.mjs`。
ディレクトリ: `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\9abf0cdc-f427-4eff-bf22-b8839bdd7c27\scratchpad\r4\`

- 縦長（autzen、1400 x 900）: `autzen-rgb.png`・`autzen-elevation.png`。キャンバス 362 x 492 px、列 364 px、凡例 364 px（画像と同じ幅）。以前の `r3\2-elevation.png` にあった白・灰色の点々が、ほぼ無くなっている（目で見た比較）。
- 横長（合成 LAS 1000 m x 200 m、`wide.las`。点はまばらな乱数）: `wide-rgb.png`・`wide-elevation.png`。キャンバス 684 x 137 px、列 686 px。領域の幅いっぱいで、凡例・注記も同じ幅。
- 狭い画面（390 x 844、設定の下にプレビュー）: `autzen-narrow-rgb.png`・`autzen-narrow-elevation.png`、`wide-narrow-rgb.png`・`wide-narrow-elevation.png`。ダイアログ内を下へスクロールして見る形（`viewer-error` なし、`pageerror` なし）。

## 所有者の確認手順（追記分）

1. 点群を開いてラスタ化。プレビューの透明な点々（散らばった空セル）が以前より少ないこと。川の縁や点群の外側は透明のまま。
2. 書き出した TIFF が、これまでと同じ（穴埋めされていない）こと。
3. プレビューが領域の幅（縦長は高さ 55vh）いっぱいに出て、画像・凡例・注記の左右がそろうこと。画面を狭くしても崩れないこと。

## 確かめていないこと（追記分）

- 穴埋めを入れたプレビューの実行時間（コーディネーターが別に測る）。
- 渋谷など大きな点群のプレビューの見た目（autzen と合成データだけ）。
- デスクトップ（Tauri）の画面。Rust は同じコードだが、画面では見ていない。
- 横長の実データ（合成データだけ）。

### 3. 窓を中身の幅に合わせる（`🐛 fix(ui)`、2 回目）

上の 2. では、縦長の画像が広い列の真ん中に寄り、左右に約 170 px の空きができ、窓の本文にスクロールバーも出た。やり直した。

- `Dialog` に `fitContent`（既定 false）を足した。true のとき `md` 以上で `md:w-fit`（`widthClass` の最大幅までは、中身の幅）。ほかのダイアログは変わらない。
- プレビューの列の幅（`md` 以上）= `min(688 px, max(85vh - 320 px, 160 px) x 縦横比)`。つまり画像の高さを「窓の最大の高さ（`max-h-[85vh]`）から、タイトル・フッター・本文の余白・説明の 1 行・凡例・注記（約 4 行）を引いた残り」にして、その高さ x 縦横比を幅にする。定数は `RasterWindow.tsx` の `PREVIEW_CHROME_PX`（320。1400 x 900 で約 300 と見て、余裕を足した）・`PREVIEW_MAX_WIDTH_PX`（688 = `max-w-5xl` 1024 から余白 32・設定の列 288・間 16 を引いた値）・`PREVIEW_MIN_HEIGHT_PX`（160）。
- 設定の列と画像の列は `md:items-start` で上にそろえる（横長で設定の列が高いとき、画像は上）。
- 狭い画面（md 未満）は縦に積むまま、画像は全幅、スクロールあり。
- `PREVIEW_CHROME_PX` は固定の値なので、注記が 5 行以上に折り返す言語・文字サイズではスクロールが出うる（未検証）。

実機（ヘッドあり Chromium、nvidia / lovelace）で、`r4\check.mjs` が本文の `scrollHeight` と `clientHeight` を測った。`...\scratchpad\r4\` に置いた:

| 画面 | 画像 | 本文のスクロール | スクリーンショット |
|---|---|---|---|
| autzen（縦長）1400 x 900 | 325 x 442 px | なし（604 = 604） | `v2-autzen-1400x900-rgb.png`、`-elevation.png` |
| autzen 1280 x 720 | 213 x 289 px | なし（483 = 483） | `v2-autzen-1280x720-rgb.png`、`-elevation.png` |
| 合成の横長 1400 x 900 | 686 x 137 px | なし（468 = 468） | `v2-wide-1400x900-rgb.png`、`-elevation.png` |
| 合成の横長 1280 x 720 | 686 x 137 px | なし（468 = 468） | `v2-wide-1280x720-rgb.png`、`-elevation.png` |
| autzen 390 x 844 | 315 x 428 px（全幅） | あり（積み重ね、想定どおり） | `v2-autzen-390x844-rgb.png`、`-elevation.png` |

縦長の画像の左右には、窓の端との空き（本文の余白 16 px）しかない。ただし窓は上の説明文（1 行）の幅でも決まるので、画像の右に 8 px ほど余分が残る。
`npx vitest run`: 748 passed、`npx tsc --noEmit`: 出力なし。1280 x 720 の縦長は画像が小さい（213 px 幅）。これは窓の高さが 720 しかないため。
