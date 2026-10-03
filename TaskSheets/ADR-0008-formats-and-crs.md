# ADR-0008: 対応する入力形式と座標参照系

- 状態: 採択
- 日付: 2026-09-23
- 前提: [ADR-0001](./ADR-0001-architecture.md)（COPC の採用、規約1）

## 決定

**入力形式**として LAS / LAZ / COPC に加えて **E57 / PLY / PCD** に対応する。
内部形式は COPC のまま変えない。

**座標参照系**は **日本の平面直角座標系（19系）と UTM** に対応する。
全世界の CRS には対応しない。したがって **PROJ を使わず、横メルカトル変換を自前で実装する。**

## 入力形式

### なぜ素直に入るのか

[ADR-0001](./ADR-0001-architecture.md) で内部形式を COPC に固定したため、構成は
**「内部形式1つ・入力形式 N 個」**になっている。形式を増やすことは
[M4](./M4-import-and-conversion.md) の入力側を広げる作業であり、
描画・LOD・ストリーミングには一切影響しない。

自前の octree 形式を採っていたら、形式ごとに変換先の整合を考える必要があった。

### 使えるクレート

| 形式 | クレート | 備考 |
|---|---|---|
| LAS / LAZ / COPC | `copc-core` / `copc-reader` | 導入済み（[ADR-0003](./ADR-0003-copc-crate.md)） |
| E57 | `e57` 0.11.13 | 純 Rust。地上型・モバイルスキャナで最重要 |
| PLY | `ply-rs` 0.1.3 | 更新が古い。実装時に評価すること |
| PCD | `pcd-rs` 0.13.0 | PCL 形式 |

**選定は [ADR-0003](./ADR-0003-copc-crate.md) と同じ基準で行う。**
すなわち `pcv-core` が `wasm32-unknown-unknown` でビルドできること（規約1）を満たさない
候補は落とす。実際に試して決め、理由を記録すること。

### 優先順位

1. **E57** — 地上型レーザースキャナの事実上の標準。測量業務で最も要求される
2. **PLY** — 写真測量・研究用途で広く使われる
3. **PCD** — PCL エコシステム。ロボティクス寄り

## 座標参照系

### 対応範囲

| 系 | 内容 |
|---|---|
| 平面直角座標系 | 19系（I〜XIX）。JGD2011 / JGD2000 |
| UTM | 日本に関係する帯（51〜56N）を含む北半球 |

**両方とも横メルカトル図法（Transverse Mercator）である。** したがって実装の本体は
横メルカトルの順変換・逆変換1本と、ゾーンのパラメータ表だけになる。

EPSG コードは実装時に EPSG レジストリで確認すること（本 ADR の記述を信用しないこと）。
概ね以下の範囲にある。

- JGD2011 平面直角座標系: EPSG:6669〜6687
- JGD2000 平面直角座標系: EPSG:2443〜2461
- UTM（WGS84 北半球）: EPSG:32601 + 帯番号

### なぜ PROJ を使わないのか

PROJ は座標変換の標準実装だが **C ライブラリである**。`pcv-core` に入れると
**規約1（`pcv-core` が wasm32 でビルドできること）が壊れる。** 規約1 は Web 版の
バックエンドが成立する条件なので、これを壊すと [ADR-0001](./ADR-0001-architecture.md) の
主要な帰結を失う。

全世界の CRS に対応するなら PROJ か同等のものが要り、「Web 版を諦める」か
「PROJ を wasm に持ち込む」かの判断を迫られた。**対応範囲を平面直角座標系と UTM に
限定したことで、この判断自体が不要になった。**

横メルカトルは数式が閉じており、クリューゲル級数による実装は数百行に収まる。
すべて単体テストで検証でき、外部依存が増えない。

`proj4rs`（Proj4 の純 Rust 移植）も候補ではあるが、**必要なのは横メルカトル1種類**であり、
汎用の変換エンジンを持ち込む理由がない。[ADR-0001](./ADR-0001-architecture.md) の
「根拠のある抽象だけを入れる」方針に沿って、自前実装を採る。

### 精度の要件

