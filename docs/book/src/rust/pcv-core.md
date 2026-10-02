# pcv-core: COPC の読み込み

`crates/pcv-core` は COPC の読み込み・octree 走査・座標変換を担う crate です。
[規約1](../conventions.md#規約1-pcv-core-は-tauri-を知らない)により Tauri を知らず、
ネイティブと `wasm32-unknown-unknown` の両方でビルドできます。これがデスクトップ・
Android・Web のすべてで**同じ読み込みコード**を使えている理由です。

公開 API は [`crates/pcv-core/src/lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/lib.rs) の `pub use` に集約されています。

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
| [`mod.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/mod.rs) | 上記をまとめる `Crs` 列挙型、EPSG コードとの対応、LAS ヘッダーからの CRS 判定 |

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

式の出典は河瀬(2011)の論文（国土地理院時報）で、精度は国土地理院の測量計算サイト API
と Karney (2011) の `TMcoords.dat` という2つの独立した出典付きデータで検証しています
（「それらしい値」では済ませていません）。検証の詳細は
[ADR-0008 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md#追記2026-09-24-横メルカトル変換の実装と精度検証m4-5) を参照してください。

**この座標変換は、計算とテストまでが実装済みで、画面への表示配線（情報パネルへの
1行表示）はまだありません**（M4-5 の範囲外として明記されています）。

対応していないもの（[ADR-0008](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md) の「対応しないもの」節）:

- 旧日本測地系（Tokyo Datum）からの変換
- 鉛直座標系（ジオイド）。DTM/TIN に着手する前に必須
- JGD2000 と JGD2011 の間の座標補正（型としては区別するが、変換パラメータは持たない）
- PLY/PCD のように CRS を持たない形式への対応（「不明」のまま扱う）

## まず読むファイル

- [`crates/pcv-core/src/copc.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/copc.rs)
- [`crates/pcv-core/src/node_format.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/node_format.rs)
- [`crates/pcv-core/src/crs/mod.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/crs/mod.rs)
