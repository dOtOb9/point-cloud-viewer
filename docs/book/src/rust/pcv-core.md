# pcv-core: COPC の読み込み

`crates/pcv-core` は COPC の読み込み・octree 走査・座標変換を担う crate です。
[規約1](../conventions.md#規約1-pcv-core-は-tauri-を知らない)により Tauri を知らず、
ネイティブと `wasm32-unknown-unknown` の両方でビルドできます。これがデスクトップ・
Android・Web のすべてで**同じ読み込みコード**を使えている理由です。

公開 API は [`crates/pcv-core/src/lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/lib.rs) にあり、
`pub mod crs`(座標参照系)・`pub mod extract`(条件に合う点の抽出)と、次の `pub use` で構成されています。

```rust
pub use copc::{CloudInfo, CopcError, CopcFile, Hierarchy, HierarchyNode, NodeKey, Result};
pub use node_format::{
    encode_node, NodeBuffer, NodePoint, FLAG_CLASSIFICATION, FLAG_COLOR, FLAG_INTENSITY,
    HEADER_BYTES, MAGIC, POINT_STRIDE, VERSION,
};
```

## `copc.rs`: `CopcFile`

[`src/copc.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/copc.rs) が COPC の読み込み本体です。外向きの API は3つのメソッドに絞られています。

```rust
pub struct CopcFile<R: Read + Seek + Send = BufReader<File>> { /* ... */ }

impl CopcFile<BufReader<File>> {
    pub fn open(path: &Path) -> Result<Self>;
}
impl<R: Read + Seek + Send> CopcFile<R> {
    pub fn from_reader(reader: R) -> Result<Self>;
    pub fn info(&self) -> &CloudInfo;
    pub fn hierarchy(&self) -> &Hierarchy;
    pub fn read_node(&mut self, key: NodeKey) -> Result<NodeBuffer>;
}
```

`R` がジェネリックになっているのは Web 版対応のためです。既定値 `BufReader<File>`
のおかげで、デスクトップ・Android（`src-tauri`）のコードは型引数を書かずに
`CopcFile::open(path)` のまま動きます。Web 版（`crates/pcv-wasm`）はここに
`FileRangeReader`/`HttpRangeReader` を渡します（[pcv-wasm の章](./pcv-wasm.md)）。

中身の実体は [ADR-0003](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0003-copc-crate.md) で選定した `copc-core`/`copc-reader` です。
`CopcFile` はそれをラップしているだけなので、クレートを差し替える場合もこの
ファイルだけを直せば済みます。

`NodeKey`（`level`/`x`/`y`/`z` の4整数、`"0-0-0-0"` のような文字列との相互変換を持つ）、
`Hierarchy`（`NodeKey → HierarchyNode` の地図）、`read_node` がそのノードの点を
運ぶバイナリに変換するところまでの流れは[データの流れの章](../data-flow.md)を参照してください。

`read_node` は COPC の hierarchy エントリが持つ `offset`/`byte_size` へ直接 `seek`
し、そのノード自身の LAZ チャンクだけを伸長します。当初は「そのレベル全体への
空間クエリを投げて bbox で絞り込む」実装でしたが、これが遅さ（1ノード88ms）と
不正確さ（隣接ノードの点が混入する）の両方の原因でした。経緯は
[ADR-0003](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0003-copc-crate.md) の追記と [ADR-0007](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) の追記を参照してください。

## `node_format.rs`: ノードのバイナリ形式

[データの流れの章](../data-flow.md#ノードのバイナリ形式)で説明した、ヘッダ32バイト+点20バイトの
形式を組み立てる `encode_node()` がここにあります。ノードローカル相対座標への
変換（世界座標の原点を f32 に丸めてから差分を取ることで、丸め誤差を相対座標に
持ち込まない工夫）もこの関数の中にあります。

## `extract.rs`: 条件に合う点だけを読む(L2-C)

[`src/extract.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/extract.rs) は、点の選択・断面ツールの**読み側**です。
書き出しはここでは行いません(デスクトップは `pcv-convert/src/extract.rs`、Web は `pcv-wasm/src/extract.rs` が、このイテレータを `vendor/copc-writer` に渡します)。
`pcv-core` に置いてあるのは、wasm32 でビルドでき Tauri に依存しないので、両方から使えるためです。

- `ExtractFilter`(`#[serde(tag = "kind", rename_all = "camelCase")]`の列挙型): `ScreenPolygon`(画面に描いた多角形。`view_proj`(16要素、列優先)と NDC の頂点列。カメラの前(w > 0)にあり多角形に投影される点が対象で、奥行きは問わない)と、
  `OrientedBox`(向きつきの直方体。中心・単位ベクトル3本・各軸の半分の長さ。断面の板)。座標はファイルの実座標(f64)。
  `validate`(入力の形の検査)・`contains`(点ごとの正確な判定)・`may_intersect`(ノードの bbox との**保守的な**交差判定)を持つ。
- `ExtractPoints`: COPC の hierarchy から、条件と交わりうるノードだけを選び(`new`)、1ノードずつ `read_node` して、`contains` を通った点を1点ずつ返すイテレータ。
  読んだ点は次のノードを読む前に捨てるので、同時に抱えるのは1ノード分(`max_points_per_node` 以下)です。
  `set_node_callback` でノードごとの進捗とキャンセルの確認を差し込めます(一致する点が少ないとき、書き出し側のキャンセル確認だけでは遅いため)。
- `may_intersect` が `false` を返すのは「交わらないと断言できる」ときだけで、迷ったら `true`(読んでから点ごとに判定)。粗くても結果は正しく、読むノードが増えるだけです。

流れは[点の選択・断面・結合](../flows/point-cloud-tools.md)の章を見てください。

## `raster/`: ラスタ化の部品(G1)

ラスタ化ツール(カット・断面・合成と同じ並びのボタン「ラスタ化」)の、ファイルを持たない純粋な部分です。
読む(`ExtractPoints::all`)と書く(COPC)はデスクトップ(`pcv-convert/src/raster.rs`)と Web(`pcv-wasm/src/raster.rs`)にあり、ここの部品を共有します。

- [`grid.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/raster/grid.rs) — `GridSpec`(原点をセルの大きさの倍数にそろえた格子。**行 0 は北**。セル数の上限を超えると日本語で断る)と、`CellAccumulator`(点を1つずつ足す。選んだ値に要る分だけセルごとに持つので、メモリはセル数に比例し点数には比例しない)。
- [`geotiff.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/raster/geotiff.rs) — 手書きの GeoTIFF(無圧縮・ストリップ・リトルエンディアン)。1バンドの float32(NoData あり)と、**RGB + アルファの4バンド u16**(空のセルはアルファ 0 で透明。黒にはしない)。EPSG が無いときは座標系のキーを書かない。
- [`output.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/raster/output.rs) — `RasterOptions`(ダイアログの設定。JSON から読む)、`write_geotiff`、`DisplayPoints` / `DisplayCursor`(空でないセルの中心に1点ずつ置く表示用の点。高さの値なら Z=値、点数・強度・色なら Z=セルの平均の Z で、値は強度か色に入れる)。

## `crs/`: 座標参照系

[`src/crs/`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs) は横メルカトル図法ベースの座標変換です。[ADR-0008](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md) の決定により、
全世界の CRS には対応せず、**日本の平面直角座標系19系と UTM だけ**を自前実装しています。
PROJ（C ライブラリ）を使うと規約1が壊れるため、採用していません。

| ファイル | 内容 |
|---|---|
| [`ellipsoid.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/ellipsoid.rs) | GRS80 / WGS84 の楕円体パラメータ |
| [`transverse_mercator.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/transverse_mercator.rs) | 横メルカトルの順変換・逆変換の数式本体 |
| [`plane_rectangular.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/plane_rectangular.rs) | 平面直角座標系19系（I〜XIX、JGD2000/JGD2011）のパラメータ表 |
| [`utm.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/utm.rs) | UTM（51N〜56N）のパラメータ表 |
| [`mod.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/mod.rs) | 上記をまとめる `Crs` 列挙型、EPSG コードとの対応、LAS ヘッダーからの CRS 判定、ファイル同士の比較に使う `CrsId` |
| [`describe.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/describe.rs) | 画面に出すための説明 `CrsInfo`(EPSG コード・名前・種別・読み取りエラー・長さの単位) |

```rust
pub enum Crs {
    PlaneRectangular(PlaneRectangularCrs),
    Utm(UtmCrs),
    /// 対応範囲外、またはCRS情報自体が読み取れなかった。
    Unknown,
}
```

`Unknown` は「対応範囲外」と「読み取れなかった」の両方を表します。ADR-0008 の方針
どおり、対応範囲外の CRS は常に「不明」として扱われ、計測や重ね合わせには使われません。

`Crs` は「この crate が座標変換できるか」だけを持つ型です。**対応外の CRS では EPSG コードも名前も失われる**ため、次の2つを別に持っています。

### `CrsInfo`: 画面に出す説明と長さの単位(`describe.rs`)

`CloudInfo.crs` に入り、ファイルを開くときに `read_crs_info` が読みます(`CopcFile::open` / `from_reader`)。ADR-0015 により、読み取りに失敗してもファイルは開け、失敗の文言は `CrsInfo::error` に入ります。

- `epsg`・`name`・`kind`(`CrsKind`: `PlaneRectangular` / `Utm` / `Other` / `None`)
- **`horizontal_unit_to_meter` / `vertical_unit_to_meter`**(L2-D): 座標1単位が何メートルか(1.0 = メートル、0.3048 = 国際フィート)。WKT1 の `PROJCS[`・`VERT_CS[` 直下の `UNIT["name",係数]` から読む。
  `None` は「単位が不明」で、呼び出し側は換算してはいけない。WKT2(`PROJCRS[`)は読めず `None`。鉛直 CS が無いときは水平の単位と同じとみなす(これは**仮定**)。
  画面側の使い道は、計測結果とレイヤー情報の範囲を表示単位(メートル/フィート)に換算すること(`src/state/units.ts`)。

### `CrsId`: ファイル同士の比較に使う識別子(L2-G)

複数ファイルの結合で「同じ座標系か」を比べるための型です。`Crs` は対応外の CRS(例: autzen の EPSG:2992)を「不明」にしてしまい、CRS が無いファイルと見分けがつかなかったため、結合で
「CRS の情報がありません」という誤った警告が出ていました。

| 値 | 意味 |
|---|---|
| `Missing` | ファイルに CRS の情報が無い(空の WKT も含む) |
| `Epsg(u32)` | EPSG コードが分かる(この crate が対応する系かどうかは問わない) |
| `Other(String)` | EPSG コードを持たない CRS(WKT の文字列、または読めない GeoTIFF キーの注記)。同じ文字列のときだけ同じ CRS |

`crs_id_from_las_header` が作ります(WKT → GeoTIFF の順。GeoTIFF は projected キーを先に、次に geodetic)。`Crs` / `detect_crs_from_las_header` は変えておらず、表示などに使われています。

### 座標変換そのものの使われ方

式の出典は河瀬(2011)の論文（国土地理院時報）で、精度は国土地理院の測量計算サイト API
と Karney (2011) の `TMcoords.dat` という2つの独立した出典付きデータで検証しています
（「それらしい値」では済ませていません）。検証の詳細は
[ADR-0008 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md#追記2026-09-24-横メルカトル変換の実装と精度検証m4-5) を参照してください。

**緯度経度との相互変換（`transverse_mercator.rs` の順変換・逆変換）は、計算とテストまでが実装済みで、`crs/` の外からは呼ばれていません**
（`grep` で確認。M4-5 の範囲外として画面への配線は見送られた状態のままです）。
一方、`CrsInfo`（EPSG・名前・単位）は画面に出ています。`pcv-convert` の `crs_override.rs` は、対応する系の WKT を組み立てるためにパラメータ表を使っています。

対応していないもの（[ADR-0008](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md) の「対応しないもの」節）:

- 旧日本測地系（Tokyo Datum）からの変換
- 鉛直座標系（ジオイド）。DTM/TIN に着手する前に必須
- JGD2000 と JGD2011 の間の座標補正（型としては区別するが、変換パラメータは持たない）
- PLY/PCD のように CRS を持たない形式への対応（「不明」のまま扱う）

## まず読むファイル

- [`crates/pcv-core/src/copc.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/copc.rs)
- [`crates/pcv-core/src/node_format.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/node_format.rs)
- [`crates/pcv-core/src/crs/mod.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/mod.rs)