**測量用途なので、精度は検証可能でなければならない。**
国土地理院が公開している座標変換の計算例、または既知の基準点座標を用いて、
**mm オーダーで一致することをテストで確認すること。**「それらしい値が出た」で済ませない。

## 対応しないもの（重要）

以下は本 ADR の範囲外である。**必要になった時点で別の ADR を起こす。**

### 旧日本測地系（Tokyo Datum）からの変換

Tokyo Datum から JGD2000 / JGD2011 への変換は**閉じた式では表せない**。
国土地理院のパラメータグリッド（TKY2JGD）が必要になる。

古い測量成果を扱う必要が出たら、グリッドファイルの同梱とライセンスを検討すること。

### 鉛直座標系（高さの基準）

**水平の座標変換とは完全に別の問題である。**

- LiDAR が出力するのは通常 **楕円体高**
- 測量成果や地形図が使うのは **標高**（東京湾平均海面基準）
- 両者の差は日本国内で **30〜40m 程度**あり、地域によって変わる
- 変換には**ジオイドモデル**（日本のジオイド2011 等）が必要

**DTM や TIN を扱うなら、ここを無視できない。**
[ROADMAP](./ROADMAP.md) の「DTM の TIN を生成して歩く」に着手する前に、
この ADR を見直すこと。

### JGD2000 と JGD2011 の違い

2011年の東北地方太平洋沖地震による地殻変動を反映したのが JGD2011 である。
東日本では最大で **1m 前後**の差がある。**2011年をまたぐデータを扱う場合、
どちらの成果かを取り違えると測量として成立しない。**

取り込み時にどちらかを明示させ、混在させないこと。

### CRS を持たない形式

**PLY と PCD には CRS の概念が無い。** 生のジオメトリだけを持つ。
取り込み時にユーザーが座標系を指定するか、「ローカル座標・不明」として扱う。

**不明なまま計測や重ね合わせをさせないこと。** 単位すら保証されない。

## 帰結

**得たもの**
- 主要な入力形式に対応でき、内部形式は COPC 1つのまま保てる
- CRS 対応が純 Rust で完結し、**規約1 が守られる**（Web 版の可能性が残る）
- 横メルカトルだけなので、精度をテストで検証できる

**払うもの**
- 対応 CRS が限定される。海外データや測地系の異なるデータは扱えない
- 形式ごとにインポータの保守が増える

**先送りしたもの（上記「対応しないもの」）**
- Tokyo Datum からの変換（グリッドが必要）
- 鉛直座標系とジオイド（**DTM 着手前に必須**）

## 却下した案

| 案 | 却下理由 |
|---|---|
| PROJ を使って全世界の CRS に対応 | C ライブラリのため規約1（wasm ビルド）が壊れ、Web 版の可能性を失う。対応範囲の限定で不要になった |
| `proj4rs`（純 Rust の汎用変換エンジン） | 必要なのは横メルカトル1種類。汎用エンジンを持ち込む理由がない |
| 内部形式を形式ごとに変える | ADR-0001 の COPC 採用の利点（描画・LOD・Web 版が形式に依存しない）を失う |
| CRS を無視して座標をそのまま扱う | 測量用途では成立しない。異なる系のデータが重ならず、距離も正しく出ない |

## 追記（2026-09-24）: 横メルカトル変換の実装と精度検証（M4-5）

M4-5（[M4-import-and-conversion.md](./M4-import-and-conversion.md)参照）として、上記の決定どおり
横メルカトル変換を`pcv-core`に自前実装した。実装場所・詳細な実施記録は
M4-import-and-conversion.md の M4-5 節の「実施記録」を参照。ここでは ADR として
残すべき決定事項（式の出典、精度検証の方法、範囲外にしたもの）だけを記す。

### 式の出典

河瀬和重(2011)「Gauss-Krüger投影における経緯度座標及び平面直角座標相互間の
座標換算についてのより簡明な計算方法」国土地理院時報, 121, 109-124.
<https://www.gsi.go.jp/common/000061216.pdf>

