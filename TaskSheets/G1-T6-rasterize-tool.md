# G1-T6: ラスタ化ツール（デスクトップと Web）（G1-3・G1-4）

- 日付: 2026-10-21
- 計画: [G1-raster-and-dtm.md](./G1-raster-and-dtm.md) の 1・2.1・3・4・5・9.3・12 節。部品は [G1-T2](./G1-T2-raster-grid-geotiff.md)、ツールの走らせ方は [G1-T1](./G1-T1-tools-wording-hide.md)
- 状態: デスクトップの Rust・Web（実ブラウザ・実 GPU）で動作を確かめた。**デスクトップの画面（Tauri のウィンドウ）・Android・QGIS で開くことは未確認**

## 何を作ったか

リボンの「ラスタ化」から、選んだ点群レイヤーを次の2つにする。元のレイヤーは変えず、できたあとに非表示になる（ADR-0018、`hideSourceLayers`）。

1. **GeoTIFF**（成果物）
2. **表示用のレイヤー**（空でないセルの中心に1点ずつ置いた COPC）。既存の renderer・レイヤーの仕組みでそのまま見える

値の種類: Z の最小・最大・平均、点数（密度）、強度の平均、色（RGB）の平均。分類: すべて / 地表のみ（分類 2）。
RGB はレイヤーが色を持つとき（`CloudInfo.hasColor`）だけ選べる（Rust も `NoColor` で断る）。

### 部品の置き場所（コミット順）

- `pcv-core/src/raster/geotiff.rs`: RGB の GeoTIFF を **RGB + アルファの4バンド**（`ExtraSamples`=2、空のセルはアルファ 0）にした。読み戻すテストあり。
  理由: 空のセルが黒く塗られて「黒い地面」に見えるのを避ける。
- `pcv-core/src/raster/grid.rs`: Z の種類でない値（点数・強度・色）のとき、表示用の点の Z に使う **Z の合計**をセルごとに足した（`display_z_at`）。
  理由: 表示用の点は「Z=セルの平均の Z、値は強度か色」と決めたため（計画 2.1）。Z の種類は値そのものが高さなので足さない（メモリを増やさない）。
- `pcv-core/src/raster/output.rs`: `RasterOptions`（ダイアログの設定。JSON から読む）、`write_geotiff`、`missing_crs_warning`、表示用の点（`DisplayPoints` と、借用を持たない `DisplayCursor`）、`filled_cells`。
  デスクトップと Web で同じ出力にするため、共有部分はここに集めた。`DisplayCursor` は、Web が `feed` の合間にイベントループへ戻り、続きから再開するために分けた（アキュムレータを借りたままのイテレータは、それを持つ構造体に入れられない）。
- `pcv-convert/src/raster.rs`（`rasterize_path_and_timings`）: `ExtractPoints::all` で全点を1回流し読み → 格子に足す → GeoTIFF を書く → 表示用の点を `write_streaming_with_cancel_and_timings` へ遅延で渡す。
  進捗は既存のツールの進捗（ノードごと）。キャンセルは読み（ノードごと）と COPC の書き出しで効く。失敗・キャンセルでは GeoTIFF も消す。
- `src-tauri/src/conversion.rs`: `rasterize_copc`（`run_tool` に乗せたので panic も文字列のエラーになる）と `save_tool_file`（保存ダイアログで選んだ場所へコピー。コピー元は `pcv-tools` フォルダ内に限る）。権限 `dialog:allow-save` を足した。
- `pcv-wasm/src/raster.rs`（`WasmRasterizer`）: `feed` が2段階（読み → 空でないセルを spill に書く）、`geotiff()`、`finish()`。コンストラクタがセル数の上限を超えた格子を、点を読む前に断る。
  Worker（`rasterStart`）は GeoTIFF のバイト列を `tool-done` で**転送**し、本体が Blob の URL にしてダウンロードリンクにする。
- TS: `src/app/point-cloud-tools.ts` の `rasterizeLayer`（既存の `runTool` を使う）と `saveRasterGeoTiff`、`ViewerLayer.raster`、`RasterDialog`（`SectionDialog` と同じ `Dialog`）、リボンの `RasterizeButton`、レイヤー情報の `RasterInfoSection`。
  ダイアログのセルの大きさは表示単位（m / ft）で入れ、ファイルの単位に直す（断面と同じ `displayLengthToFile`）。

EPSG が無いとき: GeoTIFF は座標系なしで書き、結果の `warnings` に日本語の警告を入れてエラーログに出す。

## 途中で見つけて直した不具合（画面で見つけた）

最初の版では、結果のレイヤーが**真っ黒**だった（テストは全部緑だった）。表示用の点の色が（0,0,0）で、既定の着色（RGB）だったため。
直し方: 色を持たない種類の点は、他の点と同じ中間の灰色にし、レイヤーの最初の着色をセルの値に合わせた（RGB→rgb、高さ→標高、点数・強度→強度。`initialColorModeForRaster`）。
画面で確認した（下のスクリーンショット）。

## 採らなかった案

- 表示用レイヤーの色を白にする: 着色の初期値を値に合わせるほうが、開いてすぐ意味のある絵になる。
- GeoTIFF を Web で OPFS のファイルに書く: ファイルの寿命（消し忘れ）を増やすだけ。Worker から転送して Blob にした（上限 16M セルで最大でも RGBA 128 MB）。
- 保存を Rust のダイアログで行う: 既に使っている保存ダイアログのプラグインを `tauri.ts` から呼び、コピーだけ Rust のコマンドにした。
- 地理座標系（EPSG:4326 など）の GeoTIFF（GTModelType=2）: 今回は投影座標系だけ。点群は通常投影座標系のため。**未対応**として残す。

