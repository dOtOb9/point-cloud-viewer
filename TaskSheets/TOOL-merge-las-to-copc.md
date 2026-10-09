# TOOL: 隣接LASタイルを1つのCOPCにマージするdevツール

- 状態: 実装済み・実データで確認済み
- 日付: 2026-10-09
- 担当: Claude(エージェント)

## 目的

ビューア本体は1ファイルしか開けない。一方、国・自治体が配布する航空LiDARは
隣接する矩形タイル(図郭)ごとに別々のLAS/LAZファイルで配布されることが多く、
「ある範囲をまとめて見る」には事前に1ファイルへまとめる必要がある。

本ツールは、隣接する多数のLAS/LAZタイルを1つのCOPCファイルへマージする
**開発者向けのCLI**(`crates/pcv-convert`の`example`)である。**アプリのUI・
Tauriコマンドからは呼ばない。** 所有者が手元で実行し、できあがった1つの
`.copc.laz`をビューアで開く、という使い方を想定する。

## データソースとライセンス

- 東京都デジタルツイン実現プロジェクト「区部点群データ」
  (<https://www.geospatial.jp/ckan/dataset/tokyopc-23ku-2024>)、
  **CC BY 4.0**
- タイルのダウンロードURLパターン:
  `https://gic-tokyo.s3.ap-northeast-1.amazonaws.com/2024/dig/lp/<図郭名>.zip`
  (図郭名の例: `09LD2626`)
- 本検証では渋谷区周辺の隣接55タイルを使った(`data/tokyo-shibuya/tiles.txt`に
  ダウンロード元URL一覧がある。タイルのzip/las自体はgitignore対象で
  コミットしていない、`CLAUDE.md`の「守ること」どおり)
- 各タイルの仕様(所有者から申告): LAS 1.2、PDRF3(16bit RGB付き)、
  1タイルあたり約6.2M点・約210MB、座標系はJGD2011平面直角座標系IX系
  (EPSG:6677)、scale=0.001・offset=0、タイルは400m×300mで隣接タイルと
  辺を共有する

## 設計と、採らなかった案

### 採った案: 複数ファイルを1本のイテレータにまとめ、既存のstreaming writerへそのまま渡す

`crates/pcv-convert/src/streaming.rs`(本番の単一ファイル変換経路)を読んで
確認したとおり、実際にCOPCを組み立てているのは`vendor/copc-writer`の
低水準API `write_streaming_with_cancel_and_timings`で、これは
`Iterator<Item = copc_core::Result<LasPointRecord>>`を受け取るだけで
octree分割・LAZ圧縮・COPC hierarchyの組み立てを全部行う。

`vendor/copc-writer/src/spill.rs`の`SpillWriter::push`を読むと、
バウンディングボックスも点数も、プッシュされた点から**その場で**
蓄積されることが分かる(`SpillWriter::bounds`・`SpillWriter::count`)。
つまり、複数ファイルをまとめることは「複数ファイルを順に読んで1本の
`Iterator<Item = LasPointRecord>`にする」だけで実現でき、**事前に全点を
読んで合計点数・バウンディングボックスを計算する2回目のフルパスは不要**。
新しいoctree・writerのコードは一切書いていない。

実装したのは`crates/pcv-convert/src/merge.rs`の`MultiFileLasPoints`
(複数ファイルを順に開いて1本のイテレータにするだけの反復子)と、
入力の列挙・ヘッダー確認(`collect_input_paths`・`summarize_headers`)のみ。
CLIラッパーは`crates/pcv-convert/examples/merge_las_to_copc.rs`。

### ヘッダーだけの事前確認(2回目のフルパスではない)

`summarize_headers`は全入力ファイルの**ヘッダーだけ**(`las::Reader::from_path`
はヘッダー+VLRしか読まず、点データは`fill_points`を呼ぶまで読まれない)を
読み、2つのことだけ確認する:

1. 全ファイルが同じ`StreamingLayout`(point format・色/GPS/NIR/waveformの
   有無・extra bytesの構成)であること。LAZの1チャンク=COPCの1ノードという
   対応上、`copc-writer`は1回の書き出しで1つのレイアウトしか扱えない
   (`SpillWriter::create`が`layout`を1つだけ受け取る)ため、違うレイアウトの
   ファイルが混じっていたら`MergeError::LayoutMismatch`で止める
2. 進捗表示の分母(申告点数の合計)。書き出しの入力には使わない

出力のCRS・scale/offsetは先頭ファイルのヘッダーから組み立てる
(既存の`write_metadata::copc_write_metadata_from_source_header`を
そのまま再利用。後述)。

### scale/offsetは入力ファイル間で一致していなくてよい(確認済み)

`LasPointRecord::from_las_point`が運ぶ`x`/`y`/`z`は、`las`クレートが
**元ファイルのscale/offsetを適用した実世界座標(f64)**である
(`copc-core`のソースで確認)。出力のscale/offsetが元と違っても、
`vendor/copc-writer/src/writer.rs`の`quantize_xyz`が書き出し時に
量子化し直すだけなので、座標の正しさには影響しない。そのため、
「全入力が同じscale/offsetであること」はこのツールの前提にしていない
(point formatの一致だけを必須にしている)。実データ(東京都のタイル)は
全タイル同じscale=0.001・offset=0だったため、この一般化が効くかどうかの
実地確認はできていない(**未検証**。レイアウトさえ揃っていれば異なる
scale/offsetでも動くことは、コードを読んで確認した設計上の見込み)。

### 採らなかった案1: 新しいoctree/writerを書く

`crates/pcv-convert/src/octree.rs`・`writer.rs`(M4-1の素朴な実装)は
全点をメモリに載せる方式で、数億点では使えないとADR-0006で既に判断済み
(「メモリが点数に比例しないこと」という不変条件に反する)。複数ファイルの
マージのために新しい out-of-core octree 実装を書くのは、既に動いている
`copc-writer`の実装を素通りすることになり、CLAUDE.mdの「凝った抽象化より
退屈で読めるコードを選ぶ」にも反する。既存の経路を複数ファイル分
繰り返し呼ぶだけで済むなら、それを選ぶ。

### 採らなかった案2: 一時的に1本のLASへ結合してから既存の`convert_las_to_copc_streaming`を呼ぶ

「55個のLASをまず1個の巨大なLASへ単純結合し、それを単一ファイル変換の
入口(`convert_path_and_timings`)にそのまま渡す」案も検討した。実装は
単純だが、結合後の一時LASファイル(12GB)をディスクに書く分だけI/Oが
増え、出力とは別にもう1つ巨大な一時ファイルを抱えることになる
(`CLAUDE.md`の「メモリが点数に比例しないこと」の精神は満たすが、
ディスクの持ち方として無駄が大きい)。`write_streaming_with_cancel_and_timings`
が`Iterator`を受け取れる以上、ファイルをまたいでイテレータを繋ぐだけで
同じ結果になるため、この案は採らなかった。

### `streaming.rs`の`BatchedLasPoints`を再利用しなかった理由

単一ファイル変換(`streaming.rs`)には、バッチ読み出し+進捗コールバックを
行う`BatchedLasPoints<F: FnMut(ReadProgress)>`が既にある。複数ファイルを
chainするには、この型をそのまま複数個繋げる(`Iterator::chain`)ことも
考えたが、ファイルごとに別のクロージャを使うと型パラメータ`F`が揃わず
`chain`できない(`Box<dyn Iterator<...>>`で包むか、クロージャの型を
`Box<dyn FnMut(ReadProgress)>`に統一する必要がある)。素朴な代替として、
`merge.rs`に`MultiFileLasPoints`という別の小さな型を書いた
(中身はバッチ読み出しのループのみで`BatchedLasPoints`とほぼ同じ)。
型を1つに揃える抽象化を追加するよりも、この程度の重複は読みやすさを
優先して許容した。

## メモリが点数・ファイル数に比例しないことの確認

`MultiFileLasPoints`は**常に高々1ファイル分のリーダー+1バッチ
(最大1Mi点、`READ_BATCH_SIZE`)だけ**をメモリに持つ。前のファイルを
読み終えたら、その`CurrentFile`(リーダー・バッチ)を`None`に入れ替えて
捨てる(`crates/pcv-convert/src/merge.rs`の`Iterator`実装参照)。
ファイル数(55個)にも総点数(3.4億点)にも比例しない。

書き出し側(`copc-writer`のSpillWriter以降)の out-of-core 性は
ADR-0006・`crates/pcv-convert/src/streaming.rs`で既に確認済みの経路を
そのまま使っているため、このツール独自に再検証はしていない(既存の
不変条件を壊していないことの確認は、下記「全55タイルの実測」の
ピークプライベートメモリで行った)。

## 触ったファイル

- `crates/pcv-convert/src/merge.rs`(新規): マージ本体
  (`collect_input_paths`・`summarize_headers`・`MultiFileLasPoints`)。
  ユニットテスト5本を含む
- `crates/pcv-convert/src/lib.rs`: `pub mod merge;`を追加
- `crates/pcv-convert/Cargo.toml`: `glob`クレートを依存に追加
  (ワークスペースの依存グラフに既に同バージョンが入っていたため、
  新規クレートの追加にはなっていない。`Cargo.lock`差分で確認した)
- `crates/pcv-convert/examples/merge_las_to_copc.rs`(新規): CLI本体
- `crates/pcv-convert/examples/verify_merge.rs`(新規): マージ結果の検証CLI
  (複数入力に対応した`examples/verify.rs`相当。下記「どう確かめたか」参照)
- `TaskSheets/TOOL-merge-las-to-copc.md`(本ファイル)

**アプリ本体(`src/`・`src-tauri/`)は一切触っていない**(タスクの指示どおり、
UIは変更しない)。

## 所有者が再現する手順

```powershell
# リリースビルド
cargo build -p pcv-convert --release --example merge_las_to_copc --example verify_merge

# マージ(入力はディレクトリ指定。配下の*.las/*.lazをファイル名の昇順で集める)
.\target\release\examples\merge_las_to_copc.exe `
    C:\rust\point-cloud-viewer\data\tokyo-shibuya `
    C:\rust\point-cloud-viewer\data\tokyo-shibuya-merged.copc.laz

# globパターンでも指定できる(例: 一部タイルだけマージする)
.\target\release\examples\merge_las_to_copc.exe `
    "C:\rust\point-cloud-viewer\data\tokyo-shibuya\09LD262[6-8].las" `
    C:\rust\point-cloud-viewer\data\tokyo-shibuya-test3.copc.laz

# 検証(全入力の合計点数・和集合バウンディングボックス・サンプル点のRGB非ゼロを確認)
# `verify_merge`自身はglobを展開しない(`merge_las_to_copc`と違い、1引数=1ファイル
# として扱う)ため、PowerShell側で展開してから渡す。
.\target\release\examples\verify_merge.exe `
    C:\rust\point-cloud-viewer\data\tokyo-shibuya-merged.copc.laz `
    (Get-ChildItem C:\rust\point-cloud-viewer\data\tokyo-shibuya\*.las).FullName
```

CLI引数: `<入力ディレクトリ or glob> <出力.copc.laz> [ノードあたり最大点数=100000]
[spill_dir=OS既定の一時ディレクトリ] [--sequential-compress]`。
`--sequential-compress`は既存の並列オプション
(`CopcWriterParams::parallel_node_compression`、`parallel-compress`
フィーチャの既定はtrue)を明示的に無効化する(計測・デバッグ用)。

ユニットテストだけなら:

```powershell
cargo test -p pcv-convert
```

## 受け入れ条件と実測

### 1. `cargo test -p pcv-convert`

実行結果(抜粋。全文は作業ログ参照):

```
running 49 tests
...
test merge::tests::collect_input_paths_errors_when_nothing_matches ... ok
test merge::tests::collect_input_paths_sorts_and_filters_by_extension ... ok
test merge::tests::multi_file_points_iterator_yields_points_from_every_input_in_order ... ok
test merge::tests::merging_rejects_mismatched_layouts ... ok
test merge::tests::merging_three_small_files_yields_correct_count_bounds_and_points ... ok
...
test result: ok. 49 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

(lib以外のtests/配下も含め、全スイート通過。streaming_conversion.rsの7件を含む)
```

`merging_three_small_files_yields_correct_count_bounds_and_points`が本タスクの
ユニットテスト要件(「2〜3個の小さな合成LASをマージして、COPCヘッダーの
総点数・バウンディングボックスが正しく、全入力の点が存在すること」)に
対応する。3つの合成LAS(各1点、バウンディングボックスの角になる座標)を
マージし、`pcv_core::CopcFile`で開いて`info().point_count`・
`info().min/max`・hierarchy点数合計・`read_node`の実点数を確認している。

### 2. 3タイルの実データマージ

隣接する実タイル`09LD2626`・`09LD2627`・`09LD2628`(いずれも400m×300m、
東西に隣接)をマージし、`examples/verify_merge.rs`で検証した:

```
入力 09LD2626.las: 5766330 点, bounds=(-13600.000,-36900.000,16.019)-(-13200.001,-36600.001,68.982)
入力 09LD2627.las: 6697369 点, bounds=(-13200.000,-36900.000,14.751)-(-12800.001,-36600.001,94.766)
入力 09LD2628.las: 9328297 点, bounds=(-12800.000,-36900.000,20.129)-(-12400.001,-36600.001,60.557)
入力の合計      : 21791996 点
入力の和集合bounds: (-13600.000,-36900.000,14.751)-(-12400.001,-36600.001,94.766)
出力CloudInfo   : 21791996 点, bounds=(-13600.000,-36900.000,14.751)-(-12400.001,-36600.001,94.766), 色あり=true
色のサンプル    : 11762 点確認、非ゼロRGBあり=true
OK: 全3入力の合計点数・和集合バウンディングボックスと一致し、色のあるノードを確認できた
```

総点数(21,791,996)・バウンディングボックス(和集合と完全一致)・RGB非ゼロ、
いずれも確認できた。CRSも先頭ファイルのGeoTIFFキーからWKTへ正しく解決された
(下記「CRSの確認」参照)。マージ自体は14〜31秒(他プロセスと同時実行していた
ときは遅い。後述の全タイル実行とは別の計測で、内部計測のみ)。

### 3. 全55タイルの実測

`data/tokyo-shibuya/`配下の55個の`.las`すべてを1つのCOPCへマージした
(開発機: Core i5-14600K、Windows 11。入力は55ファイル合計約12GB)。

```powershell
.\target\release\examples\merge_las_to_copc.exe `
    C:\rust\point-cloud-viewer\data\tokyo-shibuya `
    C:\rust\point-cloud-viewer\data\tokyo-shibuya-merged.copc.laz
```

ピークプライベートメモリの測り方は、`TaskSheets/ADR-0006-conversion-strategy.md`・
`TaskSheets/M4-import-and-conversion.md`(M4-1b・M4-10)と同じ方法:
`System.Diagnostics.Process.PrivateMemorySize64`を500msごとにポーリングして
最大値を取る(ワーキングセットではない理由も同じ: `copc-writer`の一時ファイルは
`memmap2`でメモリマップされるため、ワーキングセットはメモリ不足の指標に
ならない)。`Start-Process`で子プロセスとして起動し、終了まで監視した。

内部計測(ツール自身の出力):

```
入力ファイル数  : 55
ヘッダー確認    : 申告点数の合計=347797138, レイアウト: point_format=3 色あり=true
マージ完了      : 401.03 秒
出力サイズ      : 4621.35 MB
```

PowerShellでの外部測定:

```
ElapsedSeconds        : 401.59
PeakPrivateMemoryBytes: 337,567,744
PeakPrivateMemoryGiB  : 0.314
```

**出力の検証**(`examples/verify_merge.rs`、全55入力に対して実行):

```
入力の合計      : 347797138 点
入力の和集合bounds: (-13600.000,-39000.000,-4.106)-(-10400.001,-36600.001,246.096)
出力CloudInfo   : 347797138 点, bounds=(-13600.000,-39000.000,-4.106)-(-10400.001,-36600.001,246.096), 色あり=true
色のサンプル    : 33351 点確認、非ゼロRGBあり=true
OK: 全55入力の合計点数・和集合バウンディングボックスと一致し、色のあるノードを確認できた
```

**点数(347,797,138)・バウンディングボックスとも、55入力の単純な合計・和集合と
1点の誤差もなく一致した。** 3.48億点を変換してもピークプライベートメモリは
**0.314GiB**にとどまり(`TaskSheets/ADR-0006`のsofi.copc.laz、3.64億点で
0.053〜0.227GiB、という既存の実測値と同じ桁)、メモリが点数・ファイル数に
比例しないという設計どおりの結果になった。

出力サイズ4621.35MB(≈4.51GiB)は、入力合計約12GBに対して約38%
(LAZ圧縮によるサイズ縮小。元データがLAS=無圧縮だったことを踏まえると妥当)。

**CRSの確認**: 出力ファイルの先頭付近(WKT CRSのVLR)に、期待どおり
`JGD2011 / Japan Plane Rectangular CS IX`・`AUTHORITY["EPSG","6677"]`が
書き込まれていることを、ファイルを直接grepして確認した(`crs_override.rs`が
先頭タイルのGeoTIFFキーから正しく解決・出力している)。`pcv-core`の
`crs::detect_crs_from_las_header`がこの形式のWKTをEPSG:6677 → zone IX /
JGD2011として検出できることは、`crates/pcv-convert/src/crs_override.rs`の
既存テスト`jgd2011_ix_geotiff_only_generates_wkt_that_round_trips`で
既に確認済み(今回のマージで新たに検証したのは「実データのタイルが実際に
この経路を通ってWKTを得られること」で、往復検出ロジック自体は既存テストの
守備範囲)。

### 4. ビューアで開けるか

Web版(ヘッドレスChromium、`channel: "chromium"`。既存のE2E
`e2e/web-conversion.spec.ts`・`playwright.config.ts`と同じ方式でWebGPUが
使える構成)で、`npm run dev`のローカルサーバーに対し、マージ済みCOPCを
ファイル選択で直接開いた(拡張子+ヘッダーから「既にCOPC」と判定され、
変換はスキップされる経路。`src/datasource/source-format.ts`参照)。

3タイル版(2179万点)では以下のとおり開け、スクリーンショットで点群が
色付きで表示されることを確認した(屋根瓦・地面のテクスチャが見える):

```
[M1] opened tokyo-shibuya-test3.copc.laz: points=21791996 nodes=380
```

ページエラー・console.errorなし。

**55タイル全部(3.48億点、4.62GB)をマージしたファイルでも同じ手順で確認した。**

```
[M1] opened tokyo-shibuya-merged.copc.laz: points=347797138 nodes=6475
```

ページエラー・console.errorなし。スクリーンショットで、55タイル分の範囲
(5列×11行のタイル配置に対応する短冊状の領域、建物・地面のテクスチャ)が
色付きで表示されることを確認した(点予算26,843,545に制限されているため、
スクリーンショット撮影時点では一部ノードが読み込み中だったが、既に読み
込まれた範囲は正しく色付きで描画されていた)。

**デスクトップ版(Tauri)は未確認。** このセッションにはOSのウィンドウを
操作する手段(computer-use等)が無く、Tauriアプリを起動して実際の画面を
スクリーンショットすることができなかった。所有者が確認する手順:

```powershell
npm run tauri dev
```

アプリが起動したら、ファイルを開くダイアログで
`C:\rust\point-cloud-viewer\data\tokyo-shibuya-merged.copc.laz`を選び、
点群が表示され色が付いていることを目視で確認する。

## 未検証・残課題

- **デスクトップ(Tauri)版での確認は未確認。** 上記のとおりWeb版でのみ確認した。
- **Android版は確認していない**(タスクの対象外と判断した。このツール自体が
  開発者のPC上で動くCLIであり、Android実機への配布物には影響しない)。
- **異なるscale/offsetを持つ入力の混在は未検証。** 設計上動く見込みだが
  (上記「設計」参照)、実データが全タイル同じscale/offsetだったため
  実地確認はできていない。
- **異なるCRSを持つ入力の混在は未対応・未検証。** 出力CRSは先頭ファイルの
  ヘッダーから1つだけ決まる。入力ごとにCRSが違う場合、後続ファイルの
  CRSは無視される(警告も出さない)。今回のタスク(同一エリアの隣接タイル)
  では問題にならないが、汎用ツールとしては弱点。
- **メモリの実測は全55タイルの1回のみ。** 複数回実行して分散を見る、
  といった追加の実測はしていない。
- `--sequential-compress`フラグ自体の効果(逐次圧縮での所要時間比較)は
  計測していない(フラグの配線自体は`post_process_stage_bench.rs`と同じ
  既存APIを呼ぶだけなので、動作しない理由は無いと判断したが、実測はしていない)。