国土地理院自身が公開している測量計算サイトの解説ページ
(`.../surveycalc/algorithm/bl2xy/bl2xy.htm`, `.../xy2bl/xy2bl.htm`)もこの論文と
同じ式を掲載しており、突き合わせて一致することを確認した。楕円体は
JGD2000/JGD2011ともGRS80（ADR本文どおり）、UTMはWGS84（EPSG:326xx系列に
合わせた。ADR本文「座標参照系」節の記述どおり）。

### 精度の検証方法（「それらしい値」で済ませていないことの記録）

**出典付きの期待値を2種類、独立に用意した。**

1. **国土地理院 測量計算サイトAPI**（`bl2xy.pl`/`xy2bl.pl`、
   <https://vldb.gsi.go.jp/sokuchi/surveycalc/api_help.html>）を実際に呼び出し、
   国土地理院のサーバ自身が計算した平面直角座標19系のX/Y（小数点以下4桁=0.1mm）
   と、実装の計算結果を比較した。系の異なる4パターン（I・VII・IX・XIX系）、
   および原点から離れた地点（IX系原点から東へ約130km、系の運用範囲の端に近い）
   を含む。
2. **Karney (2011)の高精度検証用データセット`TMcoords.dat`**
   （Journal of Geodesy 85:475-485。配布元
   <https://sourceforge.net/projects/geographiclib/files/testdata/TMcoords.dat.gz>）。
   国土地理院APIの検証(1)は平面直角座標系の運用範囲（中央子午線から高々130km程度）
   しかカバーできないため、UTMの帯幅（片側約3度・300km超）に近い距離での
   式の妥当性を、GRS80とは別の楕円体（WGS84）・独立した文献のデータに対して
   別途確認した。

いずれもテストコード（`crates/pcv-core/src/crs/mod.rs`）のコメントに、出典URL・
取得日・再現手順（curlコマンドやファイルの取得範囲）を明記している。
**期待値を自分の実装から計算して作ることはしていない。**

往復テスト（順変換→逆変換）は別途用意したが、上記の出典付きテストとは
別物として扱っている（往復するだけでは実装が自己矛盾していないことしか
確認できず、正しさの検証にはならないため）。

### 子午線収差角の符号（実装中に見つかった資料間の違い）

河瀬(2011)の式(7)(15)をそのまま実装すると、国土地理院APIが返す`gridConv`と
符号が逆になった。X, Y, 縮尺係数mは国土地理院APIと完全に一致するため、
実装の誤りではなく「子午線収差角をどちら向きに正とするか」という定義上の
符号の違いだと判断し、UIでの表示がGSIの公開値と一致するようAPIの符号に
合わせて実装した（詳細・コードコメントは`crates/pcv-core/src/crs/transverse_mercator.rs`）。

### 範囲外にしたもの

ADR本文の「対応しないもの」節に加え、今回のコーディネーターの指示により
以下も範囲外にした:

- **系の異なる複数データの重ね合わせ表示**（ビューアが1ファイルしか開けないため）。
  ただし「系の間の変換」計算そのもの（緯度経度を経由）は実装・テスト済み
- **画面上の座標表示（情報パネルへの1行表示）**。`pcv-wasm`のバインディングや
  Tauriコマンド、React側の配線が必要になり、「変換計算の実装」という今回の
  依頼の範囲を超えるため、`pcv-core`内の計算とテストに絞った。UI配線は
  別タスクとして残る

## 追記（2026-09-25）: E57 / PLY / PCD → LAS の実装（M4-4）

[M4-import-and-conversion.md](./M4-import-and-conversion.md)のM4-4として、上記の決定どおり
E57/PLY/PCDの取り込みを`crates/pcv-convert/src/import/`に実装した。設計（LASを経由して
既存のLAS/LAZ→COPC経路に乗せる）はM4-4の仕様書に指示済みのため、ここではADRとして
残すべき決定（クレート選定・属性の対応・範囲外にしたもの）だけを記す。

### クレート選定

