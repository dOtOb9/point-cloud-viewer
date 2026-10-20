# G1-T2: ラスタのグリッド・集計・全点リーダー・GeoTIFF 書き出し（G1-1・G1-2）

- 日付: 2026-10-21
- 計画: [G1-raster-and-dtm.md](./G1-raster-and-dtm.md) の 2.1・2.3・3・4・12 節（流れ T2）
- 状態: 実装とテストは済み。**QGIS / GDAL で開けることは未確認**（所有者の確認待ち）

## 何を作ったか

すべて `crates/pcv-core`（Tauri に依存せず、wasm32 でビルドできる）。UI・Tauri・wasm のバインディングはまだ無い。

### G1-1 グリッドと集計（`src/raster/grid.rs`）

- `GridSpec { origin_x, origin_y, cell_size, width, height }`。`from_bounds` で XY の範囲とセルの大きさから作る。
  - 原点（南西の角）はセルの大きさの倍数に**切り下げ**てそろえる。隣り合うレイヤーのラスタが同じ格子に乗る
  - セル数の上限は呼び出し側が渡す。超えたら日本語のエラー（セルの大きさを大きくするか、範囲を切り出すよう案内）
  - `cell_index(x, y) -> Option<usize>`。範囲外・有限でない値は `None`。最大の端の上にある点は最後の列・最後の行（北端の行 0）に入る
- **行 0 は北の行**（Y が最大）。GeoTIFF・画像の並びと同じ。`row * width + col` の順に出力すれば、そのまま画像になる
- `CellAccumulator`: Z の最小・最大・平均、点数、強度の平均、RGB の平均（u16 の3チャンネル）。選んだ値に要るものだけをセルごとに持つ
  （最小・最大は f32 1つ、平均は f64 の合計＋u32 の点数、RGB は u64 ×3＋u32）。空のセルは `None`（f32 の出力では NoData、RGB は黒）
- `ClassFilter`: 全部 / 選んだ分類だけ
- `f32_samples` / `rgb_samples`: 画像の順に並べた**遅延イテレータ**。グリッドの2つ目のコピーを作らずに GeoTIFF の書き出しへ渡せる

### 全点を読むリーダー（`src/extract.rs`）

- `ExtractPoints::all(reader)` を足した。`ExtractFilter` の内部の `filter` を `Option` にし、`None` なら全点を返す。
  読み方（1ノードずつ読み、次のノードの前に捨てる）は既存の `ExtractPoints::new` と同じなので、メモリは点数に比例しない
- COPC の各レベルの点は重ならないので、全ノードを読めばヘッダーの点数ちょうどになる（テストで確かめた）
- 採らなかった案: `ExtractFilter` に `All` を足す。`ExtractFilter` は TypeScript から JSON で受け取るので形が契約になっている。
  触らずに、別のコンストラクタにした
- 注意（呼び出す側へ）: 色を持たない COPC の点は、`LasPointRecord::from_las_point` が (32768, 32768, 32768) の灰色を入れる。
  RGB のラスタ化は、レイヤーに色があるときだけ許す（`CloudInfo` で見る）ようにすること

### G1-2 GeoTIFF の書き出し（`src/raster/geotiff.rs`）

- 手書き・クラシック TIFF（リトルエンディアン）・無圧縮・ストリップ（約 64 KiB）。`std::io::Write` に前へ進む順だけで書く
  （ヘッダー → タグの表 → 表に入りきらない値 → 画素。オフセットは書く前に全部分かる）。画素はイテレータから1ストリップずつ書く
- 形は2つ: `write_f32`（1バンドの float32、NoData あり）と `write_rgb_u16`（3バンドの u16）
- タグ: ImageWidth・ImageLength・BitsPerSample・Compression=1・PhotometricInterpretation（f32 は 1、RGB は 2）・StripOffsets・
  SamplesPerPixel・RowsPerStrip・StripByteCounts・PlanarConfiguration=1・SampleFormat（3 / 1）・ModelPixelScale(33550)・
  ModelTiepoint(33922)・GeoKeyDirectory(34735)・GDAL_NODATA(42113)
- ModelTiepoint は画素 (0,0) の左上の**角**を `(origin_x, origin_y + height * cell)` に結ぶ（PixelIsArea）
- EPSG コードがあるときだけ GeoKeyDirectory を書く（GTModelType=1、GTRasterType=1、ProjectedCSType=EPSG）。**コードが無いときは
  GeoKeyDirectory ごと書かない**（「投影座標系」と書いて CRS が無い、という嘘を避ける）。呼び出す側が警告を出すこと。
  0 と 32767 以上（SHORT に入らない、または「ユーザー定義」）はエラー
- 4 GB に収まらないサイズは、画素を1つも読む前にエラー（`TooLargeForTiff`）。画素の数が合わないときもエラー
- 採らなかった案: `tiff` クレートを実行時の依存にする（計画の 3 節のとおり。GeoTIFF のタグは結局汎用の書き込みで書くことになり、
  何が書かれるかが隠れる）。`tiff` は読み戻すテストのための dev-dependency だけ

## テストを pcv-core に置いた理由

`copc-writer` が既に pcv-core の dev-dependency にあり、`copc.rs` のテストが `write_source` で小さな COPC をその場で作っている。
`pcv-convert` に置くより差分が小さく、読み手も同じ crate の中で追える。追加した dev-dependency は `tiff`（0.11.3）だけ。
実行時の依存は増えていない。

## 触ったファイル

- `crates/pcv-core/src/raster/mod.rs`（新規。`RasterError`）、`grid.rs`（新規）、`geotiff.rs`（新規）
- `crates/pcv-core/src/extract.rs`（`ExtractPoints::all`）、`crates/pcv-core/src/extract/all_points_tests.rs`（新規）
- `crates/pcv-core/src/lib.rs`（`pub mod raster;`）、`crates/pcv-core/Cargo.toml`（dev-dependency `tiff`）、`Cargo.lock`
- `crates/pcv-core/examples/write_sample_geotiff.rs`（QGIS 確認用のサンプルを書く例）

## 所有者の確認手順

1. サンプルを作る（作り直すとき）:
   `cargo run -p pcv-core --example write_sample_geotiff -- <出力先>.tif`
2. QGIS で開く。確かめること:
   - 画像は 200 x 100 セル（1 m）。CRS が EPSG:6677（JGD2011 / 平面直角 IX 系）になっている
   - 値は `列 + 行` なので、**左上が最小（0）、右下が最大（297）**になる（行 0 が北）
   - 真ん中の 20 x 20 の穴は NoData で、**透明**に見える（値は -9999 と出ない）
   - 左上の角の座標が (X, Y) = (-5000, -34900)（原点 -35000 ＋ 高さ 100 m）
3. `gdalinfo` があれば、`NoData Value=-9999`・`Origin = (-5000, -34900)`・`Pixel Size = (1, -1)` を見る

## 確かめていないこと

- QGIS・GDAL での読み込み（`tiff` クレートでの読み戻しだけを確かめた。タグの値は読み戻して確かめた）
- RGB の GeoTIFF を QGIS で開いたときの見え方
- 実際の COPC（渋谷など）での時間・メモリ（G1-3 で測る）