## セル数の上限

| | 上限 | 根拠 |
|---|---|---|
| デスクトップ | 64,000,000 セル | 1セルあたり最大 36 B（RGB: 合計 u64×3＋点数 u32＋Z の合計 f64）。**測定**: 渋谷（3.48 億点）を 0.5 m・RGB（6400×4800＝30.7M セル）でピーク private 1,285 MiB。ここから上限の 64M セルは約 2.5 GiB と**推定**（未測定）。GeoTIFF は RGBA で 512 MB（4 GB の限界の内側） |
| Web | 16,000,000 セル | wasm の 4 GiB のうち、格子（RGB で 576 MB）と GeoTIFF（最大 128 MB）と spill を考えて 1/4。**測定**: autzen を 1 ft・RGB（3427×4656＝15.96M セル）で、実ブラウザ 33 秒で成功。0.5 ft（6853×9312）は日本語のメッセージで断られた |

超えると、格子の日本語メッセージ「ラスタが大きすぎます（… 列 x … 行、上限は…セル）。セルの大きさを大きくするか、先に範囲を切り出してから実行してください」を出す。上限を外すにはタイル分割（G1-9）が要る。

## 測定（デスクトップ。リリースビルドの example `crates/pcv-convert/examples/rasterize_copc.rs`）

`tokyo-shibuya-merged-v2.copc.laz`（347,797,138 点、6462 ノード）。時間は example の経過時間、メモリは PowerShell で 200 ms ごとに `Process.PrivateMemorySize64`（private bytes）を取った最大値。
**他の cargo のビルド・テストが同時に動いていた**ので、速度は目安。

| 設定 | 格子 | 表示用の点 | 時間 | ピーク private |
|---|---|---|---|---|
| 1 m・Z 平均 | 3200×2400（7.68M） | 6,574,698 | 178 秒 | 422 MiB |
| 0.5 m・RGB 平均 | 6400×4800（30.7M） | 26,277,170 | 185 秒 | 1,285 MiB |

どちらも `max buffered points` は 100,000（1ノード分）で、点数に比例しない。GeoTIFF は 1 m で 30.7 MB。出力（1 m の結果）:
`C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\94185ff5-fa53-4b91-8c39-9a0ed557db69\scratchpad\rt\shibuya-1m.tif`（と `.copc.laz`）。

## テスト

- Rust: `pcv-core`（GeoTIFF のアルファ、出力、表示用の点、灰色）、`pcv-convert/src/raster.rs`（セルごとの値、表示用の点の数＝空でないセル数、地表のみ、RGB の4バンド、上限での拒否、地表なしでの `NoPoints`、1ノードの上限、キャンセル後にファイルが残らない、進捗）。
- TS: `rasterizeLayer`（成功で新レイヤー＋元を非表示＋警告、失敗・キャンセルで元は表示のまま、色なしで RGB を断る、点群でない）、`buildRasterStartRequest`、`initialColorModeForRaster`。

## 画面での確認（Web ビルド、実 GPU）

`adapter.info` = `{"vendor":"nvidia","architecture":"lovelace"}`（SwiftShader ではない）。ヘッドあり Chromium、`data\autzen-classified.copc.laz`、表示単位 ft。
結果のスクリーンショットと GeoTIFF（QGIS で開く用）は `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\94185ff5-fa53-4b91-8c39-9a0ed557db69\scratchpad\g1t6\screens\`:

- `zmean-3ft-1-dialog.png`（ダイアログ）、`zmean-3ft-3-result.png`（元を外した結果。標高で着色）、`autzen-zmean-3ft.tif`
- `rgb-3ft-3-result.png`（色の平均）、`autzen-rgb-3ft.tif`
- `rgb-1ft-3-result.png` / `autzen-rgb-1ft.tif`（15.96M セル。33 秒）
- `toolarge-1-after.png`（0.5 ft の拒否）

Console に error / panic は出なかった。

## 所有者の確認手順

1. QGIS で上の `.tif` を開く: 座標系が EPSG:2992、大きさが 1,143×1,553（3 ft）、RGB の `.tif` は**空のセルが透明**（アルファバンド）で、角が黒くないこと。`autzen-zmean-3ft.tif` は NoData（-9999）が透明に見えること。
2. デスクトップ: `npm run tauri dev` で点群を開き、リボンの「ラスタ化」→ 実行。新しいレイヤーができ、レイヤー情報に「保存」が出る → 保存ダイアログで `.tif` を保存して QGIS で開く。
3. 点群レイヤーを選ばないと「ラスタ化」が押せず、ツールチップに理由が出ること。
4. 実行中に進捗ダイアログのキャンセルを押すと、元のレイヤーは表示のままで、新しいレイヤーもできないこと。

## 確かめていないこと

- デスクトップの画面（Tauri のウィンドウ）での実行・保存ダイアログ（Rust の単体テストと example だけ）。Android（`content://` は未対応エラー）。
- QGIS・GDAL で GeoTIFF を開くこと（`tiff` クレートでの読み戻しだけ）。
- 64M セルのデスクトップ実行（上限は推定）。Web で 16M セルを超えない大きな実データ（渋谷など）。
- 地理座標系の GeoTIFF。Firefox・Safari。