| 形式 | 採用 | 理由 |
|---|---|---|
| E57 | `e57` 0.11.13 | 表のとおり候補どおり採用。純Rust、`PointCloudReaderSimple`が姿勢適用・球面→直交変換・強度/色の正規化を既定でやってくれる。実際に組み込み、ビルド・テストとも成功した |
| PLY | **自前実装**（`ply-rs`は不採用） | ADR本文の候補`ply-rs` 0.1.3を実際に依存へ追加してビルドを試した。ビルド自体は通ったが、`ply-rs`の`build-dependencies`に`skeptic`（READMEのコード例をdoctestとしてビルド時に実行するcrate）があり、`cargo_metadata`・`pulldown-cmark`・`walkdir`・`semver`など多数の推移的依存を引き込むことを`cargo build`のログと`Cargo.lock`で確認した。`ply-rs`本体は2020年8月（5年以上前）を最後に更新が止まっている。PLYのヘッダはテキストで自己記述的であり、対応が必要な形式もASCII/binary_little_endian/binary_big_endianの3つだけなので、自前実装のほうが依存を増やさず読みやすいと判断した（`crates/pcv-convert/src/import/ply.rs`） |
| PCD | `pcd-rs` 0.13.0 | 表のとおり候補どおり採用。2026年3月時点でもメンテナンスされており、`DynReader`（実行時スキーマ）とbinary_compressed（LZF圧縮）への対応を標準で持つため、自前実装は不要と判断した |

いずれも実際に`crates/pcv-convert`へ組み込み、`cargo build -p pcv-convert`で
警告無くビルドできることと、`las`/`laz`のバージョン衝突が起きないこと
（`cargo tree`で`laz`が単一バージョンのみ現れること）を確認した。

### 属性の対応（座標・色・強度）

各形式のモジュール冒頭コメント（`e57.rs`・`ply.rs`・`pcd.rs`）に詳細を記録した。要点:

- **E57**: `intensityLimits`/`colorLimits`で申告される値域を`PointCloudReaderSimple`が
  既定で0.0..1.0へ正規化するため、こちら側は`* 65535`するだけでLASの16bit幅に写せる。
  値域の異なる複数スキャンが混在していても正しく扱える（`tests/import_e57.rs`で
  0-255の色と0-1000の強度という異なる値域を混ぜて確認済み）
- **PLY・PCD**: どちらも値域メタデータを持たない（PLY/PCDの仕様自体に無い）。
  色は8bit（uchar、PCLの実質的な標準）を`* 257`で過不足なく16bit幅に写し、
  それ以外の型は規約が無いため丸めてクランプするだけに留めた。強度も同様に
  規約が無いため正規化はせず、値をそのまま丸めてクランプする。この割り切りは
  「それらしい値」ではなく、対応表として明示的にコードコメントへ記録した

### スケール・オフセットの選び方

`crates/pcv-convert/src/import/scale.rs`の`choose_scale_offset`（純粋関数）。
候補`[0.0001, 0.001, 0.01, ...]`から、座標の範囲(min/max)が`i32`に収まる最も
細かいスケールを選ぶ。要求（mm以下の精度）に対して既定で0.1mm精度を狙い、
範囲が大きい入力でだけ段階的に粗くする。テストは境界値（`i32::MAX * 0.0001`
ちょうど）・量子化誤差の往復・退化データ（範囲0）・軸ごとに範囲の桁が違う
入力を確認する（`scale.rs`のテスト参照）。

### CRSの扱い

`to_las`の引数`crs_wkt: Option<Vec<u8>>`で、呼び出し側が分かっているCRSのWKT
バイト列を渡せる口を用意した。`Some`なら`las::Header::set_wkt_crs`でLAS
ヘッダーへ書き込み、`None`なら「不明」のまま（推測で補わない）。

**EPSGコードからWKT文字列を生成する処理は実装していない**（範囲外）。
`las`クレートのドキュメントは`crs-definitions`クレートの利用を示唆しているが、
対応が必要な系（JGD2000/JGD2011平面直角座標系、UTM）を実際にカバーしているかを
検証する時間が確保できず、かつ「WKT文字列を組み立てて渡す」呼び出し側の設計
（UIでの選択、`pcv-core`の`Crs`型との対応付け）自体が今回の依頼（E57/PLY/PCDの
取り込み）の範囲を超えると判断した。取り込み時にCRSを指定できる**口**を用意する、
という受け入れ条件は満たしているが、EPSGコード⇄WKTの変換は次の担当に残る。

### Androidに向けた設計（範囲外だが下準備した）

ADR-0006の追記（2026-09-24、変換をAndroidでも行う）を受け、E57/PLY/PCDの
読み込みも将来`content://`のURI（パスを持たないファイル記述子）から読む
必要が出うる。3クレートとも元々`Read`（E57は`Read + Seek`）ジェネリックな
読み込みAPIを持っていたため、`read(path: &Path)`を`read_from(reader: R)`の
薄いラッパーに分離した（`e57.rs`・`ply.rs`・`pcd.rs`）。

**公開APIとしては出していない**: `read_from`が返す`ImportedCloud`は
`pub(crate)`型であり、公開するには型も公開する設計判断が要る。それは
「Androidでこのファイル記述子をどう受け渡すか」を含む別の設計であり、
今回の依頼（E57/PLY/PCD→LASの変換の実装）の範囲を超えると判断した。
内部実装がパス専用でなくなったことで、Android対応時の変更範囲は
小さくなっているはずである。

### 範囲外にしたもの（今回のコーディネーター指示どおり）

- EPSGコード⇄WKT文字列の変換、CRS選択のUI（上記「CRSの扱い」参照）
- `read_from`の公開API化（上記「Androidに向けた設計」参照）
- PCDの`x`/`y`/`z`以外の座標系（動径・円柱座標等の非標準拡張）、
  PLYの法線・テクスチャ座標などの幾何以外の属性

## 追記（2026-10-03）: 中間LASを廃止し、直接COPCへ変換する（M4-9）

[M4-import-and-conversion.md](./M4-import-and-conversion.md)のM4-9として、上の
M4-4が選んだ「E57/PLY/PCD→LAS→(既存経路)→COPC」という2段階の設計をやめ、
「E57/PLY/PCD→COPC」の1段階にした。理由と変更点だけをここに記す
（実装の詳細はM4-9タスクシートと各モジュールのコメント参照）。

### なぜ変えたか

M4-4の設計には2つの問題があった。

1. 各形式の読み込みが全点を`Vec`(`ImportedCloud::points`)に貯めてからLASへ
   書いていた。メモリが点数に比例し、数千万点で数GBになる(Android・Webでは
   破綻する規模)
2. 中間LAS(非圧縮)を書いてから`copc-writer`に読み直させており、余計な
   ディスクI/Oと時間がかかっていた

### 1パスで書ける(当初の「2パス」案は不要だった)

M4-9タスクシートの当初の指示は「1回目で点数と範囲(bounds)だけを数え、
2回目で点を流す」という2パス方式だった。これは`copc_core::StreamingLayout`が
点を渡す前にbounds・スケール・オフセットを要求する、という前提に基づいていたが、
`vendor/copc-writer`のソース(`spill.rs`・`writer.rs`)を読むと誤りだと分かった。

- `StreamingLayout`はGPS時刻・色・NIR・波形・extra bytesの有無しか持たず、
  boundsもスケール・オフセットも含まない
- `SpillWriter::push`は点の生のf64座標を一時ファイルへ書きつつ、
  **boundsを副作用として自動的に積算する**(量子化は行わない)
- 公開関数`write_copc_from_spill_with_fs`は「スパイル済みの`SpillReader`
  (bounds確定済み)」と「スケール・オフセットを含む`CopcWriteMetadata`」を
  **別々の引数**として受け取る

つまり「全点をスパイルし終えてからboundsを読み、それを使ってスケール・
オフセットを選び、そのあとで初めて書き出しを呼ぶ」という順序がAPI上
そのまま可能であり、入力を2回読む必要が無い。これは目新しい設計ではなく、
Web版(`crates/pcv-wasm/src/convert.rs`の`WasmConverter`、M4-6b)が**既に
同じ部品**(`SpillWriter`→`finalize`→`write_copc_from_spill_with_fs`)を
LAS/LAZ→COPCに使っている。本タスクはこれを「入力にスケール・オフセットの
手がかりが無い形式」向けに、「finalizeしてから選ぶ」順序で組み合わせ直した
だけである(`crates/pcv-convert/src/import/convert.rs`の`run_import`)。

採用した経路（`convert.rs`のモジュールコメントも参照）:

1. 各形式の読み込みを`PointSource`トレイト(`point.rs`)に統一する。
   `has_color`・`declared_point_count`はヘッダー/メタデータだけで分かる値
   (全点を読まない)、`for_each_point(self, visit)`が1点読むたびに即座に
   `visit`へ渡す(E57の借用イテレータの制約上、`self`消費・コールバック
   渡しの設計にした。`point.rs`のドキュメント参照)
2. `run_import`が`SpillWriter::create`→(`for_each_point`内で)`push`を
   1回のループで回す(これが入力を読む唯一のパス)
3. `spill.finalize()`で得た`bounds`から`scale.rs`(M4-4からそのまま流用、
   mm以下の精度)でスケール・オフセットを選ぶ
4. `write_copc_from_spill_with_fs`を呼ぶ

### 各形式のストリーミング化

- **E57**: `e57`クレートの`PointCloudReaderSimple`は元々1点ずつ読む
  イテレータだったため、`Vec`に貯める代わりに読んだその場で`visit`へ
  渡すだけでよい(クレート側の読み方自体は変えていない)
- **PLY**: M4-4時点は`read_to_end`でファイル全体を`Vec<u8>`へ読んでから
  解析していた(メモリがファイルサイズに比例)。ヘッダーだけを
  `BufRead::read_line`で行単位に読み(高々数KB)、データ本体は`BufRead`から
  直接(ASCIIは行単位、binaryはプロパティの値ごとに固定長バイト列)読み
  進めてその場で`visit`へ渡す形に書き換えた
- **PCD**: `pcd_rs::DynReader`はASCII(`read_line`)・binary(`read_chunk`)の
  どちらも元から1レコード分だけを読み進める設計だった(ソースで確認済み)。
  M4-4時点の実装は、この既にストリーミングなイテレータの結果を`Vec`に
  貯め直していただけだったので、貯めるのをやめるだけでよかった

### 例外: PCDの`binary_compressed`

PCDの`binary_compressed`はファイル全体が1つのLZF圧縮ブロックであり、
`pcd-rs`は展開時に展開後サイズ丸ごとの`col_major`バッファ＋行優先へ転置した
もう1つの**全体コピー**(`row_major`)を作る(ソースで確認済み。列優先⇔
行優先の変換にバッファ全体のランダムアクセスが要るため、1レコードずつの
変換では済まない)。**この形式だけは展開後サイズの最大2倍のメモリを使う**。
フォーマットの仕様上、圧縮ブロックが1つなので部分展開ができず、
`pcv-convert`側のコードを直しても避けられない。

**対策**: ヘッダー直後の`uncompressed_size`フィールド(PCD`binary_compressed`
データ節の先頭8バイトは仕様上`compressed_size`・`uncompressed_size`という
2つのu32と決まっている)だけを自前で覗き見て、上限
(`MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES` = **512MiB**)を超えるなら
`pcd-rs`の重い展開を呼ぶ前にエラーで知らせる(`pcd.rs`)。

**512MiBの根拠**(実測ではなく、構造だけから見積もった判断値であることを
明記する): `pcd-rs`の展開は`col_major`+`row_major`の2バッファ(展開後
サイズの最大2倍)を同時に確保する。本アプリの変換先はデスクトップ・
Android(ADR-0006「変換を行う環境の範囲」、Androidは実機RAM 4GBを基準値と
して記録済み)。512MiBを上限にすると、ピークはおよそ1〜1.5GiB(2倍の
バッファ+圧縮データ自体+その後のspill等)に収まり、4GB機でもOS・アプリ
本体の分を残して動く見込みがある、という判断。`disk_space.rs`の11倍係数
(sofiの実測比から逆算)のような実測比ではない。

### CRSが不明でも`pcv-core`で開けること

M4-4と同じく、CRSは推測しない。`convert_to_copc`の`crs_wkt: Option<String>`
が`None`のときは、`CopcWriteMetadata::default()`のまま(`wkt_crs`無し)で
`write_copc_from_spill_with_fs`へ渡す。`copc-writer`の
`OutputLasMetadata::ensure_wkt_conformance`(M4-3で確認済みの既存の仕組み、
`metadata.rs`参照)が、CRS無しでも「空のWKT CRS VLR＋global encodingの
WKTビット」を補って書くため、点フォーマット7(RGB付き)のCOPCでも
`pcv-core`の「WKTビットを要求する」制約(M4-1・M4-3で記録済み)に違反しない。
`tests/import_pcd.rs`の`crs_wkt_is_written_when_provided_and_unknown_when_not`で、
CRS未指定の出力が`pcv_core::CopcFile::open`で開けることを確認した。

### アプリへのつなぎ込み(デスクトップ・Android)

`src-tauri/src/conversion.rs`の`decide_and_start`が
`pcv_convert::import::detect_format(path_for_naming)`でE57/PLY/PCDかどうかを
判定し、`run_conversion_thread`が`import_format: Option<SourceFormat>`に
応じて経路を分ける(`None`なら既存のLAS/LAZ経路`streaming::convert`、
`Some`なら`import::convert_to_copc`)。どちらも`ReadProgress`・
`copc_core::Error`で結果をやり取りする(`ImportError`から`copc_core::Error`
への変換を`pcv_convert`側に用意した)ため、進捗イベント・キャッシュ・
完了/失敗イベント・空き容量チェック・一時ディレクトリの誘導は**LAS/LAZと
完全に共通**で、M4-3の仕組みにそのまま乗る。`src/datasource/tauri.ts`の
`pickLocalFile`のファイル選択フィルタに`e57`/`ply`/`pcd`拡張子を追加した。

CRSのUI選択は作っていない(タスクシートの指示どおり)。`crs_wkt`は常に
`None`を渡す。

### Web版: wasm32でのビルド可否(調査のみ、配線は未実施)

[M4-6a](./M4-import-and-conversion.md#m4-6-web-での変換2026-09-30-着手まず調査)
と同じ要領で、`e57` 0.11.13・`pcd-rs` 0.13.0が`wasm32-unknown-unknown`で
ビルドできるかを、最小限の使い捨てクレート(`.scratch-wasm-probe/`。
調査専用で`main`には入れていない)で確かめた。

```
$ cargo build --target wasm32-unknown-unknown   # e57 + pcd-rsだけを依存に持つ最小クレート
Finished `dev` profile [unoptimized + debuginfo] target(s) in 6.47s
```

両方とも警告無くビルドできた。`cargo tree --target wasm32-unknown-unknown`で
依存グラフを見ると、`tempfile`・`memmap2`のようなOS依存のクレートは
一切現れない(`e57`は`roxmltree`、`pcd-rs`は`byteorder`・`itertools`・
`regex`・`thiserror`程度で、どちらも`std::fs`やスレッドに直接触れていない)。
PLYは本アプリの自前実装(`ply.rs`)で、依存するのは`byteorder`のみ
(wasm対応は`copc-writer`の調査で既に確認済みの軽量クレート)。

**つなぐかどうかの判断**: ビルドできる見込みは高いが、実際にWebへ配線するには
M4-6bと同等の作業(OPFSの`ScratchFs`実装の再利用はできるが、各形式の
読み込みをOPFS経由のバッチ駆動に合わせて`crates/pcv-wasm`側に**別途
実装し直す**必要がある。`pcv-convert`自体は`las`/`laz`に依存しネイティブ
専用のため、Web版は元々`pcv-wasm`が独立した実装を持つ設計になっている
M4-6bと同じ構図)、UIでのファイル選択・進捗・キャンセルの配線が要り、
本タスクの残り時間では実装しきれないと判断した。

**結論: 今回はWebへつながない。** Web版は引き続き、生LAS/LAZと同じく
「デスクトップ版でCOPCに変換してから開いてください」という案内を出す
(`src/datasource/copc-header.ts`の既存の仕組みは拡張子でなくLASヘッダーを
見て判定するため、E57/PLY/PCDはそもそも対象外。Web版のローカルファイル
選択(`<input type="file">`)の`accept`は引き続き`.las,.laz`のみで、
E57/PLY/PCDはOSのファイル選択ダイアログにすら出てこない)。wasm32で
ビルドできる見込みが高いことは確認済みなので、Webへのつなぎ込みは
今後の課題として切り出せる状態にある。
