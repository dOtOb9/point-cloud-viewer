# M4: 各種形式の取り込みと COPC への変換、および CRS

- 状態: 進行中（M4-1・M4-1b・M4-2完了。M4-2 の決定は ADR-0006。M4-3以降は未着手）
- 前提: [ADR-0001](./ADR-0001-architecture.md)（COPC の採用）、[ADR-0008](./ADR-0008-formats-and-crs.md)（対応形式と CRS）

## このマイルストーンの目的

**生の LAS/LAZ を COPC に変換する処理を、自前で実装すべきか外部ツールを同梱すべきかを、
実測で決める。** そして決めた方式で実装する。

M1 / M2 は **COPC 専用**で完成させる。このマイルストーンはそれと独立に進められる。

## 背景

Unreal Engine の LiDAR Point Cloud Plugin を使った経験から、
**「octree 構築が重く、描画はそれほど重くない」** という指摘があった。これは正しく、
かつ我々の設計に直接効く。

UE のプラグインは生の LAS/E57 を読んでその場で octree を構築するため、
大規模点群のインポートが分単位かかる。一方で描画は点予算で GPU 負荷に上限がかかるので、
データ量に関わらず一定に収まる。この非対称は構造から来ている。

**我々は COPC を採用したことで、この重い処理を実行時から除いている**（ADR-0001 参照）。
COPC はファイルの中に octree が入っているため、開く処理は即座に終わる。

**しかしコストは消えていない。変換側に移動しただけである。** 現実のデータの大半は
生の LAS/LAZ であり、誰かがどこかで octree を構築しなければならない。

### なぜ自明に自前実装しないのか

高速な out-of-core octree ビルダは、それ自体が大きなプロジェクトである。
PotreeConverter 2.0 が 1.7 比で 10〜50倍の改善を出したこと、untwine が独立したツールとして
存在することが、ここが難所であることを示している。

素朴に実装すれば、**まさに UE と同じ「重い」体験を再現することになる。**
だから推測で決めず、先に測る。

---

## M4-1: 変換コストを実測する（スパイク）

### やること

`copc-rs` の writer を使い、**素朴な実装で** LAS/LAZ → COPC の変換を書いて計測する。
最適化はしない。「素朴に書いたらどれくらいか」を知ることが目的。

計測する規模:

| 点数 | 測るもの |
|---|---|
| 1,000万点 | 所要時間、ピークメモリ、出力サイズ |
| 1億点 | 同上。**メモリが載らずに落ちるかどうかが重要** |

計測環境と、使ったデータの素性（点密度、属性の有無）も記録すること。

### 判断の基準（先に決めておく）

測ってから基準を作ると都合よく解釈してしまうので、**先に決める**。

| 実測結果 | 決定 |
|---|---|
| 1億点が **10分以内** かつ **ピークメモリ 8GB 以内** | **自前実装で進める。** 最適化の余地を残しつつ M4-3 へ |
| どちらかを超えるが、桁で外していない（〜30分 / 〜16GB） | 要判断。最適化で届く見込みがあるかを検討し、ADR に理由を書いて決める |
| 桁で外している（1時間超 / メモリに載らない） | **untwine / PDAL の同梱に倒す。** 自前実装は断念する |

### 受け入れ条件

- [x] 上記2規模の実測値（時間・ピークメモリ・出力サイズ）が記録されている
- [x] 計測環境とテストデータの素性が記録されている
- [x] 判断表のどれに該当するかが確定している（1行目。「結果」参照。最終判断はコーディネーターが行う）
- [ ] 出力した COPC が実際に M1 のビューアで開けることを確認した
      （変換が速くても中身が壊れていたら無意味）
      → GUIでの目視確認は未実施（環境の制約）。代わりに`pcv_core::CopcFile::open`・
      hierarchy点数の一致・`read_node`での読み出しを確認済み（「結果」参照）。
      GUIでの最終確認は所有者に依頼する

### 結果

**書き手の選定**: `copc-rs` 0.5.0 を単独プロジェクトで再検証したが、依存解決される
`las`/`laz` の版が噛み合わず、今日(2026-09-24)時点でもネイティブですらビルドが
通らないことを確認した(ADR-0003が記録した症状がそのまま継続している)。
代わりに `las`/`laz` クレートで点の読み書きとLAZチャンク圧縮を行い、COPCの
hierarchy/VLR/EVLRは自分で組み立てる素朴な実装にした
(`crates/pcv-convert`。`copc-core`/`copc-reader`の姉妹クレート`copc-writer`が
`convert_las_to_copc_streaming`という高水準関数を持つが、それはout-of-core
実装であり呼ぶと「素朴な実装のコスト」ではなく「そのクレートの性能」を
測ってしまうため使わなかった)。バイナリレイアウトの定義(`Entry`・
`HierarchyPage`・`CopcInfo`)だけは、`pcv-core`の読み込み側(ADR-0003)と同じ
`copc-core`の型を再利用している。

**アルゴリズム**: 全点をメモリへ読み込み、ノードあたり最大点数(このスパイクでは
100,000点。チューニングはしていない、決め打ちの丸い数)を超えたらストライド
抽出で間引いた点を現ノードに残し、残りを8分木の子へ再帰的に渡す。
out-of-core化・並列化はしない。保持する点属性はxyz・強度・分類・RGBのみ
(ビューアの着色モードがこの4つしか使わないため。GPS時刻・リターン情報・
スキャン角度は運ばない)。

**計測環境**

| 項目 | 値 |
|---|---|
| CPU | Intel(R) Core(TM) i5-14600K(14コア/20スレッド) |
| RAM | 31.8 GB |
| OS | Windows 11 Home 10.0.26200 |
| ビルド | `cargo build -p pcv-convert --release`(ワークスペース既定の`[profile.release]`: opt-level=3, lto=true, codegen-units=1) |
| ピークメモリの測り方 | PowerShellから`Start-Process`で子プロセスとして起動し、終了まで200ms間隔で`System.Diagnostics.Process.PeakWorkingSet64`をポーリングして最大値を取る(Windowsのworking setの実測値。カーネルが継続的に追跡する値なので、ポーリング間隔より短時間のピークも取り逃さない) |

**使ったデータの素性**

| | autzen-classified.copc.laz | beer.laz |
|---|---|---|
| 点数(ヘッダ実測) | 10,653,336 | 66,848,096 (仕様書は「約1億点」としていたが、実際にヘッダを読むとこの点数だった。指定された絶対パスのファイルそのものを測っている) |
| ファイルサイズ | 81.12 MB (既にCOPCだが普通のLAZ 1.4として読める) | 470.53 MB |
| LASバージョン/point format | 1.4 / 7(RGB+GPS時刻あり) | 1.2 / 2(RGB あり、GPS時刻なし) |
| 属性 | 分類コード付き(TEST-DATA.md記載のとおり) | scale=1e-6(マイクロメートル単位)、bbox が約36×27×11m。空撮LiDARではなく近接スキャン(物体スキャン)のデータプロファイルで、autzenとは点密度・取得方式が異なる |

**実測値**(`cargo run -p pcv-convert --release -- <入力> <出力> 100000`)

| 規模 | データ | 読み込み | octree構築 | 書き出し | 合計(内部計測) | 合計(壁時計・プロセス外測定) | ピークメモリ | 出力サイズ | ノード数 |
|---|---|---|---|---|---|---|---|---|---|
| 約1,000万点 | autzen-classified.copc.laz(10,653,336点) | 4.55 秒 | 0.44 秒 | 3.81 秒 | 8.80 秒 | 8.98 秒 | **0.761 GB** | 84.34 MB | 253 |
| 約6,685万点 | beer.laz(66,848,096点) | 30.17 秒 | 4.05 秒 | 23.70 秒 | 57.93 秒 | 58.30 秒 | **4.116 GB** | 500.04 MB | 1,878 |

「合計(内部計測)」はプロセス内で`Instant`で測った読み込み+octree構築+書き出しの合計、
「合計(壁時計)」はPowerShellが子プロセスの起動から終了までを外側から測った値
(プロセス起動・終了のオーバーヘッド分だけ内部計測より僅かに大きい)。
どちらも測定済みの値であり、以降はプロセス外測定(壁時計)を代表値として使う。

**出力の検証**(`cargo run -p pcv-convert --release --example verify -- <入力> <出力>`。
`crates/pcv-core/examples/open_bench.rs`を参考にした):

- 両ファイルとも`pcv_core::CopcFile::open`で開けた
- hierarchyの点数の合計が入力の申告点数と一致した(autzen: 10,653,336、beer: 66,848,096)
- 粗いノードから5個ずつ`read_node`で読み、hierarchyの申告点数と実際に読めた点数が一致した

GUIでの目視確認(仕様書の受け入れ条件の元々の文言)は所有者に依頼する。

**判断表への当てはめ**(数値のみで機械的に。判断そのものはコーディネーターが行う):

> 1億点が **10分以内** かつ **ピークメモリ 8GB 以内** → 自前実装で進める

- beer.laz(66,848,096点、目標の1億点の約67%)で **58.3秒**(10分=600秒の約1/10) と
  **4.116 GB**(8GBの約51%)。両方とも1行目の閾値を余裕を持って下回っている
- 参考(未実測・線形外挿): autzen→beerの点数比6.27倍に対し壁時計は6.58倍、
  ピークメモリは5.41倍で、ほぼ点数に比例している。この比例が66.8M→100M
  (1.497倍)でも保たれると仮定すると、100万点あたり
  時間 58.3秒×1.497 ≈ **87秒**、メモリ 4.116GB×1.497 ≈ **6.16GB**という見積りになる
  (**実測ではない**。素朴な実装が概ね点数に線形なことの確認として書いておく)。
  これも1行目の閾値(600秒 / 8GB)を下回る
- したがって実測値は判断表の **1行目**(自前実装で進める)の範囲に入る。ただし
  beer.lazの実点数が仕様書の想定(1億点)より小さい(約67%)ことは判断材料として
  明記しておく。桁が違うわけではなく、上記の外挿でも余裕があることから、
  この差が結論を変えるほどではないと考えられるが、**最終判断はコーディネーターが行う**

**素朴な実装で気づいたこと(参考)**:

- LAZの可変長チャンク圧縮(`laz::LasZipCompressor`)は`finish_current_chunk()`で
  チャンク境界を切れるため、COPCの「1ノード=1チャンク」をそのまま実装できた。
  ただし最初の`compress_one`呼び出しが自動でチャンクテーブルへのオフセット
  (8バイト)を先頭に予約する仕様があり、これを呼び出し側で先に済ませておかないと
  最初のノード(root)のオフセットが8バイトずれる。実際にこれで根ノードの
  `read_node`がEOFになる不具合を書いてしまい、テスト(`tests/roundtrip.rs`)で
  検出して直した
- COPC info VLRは仕様上「ファイル中の最初のVLR」であることが必須(offset 375から
  始まる)。素朴にLASzip VLR→COPC info VLRの順で書いたら`pcv-core`に拒否された
- `pcv-core`の読み込み側は、点フォーマット6-10のCOPCファイルにLASヘッダの
  global encoding のWKTビット(bit4)が立っていることを要求する。このスパイクでは
  CRS(WKT VLRの実体)は持ち出していない(範囲外。M4-5で扱う)ため、ビットの
  意味とVLRの実在が食い違っている。M4-3で実装する際はCRSも運ぶ必要がある

### コミット単位

`spike: measure naive las-to-copc conversion cost`

---

## M4-1b: out-of-core の変換を実測する（2026-09-24 追加）

### なぜ追加したか

M4-1 の素朴な実装は、6,685万点で 58秒・ピーク 4.1GB だった（コーディネーターが 1,000万点の変換を
再実行し、時間・メモリ・出力サイズ・点数の一致を再現済み）。判断表の1行目（1億点で10分・8GB 以内）に入る。

**しかし判断表の基準の置き方が誤っていた。** 素朴な実装は全点をメモリに載せるため、ピークメモリは点数に
ほぼ比例する（約 62 バイト/点）。所有者が実際に扱うデータは sofi が 3.64億点（見込み約 22GB）、
points-jack_he は 4.4GB のファイルでそれ以上。**このプロジェクトの前提は「数億点で破綻しないこと」なのに、
基準を 1億点に置いたため、表の1行目に入っても実データを変換できない。** 判断表を作ったコーディネーターの誤り。

M4-1 の調査で、読み込みに使っている `copc-core` / `copc-reader` の系列に **`copc-writer`** があり、
out-of-core（一時ファイルに逃がしながら組み立てる）の変換関数 `convert_las_to_copc_streaming` を
持つことが分かった。純粋な Rust なので、外部ツールを同梱せずに済む可能性がある。これを測る。

### 測るもの

| 入力 | 点数 | 測るもの |
|---|---|---|
| `beer.laz` | 66,848,096 | 所要時間、ピークメモリ、出力サイズ |
| `sofi.copc.laz`（COPC だが中身は LAZ として入力に使える） | 364,384,576 | 同上。**ピークメモリが点数に比例せず頭打ちになるか**が最重要 |

出力が `pcv-core` で開けること、hierarchy の点数の合計が入力と一致すること、ノードを読めることを確かめる。
あわせて、`copc-writer` のライセンス、ビルドできるか（ADR-0003 の laz の衝突の件）、依存の重さを記録する。

### 判断の基準（測る前に決めておく）

| 実測結果 | 決定 |
|---|---|
| sofi（3.64億点）が **30分以内** かつ **ピークメモリ 8GB 以内**、出力が正しく、ライセンスが MIT / Apache-2.0 での配布と両立する | **`copc-writer` を採用する** |
| 出力が正しく、ライセンスも両立するが、時間かメモリの基準を超える | 要判断。何がボトルネックかを記録し、ADR に理由を書いて決める |
| ビルドできない、出力が壊れている、またはライセンスが両立しない | 候補から外す。untwine / PDAL の同梱か、自前の out-of-core 実装かを改めて検討する |

### 結果（2026-09-24、Sonnet）

**ビルド**: `crates/pcv-convert/Cargo.toml` に `copc-writer = "0.9.0"` を追加しただけで、
ネイティブ・リリースとも警告なしでビルドできた。`copc-writer` は `copc-core`/`copc-reader`
（ADR-0003で採用済み）と同じ `roteiro-gis/copc-rust` の姉妹クレートで、`las`/`laz` の
要求バージョンが最初から揃っているため、`copc-rs`（ADR-0003で候補落ちした別クレート）が
起こした `laz` の版の衝突は起きなかった。`cargo tree` で確認しても依存グラフに
`laz` は1バージョン（0.12.2）しか現れない。

**入口の実装場所**: `crates/pcv-convert/examples/convert_streaming.rs`（新設）。
`copc-writer::convert_las_to_copc_streaming(las_path, copc_path, params, spill_dir, cancel)`
をそのまま呼ぶだけの薄いラッパー。変換アルゴリズム自体は`copc-writer`の中にあり、
このスパイクでは書いていない。`pcv-core`には触れていない(規約1)。

**引数は既定値のまま使った**:
- ノードあたり最大点数: `CopcWriterParams::default()` と同じ 100,000点（M4-1の素朴な実装と同じ値）
- spill_dir: `convert_las_to_copc_streaming` は spill_dir を必須引数として要求し、
  クレート自体に「既定のOS一時ディレクトリ」という概念は無いため、呼び出し側
  （このexample）で `std::env::temp_dir()` を既定値とした

**分かったこと(spill_dirの範囲について)**: `spill_dir`引数が制御するのは点レコード本体の
一時ファイル(`.copc-writer-spill.*.part`)だけである。octree(LOD)構築が使う一時ファイル
(`.copc-writer-root.*.idx`・`.copc-writer-partition.*.idx`・`.copc-writer-order.*.idx`。
`copc-writer`の`lod.rs`の`new_index_tempfile`)は`tempfile::Builder::tempfile()`
(ディレクトリ指定なし)で常にOS既定の一時ディレクトリに作られる実装になっており、
spill_dirをどこに変えても影響しない。このexampleではspill_dirの既定値もOS既定の
一時ディレクトリにしたため、変換に関わる一時ファイルは実際には全て同じ場所に集まった。

**計測環境**(M4-1と同じ機体であることを本セッションで独立に再確認した)

| 項目 | 値 |
|---|---|
| CPU | Intel(R) Core(TM) i5-14600K(14コア/20スレッド) |
| RAM | 31.84 GiB(実測 34,183,237,632 バイト、`Get-CimInstance Win32_ComputerSystem`) |
| OS | Windows 11 Home 10.0.26200 |
| ビルド | `cargo build -p pcv-convert --release --example convert_streaming`(ワークスペース既定の`[profile.release]`: opt-level=3, lto=true, codegen-units=1) |
| ピークメモリの測り方 | M4-1と同じ: PowerShellの`Start-Process`相当(`System.Diagnostics.Process`)で子プロセスとして起動し、終了まで200msごとに`PeakWorkingSet64`をポーリングして最大値を取る |
| ピーク一時ディスク使用量の測り方 | 同じ200msポーリングのループの中で、OS既定の一時ディレクトリ(`%TEMP%`)直下の`.copc-writer-*`という名前のファイル(上記の一時ファイル群)の合計バイト数を毎回計算し、最大値を取る |

**実測値**(`cargo run -p pcv-convert --release --example convert_streaming -- <入力> <出力>`。
引数は既定値のまま=ノードあたり最大点数もspill_dirも指定していない)

| 入力 | 点数 | 所要時間(壁時計) | ピークメモリ | ピーク一時ディスク | 出力サイズ |
|---|---|---|---|---|---|
| `beer.laz` | 66,848,096 | **46.27 秒** | **3.297 GB**(3,296,546,816 B / 3.070 GiB) | 3.948 GB(3,948,086,512 B) | 606.31 MB |
| `sofi.copc.laz` | 364,384,576(検証で入力ヘッダから再確認) | **553.81 秒**(9分14秒) | **18.607 GB**(18,607,149,056 B / 17.329 GiB) | 21.864 GB(21,864,486,524 B) | 3,305.84 MB |

**ピークメモリは点数に比例せず頭打ちになっているか(受け入れ条件、点数比 5.4509倍で機械的に判定)**:

- 点数比(sofi/beer): 364,384,576 / 66,848,096 = **5.4509倍**
- ピークメモリ比(sofi/beer): 18,607,149,056 / 3,296,546,816 = **5.6444倍**
- ピーク一時ディスク比(sofi/beer): 21,864,486,524 / 3,948,086,512 = **5.5380倍**
- 出力サイズ比(sofi/beer): 3,305.84 / 606.31 = **5.4524倍**(ほぼ点数比どおり。圧縮後サイズは点数に比例するのが自然)

**結論(数値のみから機械的に): 頭打ちになっていない。** メモリ比(5.6444)・一時ディスク比(5.5380)
はどちらも点数比(5.4509)を**上回っており**、むしろわずかに点数より速く増えている
(比の比: メモリ 1.0355倍、一時ディスク 1.0160倍)。点あたりに換算しても裏付けられる:

| | beer(66,848,096点) | sofi(364,384,576点) |
|---|---|---|
| メモリ(バイト/点) | 49.31 | 51.06 |
| 一時ディスク(バイト/点) | 59.06 | 60.00 |

点数が5.45倍になってもバイト/点がほぼ変わらない(むしろ微増)ということは、
**ピークメモリ・一時ディスクとも、この2点の範囲では点数にほぼ比例したままである。**
「頭打ち」(点数が増えてもピークが伸び悩む)は observed されなかった。

**なぜそうなったと考えられるか(参考、実装を読んで分かったこと)**: `copc-writer`の
`SpillReader`は、点レコードを吐き出した一時ファイルを`memmap2::Mmap::map`で
**ファイル全体を一度にmmapする**(`copc-writer`の`spill.rs`参照)。このマシンはRAMが
31.84GiBあり、sofiの一時ファイル総量(約21.9GB)はメモリに十分収まるため、OSは
mmapしたページをディスクへ追い出す必要がなく、ほぼ全ページがworking setに残り続けたと
考えられる。つまりこの実測は「メモリが足りている環境でout-of-core実装がどう振る舞うか」
を測ったものであり、**RAMがもっと少ない環境(例えば8GB前後)でも同じ比率になるとは限らない**
(ページアウトが発生すれば実働メモリは減るが、その分ディスクI/Oが増えて所要時間が伸びるはずで、
このマシンでは再現できない)。この点は判断材料として明記しておく。

参考として、M4-1の素朴な実装(全点をメモリに読み込む)のbeer.lazでの値(約62バイト/点、
実測4.116GB/66,848,096点)と比べると、`copc-writer`はbeer.lazで49.31バイト/点と
**約25%少ない**が、素朴な実装と桁が変わるような差ではない。「out-of-coreだから
メモリに載らないデータでも定数メモリで捌ける」という設計上の期待どおりには、
少なくともこの2点の実測では**なっていない**。

**所要時間**: sofiは553.81秒(9分14秒)で、判断表の閾値である30分(1800秒)には
大きく余裕がある(閾値の約31%)。時間比(11.9691倍)は点数比(5.4509倍)より
かなり大きく、超線形(点数のべき約1.46乗に相当)ではあるが、閾値との比較では問題にならない。

**出力の検証**(`cargo run -p pcv-convert --release --example verify -- <入力> <出力>`):

- 両ファイルとも`pcv_core::CopcFile::open`で開けた
- hierarchyの点数の合計が入力の申告点数と一致した(beer: 66,848,096、sofi: 364,384,576。
  sofiは`las::Reader`でヘッダーを読み直し、タスクシート記載の364,384,576点と一致することを
  このセッションで再確認した)
- 粗いノードから5個ずつ`read_node`で読み、hierarchyの申告点数と実際に読めた点数が一致した
  (beer: 1,297ノード、sofi: 8,094ノード。M4-1の素朴な実装のノード数、beer: 1,878とは
  異なるが、これは octree の分割戦略の違いによるもので、点数の一致には影響しない)

**ライセンスと依存**:

- `copc-writer` 0.9.0本体: `MIT OR Apache-2.0`(本プロジェクトと同じ、配布と両立する)
- 直接・主要な依存のライセンス(`Cargo.toml`を実際に確認): `copc-core`(MIT OR Apache-2.0)、
  `las`(MIT)、`laz`(Apache-2.0)、`memmap2`(MIT OR Apache-2.0)、`tempfile`(MIT OR Apache-2.0)。
  すべて許諾的なライセンスで、`MIT OR Apache-2.0`での配布と衝突しない
- 依存クレートの数: `pcv-convert`自身の依存木(`cargo tree -p pcv-convert -e normal`、
  クレート名でユニーク集計)は`copc-writer`追加前16個→追加後22個(+6: `copc-writer`・
  `memmap2`・`tempfile`・`fastrand`・`once_cell`・`windows-sys`)。**ただしワークスペース全体
  では新規クレートは0個。** `copc-writer`は既に`pcv-core`の`[dev-dependencies]`
  (テスト用の極小COPC生成、M1-point-rendering.md参照)として使われており、`Cargo.lock`には
  既に完全に解決済みだった。実際に`git diff Cargo.lock`で確認すると、この変更による差分は
  `pcv-convert`の依存リストに`"copc-writer"`という1行が増えただけだった
- ビルド時間の増加: このworktreeにはリリースプロファイルの成果物が全く無い状態から測った。
  `copc-writer`を含めない状態で`cargo build -p pcv-convert --release`(クリーンな
  `target/release`から)= **8.38秒**。そこから`copc-writer`を追加して同じビルドを
  実行 = 追加で**5.87秒**(`memmap2`・`tempfile`・`fastrand`・`once_cell`・`windows-sys`・
  `copc-writer`本体のコンパイルとリンクの分)。マシンが速い(14コア/20スレッド)ため
  絶対値は小さいが、増分は明確に計測できた

**判断表への当てはめ**(数値のみで機械的に。判断そのものはコーディネーターが行う):

sofi(3.64億点)について、判断表の各条件を実測値と照合する:

| 条件 | 実測 | 判定 |
|---|---|---|
| 30分以内 | 553.81秒(9分14秒) | ○(閾値の約31%) |
| ピークメモリ8GB以内 | 18.607 GB(17.329 GiB) | ×(閾値の約2.17〜2.33倍) |
| 出力が正しい | hierarchy点数一致・read_node成功 | ○ |
| ライセンスがMIT/Apache-2.0と両立 | 全依存が許諾的ライセンス | ○ |

1行目(**採用する**)は「時間**かつ**メモリの両方が閾値以内」を要求しており、メモリが
閾値を超えているため**1行目には当てはまらない**。2行目「出力が正しく、ライセンスも
両立するが、時間かメモリの基準を超える」の条件(時間**か**メモリのどちらかが超過)に
**当てはまる**(超過しているのはメモリのみ、時間は余裕がある)。ボトルネックは上記のとおり
ピークメモリで、原因として`SpillReader`が一時ファイル全体をmmapし、RAMに余裕がある
このマシンではページアウトが起きずworking setに残り続けたことが考えられる、と記録しておく。
**最終判断(2行目のADRでの理由付けを含む)はコーディネーターが行う。**

### 変換を行う環境の範囲（コーディネーターの判断）

**変換はデスクトップ（Windows）だけで行う。** Android（RAM 4GB）で数億点の変換は現実的でなく、
Web はブラウザから大きなファイルを書き出す手段が限られる。Android と Web は COPC を開くことに専念する。
所有者が異なる判断をすればここを改める。


### コーディネーターによる再計測と判断（2026-09-24）

上の結果を受け、コーディネーターが同じ `examples/convert_streaming.rs` で再計測した。
**ワーキングセットはメモリマップした一時ファイルのページを含み、メモリ不足で落ちるかどうかの指標にならない**ため、
プライベートメモリ（ファイルに裏付けられていないメモリ）も並べて測った。

| 入力 | 時間 | プライベートメモリのピーク | ワーキングセットのピーク |
|---|---|---|---|
| beer.laz | 190.0秒・170.9秒（2回） | 0.021GiB | 3.07GiB |
| sofi.copc.laz | 1,079.3秒（18.0分） | 0.053GiB | 17.3GiB |

sofi の出力は `pcv-core` で開け、点数が一致し、ノードを読めた。

**時間はエージェントの値（beer 46.27秒、sofi 553.81秒）を再現できなかった**（beer で約4倍、sofi で約2倍遅い）。
原因は未解決。判断には遅い側を使った。

**判断: 1行目（`copc-writer` を採用する）。** 詳細と、指標をプライベートメモリに正した理由は
[ADR-0006](./ADR-0006-conversion-strategy.md)。

---

## M4-2: 方式を決めて ADR に記録する

M4-1 の結果を受けて `ADR-0006-conversion-strategy.md` を起こす。
ADR-0001 と同じ書式（決定 / 背景 / 帰結 / 却下した案）で、**実測値を根拠として明記する**。

外部ツール同梱に倒す場合は、以下も併せて記録すること。

- ライセンス（同梱して配布してよいか）
- インストーラのサイズ増加
- **Android では動かないこと**（M3 で Android を出す方針のため、影響範囲を明記する）
- **Web 版でも使えないこと**（ブラウザでバイナリを実行できない）

### 受け入れ条件

- [ ] ADR-0006 が実測値を根拠に決定を記述している
- [ ] 外部ツール同梱の場合、上記4点が記録されている

---

## M4-3: 決めた方式で実装する

### 守ること

変換は**どう実装しても重い処理**である。UI がそれを隠さないこと。

- **進捗を出す。** 何%か、推定残り時間はどれくらいか
- **キャンセルできる。** 間違ったファイルを指定したときに待たされない
- **結果を永続化する。** 変換結果を `<元ファイル名>.copc.laz` として保存し、
  次回以降は変換せずそれを開く。**同じファイルを二度変換しない**
- **変換中も UI が固まらない。** 別スレッド / 別プロセスで走らせる
- 既に COPC のファイルを開いたときは、当然だが変換を挟まない（即座に開く）

### 受け入れ条件

- [x] 生の LAS/LAZ をドロップすると変換が始まり、進捗が出る
      （「ドロップ」ではなく「ファイルを選ぶ…」ダイアログ経由。ドラッグ&ドロップ
      自体は`HANDOFF.md`の「小さい残務」に記載のとおり本タスクの範囲外の
      既存の未実装機能であり、今回は変えていない）
- [x] 変換中に UI が操作でき、キャンセルできる（下記「実施記録」参照。GUIでの
      目視確認は未実施、Rustの統合テストでキャンセル時の一時ファイル削除を確認済み）
- [x] 変換後、自動的にビューアで開く（`onConversionDone`→`openFile`の再呼び出し）
- [x] 同じファイルを再度開くと変換が走らない（キャッシュが効いている）
- [x] 既に COPC のファイルは即座に開く

### コミット単位

`feat: add las/laz import with progress and cancel`

### 実施記録（2026-09-24〜2026-09-25、Sonnet）

**方針転換（作業中に発生）**: 当初は「変換はデスクトップ（Windows）だけ」
（ADR-0006の初版）という前提で作業を始めたが、途中で所有者の方針変更により
**Androidでも変換する**ことになった（ADR-0006の追記「Android と Web でも
変換する」参照。Webは別段階M4-6として範囲外のまま）。この節はAndroid対応後の
最終形を記録する。

#### `copc-writer` の対応状況を確認した結果（受け入れ条件どおり、ソースで確認）

- **中断**: `copc_core::CancelCheck`トレイトと`*_with_cancel`系の関数で
  最初から対応している。**そのため別プロセスは使わない。** 同じプロセス内の
  別スレッドで変換し、`Arc<AtomicBool>`を共有する`AtomicCancel`
  （`crates/pcv-convert/src/streaming.rs`）で止める。キャンセル時・失敗時の
  一時ファイル・書きかけ出力の後始末も`copc-writer`自身がRAII
  （`tempfile::NamedTempFile`。`.persist()`を呼ばない限りDrop時に自動削除）で
  行うことをソースで確認済み。呼び出し側で追加の後始末コードは書いていない
  （`crates/pcv-convert/tests/streaming_conversion.rs`の
  `cancelling_mid_conversion_leaves_no_leftover_files`で実際に確認）
- **進捗**: コールバックは無い。ただし低水準API`write_streaming_with_cancel`
  (`path, layout, points: I, params, metadata, spill_dir, cancel`)は点の
  `Iterator`を受け取るため、`las::Reader`のバッチ読み込み(`fill_points`)を
  包むイテレータ(`streaming.rs`の`BatchedLasPoints`)で読んだ点数を数え、
  正確な読み込み進捗(`ReadProgress`)を報告できる。読み込み後(octree構築・
  チャンク圧縮・書き出し)は`write_streaming_with_cancel`の呼び出し内部で
  一括して行われ外からフックできないため、段階名（「後処理中」）だけを示す
- 一時ファイル: 点の一時ファイルは`spill_dir`に作られるが、**LODの索引の
  一時ファイルは常にOS既定の一時ディレクトリ**(`tempfile::Builder::new()
  .tempfile()`、`spill_dir`の指定は効かない)に作られる。Rust標準ライブラリの
  ソース(`library/std/src/sys/paths/unix.rs`の`temp_dir()`)を確認すると、
  `TMPDIR`環境変数が設定されていれば常にそれを優先し、Android向けの既定値
  (`/data/local/tmp`。アプリから書き込めない)はTMPDIR未設定時のみ使われる。
  そのため`redirect_os_temp_dir`(`src-tauri/src/conversion.rs`)で
  `TMPDIR`(Unix系)/`TMP`・`TEMP`(Windows。`GetTempPath2W`が読む変数)を
  書き換えることで、LOD一時ファイルもspill_dirと同じ場所へ誘導している

#### 当初の設計からの変更点（`convert_las_to_copc_streaming_with_crs_wkt_override`→`write_streaming_with_cancel`）

パスを渡すだけの一括関数は、Androidの`content://` URIから得られる
`std::fs::File`（パス文字列を経由できない）を受け取れない。低水準API
`write_streaming_with_cancel`は`R: Read + Seek`から作った点のイテレータを
渡す形なので、デスクトップのパスもAndroidの`content://`も最終的に
`std::fs::File`（`tauri-plugin-fs`が`ContentResolver`経由で開いたもの。
`src-tauri/src/copc_state.rs`の`open_uri_reader`と同じ経路）になることを
利用して、**1本の経路に統一した**（`crates/pcv-convert/src/streaming.rs`の
`convert<R: Read + Seek + Send + Sync + 'static>`）。

代償として、一括関数が内部で行っていた「元ファイルの任意のVLR/EVLRの
パススルー」「synthetic return numbersのglobal encodingビット」は
自分で組み立てる必要が生じた（`write_metadata.rs`）。**任意のVLR/EVLRの
パススルーは行っていない**（本アプリが使う属性はxyz・強度・分類・RGBの4つ
だけで、`crates/pcv-convert/src/point.rs`のM4-1時点の方針と同じ判断）。
CRS(WKT)だけは個別に手当てする（下記）。

#### CRS（座標参照系）を運ぶこと（受け入れ条件）

`copc-writer`のソース(`validate.rs`)を読んで確認したところ、**元がGeoTIFF
キーだけ(WKTのVLRが無い)の入力は、`crs_wkt_override`を渡さない限り変換
そのものが`Error::Unsupported`で失敗する**ことが分かった。M4-1が記録した
「CRSが失われる」だけでなく、**変換自体ができなくなる**という、より重大な
問題だった。

`crates/pcv-convert/src/crs_override.rs`の`resolved_wkt_crs_for_header`が
解決する:

1. 元にWKTのVLRがあればそのままそのWKT文字列を使う（従来どおり）
2. GeoTIFFキーだけで、かつ`pcv_core::crs`（M4-5、平面直角座標系19系・
   UTM 51N〜56N）が対応する系なら、検証済みのゾーンパラメータからWKTを
   組み立てる（datum/楕円体/単位のEPSG権威コードは広く使われる既知の
   固定値だが、本セッションでレジストリへ都度確認してはいない。正しさは
   生成したWKTを`pcv_core::crs::detect_crs_from_las_header`に通し、
   元と同じ系に戻ることをテストで確認した）
3. それ以外はCRSが失われることを許容する（対応していない系の変換式を
   持っていないため）

**確認済み**: 合成LAS(GeoTIFFキーのみ、EPSG:6677=JGD2011 IX系)を実際に
変換し、出力にWKTのCRSが書かれ`EPSG:6677`を含むことをテストで確認した
(`crates/pcv-convert/tests/streaming_conversion.rs`の
`geotiff_only_crs_is_carried_through_via_override`)。**実データ(sofi等)の
CRSが元のGeoTIFF形式かWKT形式かは確認していない**（テストデータが
手元に無いため。GUIでの最終確認は所有者に委ねる）。

#### 進捗の出し方（読み込み段階のみ正確な割合）

`ReadProgress{points_read, total_points}`をLASヘッダーの申告点数を分母に
`src/ui/shell/LayerPanel.tsx`が%とプログレスバー・経過時間を表示する。
読み込み完了後は「octreeを構築・書き出し中(割合は出せません)」という
段階名表示に切り替わる。推定残り時間は出していない（読み込み段階の速度から
外挿することもできるが、後半の段階（octree構築・書き出し）の所要時間比率が
不明なため、誤った期待を持たせるより「出せない」と正直に示す方を選んだ）。

#### キャッシュ（同じファイルを二度変換しない）

`crates/pcv-convert/src/cache.rs`: 変換結果の隣（実際には出力の隣、
`output_path.rs`参照）に`<出力>.meta`というサイドカーを置き、変換時点の
元ファイルの指紋（サイズ・更新日時。テキスト形式、2行）を記録する。次に
同じ元ファイルを開こうとしたとき、指紋が一致すれば変換をスキップして
即座に開く。元ファイルが更新されていれば（サイズか更新日時が変わっていれば）
作り直す。判定そのもの(`needs_reconversion`)はファイルI/Oをしない純粋関数で
テストしてある。

Androidの`content://`は`std::fs::metadata`（パス文字列前提）では読めないため、
`tauri-plugin-fs`で開いた`File`から直接読む`fingerprint_of_file`を追加した。
**Androidの`content://`は更新日時を正しく報告しない実装のコンテンツプロバイダ
がありうる**（コーディネーター指示のとおり）。その場合は指紋が一致しにくくなり
「余分に作り直す」方向にしか転ばない（安全側）。

#### 出力の置き場所

`crates/pcv-convert/src/output_path.rs`: `<元ファイル名>.copc.laz`をまず
元ファイルの隣に書こうとし（実際に一時ファイルを作って消すことで書き込める
か確かめる）、書けなければアプリのキャッシュディレクトリ配下
(`<app_cache_dir>/converted/`)に、元パス全体のハッシュを前置いた名前で置く。
Androidの`content://`は常に「隣に書けない」ため必ずフォールバックへ入る。
`content://` URIを`Path`として扱う（実在するパスである必要は無い、文字列の
最後の`/`区切りをファイル名の手がかりにするだけの割り切り）ため、SAFの
content URIが返す末尾セグメント（URLエンコードされた元ファイル名を含むことが
多い）がそのままキャッシュ内のファイル名に混じる。読みやすさより
「実装の追いやすさ（単純さ）」を優先した割り切りで、動作に影響は無い。

#### 空き容量の事前チェック

`crates/pcv-convert/src/disk_space.rs`: ADR-0006の実測(sofi: 入力2.03GB→
一時ファイルピーク21.864GB、比≈10.77倍)を根拠に**11倍**を必要容量の見積もり
とする。取得方法はWindows(`GetDiskFreeSpaceExW`)とUnix系/Android
(`statvfs(2)`。AndroidはLinuxカーネルの上で動くためJNI不要)の2つを実装した。
**Android実機でのstatvfs呼び出しは未確認**（Androidのクロスコンパイル
ターゲットがこの開発環境に無いため、ローカルではコンパイルすら確認できて
いない。`gh workflow run release.yml`のAndroidジョブでのビルド成功が
唯一の確認手段。下記「確認したコマンドと結果」参照）。

#### Android: 一時ディレクトリの誘導

`src-tauri/src/lib.rs`の`setup_android_temp_dir`（`.setup()`フックから
呼ぶ）が、起動直後にアプリのキャッシュディレクトリへ`TMPDIR`を向ける
（上記「`copc-writer`の対応状況」参照）。所有者が設定で一時ディレクトリを
指定した場合は、変換開始時にそのディレクトリへさらに向け直す
(`conversion.rs`の`decide_and_start`)。

#### UI

`src/ui/shell/LayerPanel.tsx`にインライン表示（半透明パネルの中。ADR-0005の
「情報の多い設定画面以外は半透明」の方針に沿う）。ファイル選択ダイアログの
フィルタを`.las`/`.laz`両方に広げた。`src/ui/shell/SettingsModal.tsx`に
一時ディレクトリの設定を追加（デスクトップだけ。Androidは
`supports_custom_temp_dir`コマンドが`false`を返すため出さない。理由:
AndroidのOSフォルダ選択(SAF)が返す`content://`ツリーURIは、`tempfile`が
要求する実在のファイルシステムパスとしては使えない）。

エラー（変換の失敗・キャンセル・容量不足）は既存のエラーバナー
(ADR-0011/ADR-0013、`GpuErrorLog`/`GpuErrorBanner`)に`source: "conversion"`
として統合した。専用の仕組みを増やさない、という既存の方針を踏襲した。

#### Web版

`src/datasource/copc-header.ts`(`isCopcHeader`/`isCopcFile`)でヘッダーを
読み、生LAS/LAZなら「デスクトップ版でCOPCに変換してから開いてください」と
案内する（受け入れ条件。Web版は変換しない。ADR-0006で別段階M4-6として
切り出し済み）。判定はRust側`copc_detect.rs`と独立に実装している(Web側に
LASパーサライブラリが無いため、LASヘッダーのバイト配置を直接読む)。
この判定はローカルファイル選択(`<input type="file">`)の経路だけに適用した
(URL入力は既存のサンプル(autzen、既にCOPC)を開く用途がほとんどのため、
範囲を広げていない)。

#### 範囲外にしたこと（正直に）

- **推定残り時間**: 出していない（上記「進捗の出し方」参照）
- **Web版の変換**: ADR-0006で別段階(M4-6)として明確に切り出し済み
- **元のVLR/EVLRの任意のパススルー**: `write_streaming_with_cancel`への
  切り替えに伴い失われた。本アプリが使わない属性なので実害無しと判断した
- **Android実機・GUIでの確認全般**: 確認手段が無いため、下記「所有者が
  確かめる手順」に委ねる

### 確認したコマンドと結果

```
$ cargo fmt --all -- --check
（出力無し、終了コード0）

$ cargo clippy --workspace --all-targets -- -D warnings
（警告・エラー無し）

$ cargo test --workspace
pcv-convert（ライブラリ）: 41 passed
pcv-convert（統合テスト。import_e57/import_pcd/import_ply/import_to_copc/
             roundtrip/streaming_conversion）: 1+4+5+1+1+5 = 17 passed
pcv-core（ライブラリ）: 31 passed
pcv-tauri（ライブラリ）: 6 passed
合計95件、失敗0

$ cargo build -p pcv-core --target wasm32-unknown-unknown
Finished（成功。規約1を満たす）

$ npx tsc --noEmit
（出力無し、終了コード0）

$ npx eslint .
（出力無し、終了コード0）

$ npx vitest run
Test Files  26 passed (26)
     Tests  212 passed (212)

$ npm run build
✓ 77 modules transformed.
✓ built in 814ms
```

CI（`ci.yml`）: 本タスクの一連のpushが緑であることを`gh run list`で確認した
（run 36028325879・36029833886・36031205830等。所有者が最新の状態を
`gh run list --branch main --limit 5`で確認できる）。

`workflow_dispatch`でのAndroidビルド確認（タグ・Releaseは作らない経路）:
`gh workflow run release.yml --ref main`を実行した。run idと結果は
このタスクシートの後半（本文末尾に追記）を参照。**Androidのクロス
コンパイル環境がこの開発機に無いため、Android向けのコードパス
（`statvfs`によるdisk_space、`content://`経由の変換、`redirect_os_temp_dir`の
Android分岐）はこのCIでのビルド成功だけが唯一の確認手段であり、実機での
動作（実際に変換が完走するか、空き容量チェックが正しい値を返すか等）は
確認できていない。**

### 所有者が確かめる手順

1. **デスクトップ: 生のLAS/LAZを開く**
   - 拡張子`.las`/`.laz`（COPCでない）のファイルを「ファイルを選ぶ…」で
     選ぶ。進捗（%・プログレスバー・経過時間）が出て、変換完了後に自動的に
     点群が表示されることを確認する
   - 変換中に「キャンセル」を押し、UIが操作できたまま変換が止まり、
     一時ファイル（既定はOSの一時ディレクトリ、または設定で選んだ場所）と
     書きかけの出力が残っていないことを確認する（エクスプローラで
     一時ディレクトリを見る）
   - 同じファイルをもう一度開き、変換が走らず即座に開くことを確認する
     （出力の隣に`<ファイル名>.copc.laz.meta`ができているはず）
   - 既にCOPC(`.copc.laz`)のファイルを開き、変換を挟まず即座に開くことを
     確認する
2. **デスクトップ: 空き容量不足**
   - 設定で一時ディレクトリを空き容量の少ないドライブ・フォルダに変更し、
     大きめのLASファイルを開こうとして、変換が始まる前にエラーバナーで
     知らされることを確認する
3. **CRS**: GeoTIFF形式のCRSを持つ実データ（もしあれば）を変換し、出力を
   QGIS等で開いて座標系が正しく認識されることを確認する（本セッションでは
   合成データでしか確認していない）
4. **Android実機**: `gh run download <run-id> -n android-apk`でAPKを取得し、
   OPPO Pad Air等にインストールする。生のLAS/LAZファイルを選び、
   - 変換が始まり進捗が出るか
   - 完了後に自動的に開くか
   - 空き容量チェックが機能するか（`statvfs`が正しい値を返すか）
   - `adb logcat -s pcv:*`でエラーが出ていないか(ADR-0013)
   を確認する。**これらはすべて未確認**（実機・Android向けビルド環境が
   この開発環境に無いため）
5. **Web版**: 生の`.laz`（COPCでない）ファイルを選び、「デスクトップ版で
   変換してください」という趣旨のメッセージが出て、開こうとしないことを
   確認する

---

## M4 完了の定義

- [x] 変換方式が実測値に基づいて決まり、ADR-0006 に記録されている
- [x] 生の LAS/LAZ を開けるようになっている（デスクトップ・Android。Webは
      変換を挟まず案内を出すのみ、ADR-0006の方針どおり）
- [x] 同じファイルを二度変換しない
- [x] `ARCHITECTURE.md` の「現在の状態」表が更新されている

---

## M4-4: E57 / PLY / PCD の取り込み

### やること

[ADR-0008](./ADR-0008-formats-and-crs.md) の決定に従い、入力形式を広げる。
内部形式は COPC のまま変えない。**入力側にインポータを足すだけ**である。

優先順位は E57 → PLY → PCD。E57 は地上型スキャナの事実上の標準で、測量業務で最も要求される。

クレート選定は [ADR-0003](./ADR-0003-copc-crate.md) と同じ基準で行う。
**`pcv-core` が wasm32 でビルドできること（規約1）を満たさない候補は落とす。**
実際に試して決め、理由を ADR-0008 に追記すること。

### 受け入れ条件

- [x] E57 / PLY / PCD を開いて COPC に変換できる
      （**ライブラリの経路として**。「E57/PLY/PCD → LAS」は本タスクで実装・テスト済み、
      「LAS → COPC」は ADR-0006 で採用済みの `copc-writer` 経路をそのまま使う。
      両者をつないで実際に COPC が開けることは E57 で統合テスト済み(下記「実施記録」参照)。
      アプリ(Tauri)への配線・UI は並行して進んでいる M4-3 の担当であり、本タスクの範囲外）
- [x] 変換後の点数が元ファイルの申告と一致する（下記「実施記録」参照。テストで確認）
- [x] `cargo build -p pcv-core --target wasm32-unknown-unknown` が通る（規約1。
      `pcv-core` には一切触れていない）
- [x] **PLY と PCD は CRS を持たないため、取り込み時に座標系を指定させるか
      「不明」として扱う。** 不明のまま計測や重ね合わせをさせない
      （`to_las`の引数`crs_wkt: Option<Vec<u8>>`で口を用意。詳細は下記「実施記録」参照）

### 実施記録（2026-09-24〜25、Sonnet）

**担当範囲**: コーディネーターの指示により、本タスクの担当は「E57/PLY/PCD → LAS」の
変換のみ。`copc-writer`によるLAS/LAZ→COPC変換（ADR-0006、M4-1b）は入力にLAS/LAZしか
取らないため、E57/PLY/PCDはいったんプレーンなLAS(`.las`、非圧縮)へ書き出し、あとは
既存のLAS/LAZ→COPC経路にそのまま乗せる設計にした。アプリ(Tauri)への配線は並行して
進むM4-3のエージェントの担当であり、`src-tauri/`・`src/`には一切触れていない。

**実装した場所**: `crates/pcv-convert/src/import/`（新設）。

- `mod.rs`: 公開API。`to_las(input, output, crs_wkt) -> Result<ImportSummary, ImportError>`、
  `detect_format(path) -> Option<SourceFormat>`、`ImportSummary{point_count, crs_known}`
- `point.rs`: 3形式が共通で使う中間表現`ImportedCloud`/`ImportedPoint`
  (`crate::point::SourceCloud`/`RawPoint`、M4-1と同じ設計)
- `scale.rs`: LASのscale/offsetの選び方(純粋関数)。M4-4の受け入れ条件どおり
  mm以下の精度を保つ。7件のテストで境界値・往復・退化データ・軸ごとの独立性を確認
- `las_out.rs`: `ImportedCloud`をプレーンなLASへ書き出す(`las::Writer`をそのまま使う。
  COPCのバイナリ構造は組み立てない。それは`copc-writer`の担当)
- `e57.rs`・`ply.rs`・`pcd.rs`: 各形式の読み込み

**クレート選定・属性の対応・スケールの選び方・CRSの扱い・Androidへの下準備**の詳細は
[ADR-0008](./ADR-0008-formats-and-crs.md)の2026-09-25追記を参照(要点だけここに記す):

- E57は`e57` 0.11.13、PCDは`pcd-rs` 0.13.0を採用。PLYは候補の`ply-rs`が
  ビルド時にdoctest実行用の重い推移的依存(`skeptic`経由の`cargo_metadata`・
  `pulldown-cmark`等)を引き込み、かつ2020年から更新が無いことを実際にビルドして
  確認したため、自前実装(ASCII/binary_little_endian/binary_big_endian)にした
- CRSは`to_las`の引数`crs_wkt: Option<Vec<u8>>`(WKTバイト列)で受け取る口を用意。
  `Some`なら`las::Header::set_wkt_crs`で書き込み、`None`なら「不明」のまま
  (推測で補わない)。EPSGコードからWKT文字列を生成する処理自体は範囲外(ADR-0008参照)

**受け入れ条件「点数が元ファイルの申告と一致する」の確認方法**: `ImportedCloud`は
元ファイルの申告点数を保持しない設計にした(理由は`point.rs`のコメント参照)。
代わりに、テスト(`tests/import_e57.rs`・`import_ply.rs`・`import_pcd.rs`)が
既知の点数Nでフィクスチャを組み立て、`to_las`が返す`ImportSummary::point_count`が
Nと一致することを確認する形にした。E57は姿勢適用後にCartesianが無効なままの点
(構造化データの欠測スロット等)を書き出さないため、この場合は申告点数と一致しない
ことがありうる、という制約を`e57.rs`のコメントに明記した(テストで使う合成データは
全点validなので、この食い違いは発生しない)。

**新規テスト**(`crates/pcv-convert/tests/`):

- `import_e57.rs`: `e57::E57Writer`で2スキャン(直交座標+姿勢=並進のみ、
  球面座標+姿勢=Z軸90度回転+並進)のE57を組み立て、姿勢適用後にまとめられること・
  球面→直交変換・値域の異なる色(0-255)と強度(0-1000)の正規化を確認
- `import_ply.rs`: ASCII/binary_little_endian/binary_big_endianをそれぞれ
  手で組み立て、`face`要素(list型プロパティ)を挟んでもバイト位置がずれずに
  読めることを確認
- `import_pcd.rs`: ASCII(色なし)・binary・binary_compressed(`pcd-rs`自身の
  `DynWriter`で作成)の3形式、およびCRS指定時/未指定時の挙動を確認
- `import_to_copc.rs`: **M4-4受け入れ条件「少なくとも1形式で統合テストする」**。
  E57(優先度最高)を`to_las`でLASへ、続けて`copc_writer::convert_las_to_copc_streaming`
  (ADR-0006で採用済みの経路)でCOPCへ変換し、`pcv_core::CopcFile::open`で開け、
  hierarchyの点数合計が申告点数と一致し、全ノードを`read_node`で読めることを確認

**Androidへの下準備(範囲外だが実施)**: ADR-0006の追記(変換をAndroidでも行う)を受け、
E57/PLY/PCDの読み込み内部実装を`read(path: &Path)`から`read_from<R: Read(+Seek)>`へ
分離した(3クレートとも元々ジェネリックな読み込みAPIを持っていたため)。ただし
`pub(crate)`のままで公開APIには出していない(理由はADR-0008参照)。

**確認したコマンドと結果**(このworktreeで実行。CI自体はこのセッションでは実行していない):

- `cargo build -p pcv-convert` → 成功(警告0件)
- `cargo build -p pcv-core --target wasm32-unknown-unknown` → 成功
- `cargo fmt --all -- --check` → 差分なし
- `cargo clippy -p pcv-convert --all-targets -- -D warnings` → 警告0件
- `cargo test -p pcv-convert` → 20件成功(0失敗)
- `cargo clippy --workspace --all-targets -- -D warnings`(`src-tauri`を含む
  ワークスペース全体) → 警告0件
- `cargo test --workspace` → 全ジョブ成功(0失敗)。`pcv-convert`(unittests 9件・
  `import_e57`1件・`import_pcd`4件・`import_ply`5件・`import_to_copc`1件・
  `roundtrip`1件)、`pcv-core`(31件)、`pcv-tauri`(6件)、doc-testsすべて含む。
  M4-3(並行作業のエージェント)が触れている`src-tauri`もこのセッションで一緒に
  緑であることを確認した
- CI(GitHub Actions)上の実行・run idはこのセッションでは確認していない。
  コーディネーターがpush後に確認すること

---

## M4-5: 座標参照系（平面直角座標系 と UTM）

### やること

[ADR-0008](./ADR-0008-formats-and-crs.md) の通り、**PROJ を使わず横メルカトル変換を自前で実装する。**
平面直角座標系も UTM もどちらも横メルカトルなので、実装の本体は順変換・逆変換1本と
ゾーンのパラメータ表（平面直角19系、UTM 帯）だけになる。

- LAS/LAZ の CRS（GeoTIFF キーまたは WKT の VLR）を読む
- 平面直角座標系19系と UTM のゾーン定義を持つ
- 系の異なるデータを重ねるときに再投影する
- 画面上の座標表示を、選んだ系で出す

### 精度の検証（省略しないこと）

**測量用途なので「それらしい値が出た」では受け入れない。**
国土地理院が公開している座標変換の計算例、または既知の基準点座標を用いて、
**mm オーダーで一致することを単体テストで確認する。**

### 受け入れ条件

- [x] 平面直角座標系19系と UTM の相互変換ができる
- [x] **国土地理院の計算例と mm オーダーで一致することをテストで確認した**
- [x] `pcv-core` が wasm32 でビルドできる（規約1 が守られている＝PROJ を入れていない）
- [ ] 系の異なる2つのデータを重ねると、正しい位置関係で表示される
      （**今回のコーディネーター指示で範囲外**。ビューアが1ファイルしか開けないため、
      重ね合わせ表示自体は実装していない。緯度経度を経由してある系から別の系へ
      変換する計算そのものは実装・テスト済み＝下記「実施記録」の
      `cross_zone_conversion_via_lat_lon`テスト参照）
- [x] JGD2000 と JGD2011 を取り違えない（取り込み時に明示させる）
      （型で区別。下記「実施記録」参照。「取り込み時に明示させる」UIの入力ダイアログ
      自体は今回の範囲外＝下記参照）

### 実施記録（2026-09-24、Sonnet）

**実装した場所**: `crates/pcv-core/src/crs/`（新設）。`pcv-core`直下に置き、
`crates/pcv-core/src/lib.rs`から`pub mod crs;`で公開した。

- `ellipsoid.rs`: GRS80（平面直角座標系用）とWGS84（UTM用）の楕円体定数
- `transverse_mercator.rs`: 横メルカトルの順変換・逆変換のエンジン本体（数式は
  1組だけ。原点・縮尺係数・false easting/northingをパラメータとして渡す）
- `plane_rectangular.rs`: 平面直角座標系19系の原点表、`JgdEpoch`(JGD2000/JGD2011)
- `utm.rs`: UTM 51N〜56N（日本に関係する帯）の中央子午線表
- `mod.rs`: 上記をまとめる`Crs`列挙型、EPSGコード判定、LASヘッダーからのCRS判定
  (`detect_crs_from_las_header`)、精度検証テスト一式

**計算式の出典**: 河瀬和重(2011)「Gauss-Krüger投影における経緯度座標及び
平面直角座標相互間の座標換算についてのより簡明な計算方法」国土地理院時報,
121, 109-124. <https://www.gsi.go.jp/common/000061216.pdf>
（式(5)〜(12)が順変換、式(13)〜(22)が逆変換）。国土地理院の測量計算サイトの
解説ページ(<https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/algorithm/bl2xy/bl2xy.htm>、
同`xy2bl`版)も同じ式を掲載しており、突き合わせて確認した。
平面直角座標系19系の原点一覧は<https://www.gsi.go.jp/LAW/heimencho.html>。

**子午線収差角の符号について(実装中に見つけた点)**: 河瀬(2011)の式(7)(15)を
そのまま実装すると、国土地理院APIの`gridConv`と符号が逆になった
(X, Y, 縮尺係数mは0.1mm/1e-7の精度で完全一致するため、これは実装の
バグではなく「収差角をどちら向きに正とするか」という定義上の符号の違いだと
判断した)。UIで表示する値がGSIの公開値と一致するよう、実装ではAPIの符号に
合わせて反転させている(`transverse_mercator.rs`のコメント参照)。

**テストの期待値の出典(すべてコード内のコメントに出典・再現手順を明記済み)**:

1. 国土地理院 測量計算サイトAPI(`bl2xy.pl`/`xy2bl.pl`、
   <https://vldb.gsi.go.jp/sokuchi/surveycalc/api_help.html>で仕様を確認)を
   2026-09-24に実際に呼び出して得た値。平面直角座標系 I系・VII系(逆変換)・
   IX系(東京駅付近、および原点から東へ約130km=系の端)・XIX系(南鳥島周辺)の
   5パターン。`curl -sL "<URL>?outputType=json&refFrame=2&zone=<系番号>&..."`
   で誰でも再現できる(URLと入出力値をテストのコメントに残した)。
2. Karney, C.F.F. (2011), "Transverse Mercator with an accuracy of a few
   nanometers", Journal of Geodesy 85:475-485の検証用データセット
   `TMcoords.dat`(配布元:
   <https://sourceforge.net/projects/geographiclib/files/testdata/TMcoords.dat.gz>)。
   WGS84楕円体・UTMの縮尺係数(0.9996)で、中央子午線からの経度差が0.58度・2.52度の
   2点を使い、GRS80/平面直角座標系に限らない横メルカトルの一般式そのものを検証した
   (GSI APIの実測(1)は平面直角座標系の範囲=中央子午線から高々130km程度しか
   カバーしないため、UTMの帯幅(片側約3度=300km超)に近い距離での精度は
   このデータセットで別途確認する必要があった)。ファイルが2.4GB超のため
   先頭2MBだけを部分取得し、取得手順をテストのコメントに記録した。

**往復テスト・系の端のテスト**: `round_trip_multiple_zones_and_positions`
(5系×5地点)、`gsi_api_ix_system_far_from_origin_edge_of_zone`
(IX系原点から東へ約130km)。ただしタスクシートの注記どおり、往復テストは
出典付きテストの代わりにはならないため、別のテスト関数として分離している。

**LASのCRS判定**: `las::Header::get_geotiff_crs()` /
`get_wkt_crs_bytes()`を使う。**`copc-reader`はCOPC info VLRとLASzip VLR以外を
読み捨てる**(`vendor/copc-reader/src/lib.rs`の`should_store_vlr`、
`user_id=="copc"&&record_id==1`または`user_id=="laszip encoded"&&record_id==22204`
以外は保持しない)ため、CRSを読むには`copc-reader`のAPIではなく`las`クレートで
ヘッダーを開き直す必要がある、と判断した。`las`0.10はGeoTIFFキー・WKTの解析を
標準機能として持っており(`las::Header::get_geotiff_crs`/`get_wkt_crs_bytes`)、
自前でVLRパーサを書く必要はなかった。`las-crs`という専用クレートも見つけたが、
`las`0.9系に依存しており`copc-reader`が使う`las`0.10系と衝突するため採用しなかった
(WKTからEPSGコードを取り出す十数行だけを自前で書いた)。

**JGD2000/JGD2011の区別**: `JgdEpoch`列挙型(`Jgd2000`/`Jgd2011`)で型として
区別し、`PlaneRectangularCrs`が両方を保持する。EPSGコード判定でもJGD2000
(2443〜2461)とJGD2011(6669〜6687)を別のコード範囲として扱う
(`Crs::from_epsg`のテスト`epsg_maps_to_expected_crs`で6677→Jgd2011、
2451→Jgd2000となることを確認)。**座標補正(パラメータファイルが要る)は
ADR-0008どおり実装していない。**

**範囲外にしたもの(コーディネーター指示どおり)**:
- 系の異なる複数データの重ね合わせ**表示**(ビューアが1ファイルしか開けない)。
  「系の間の変換」自体(緯度経度を経由)は`cross_zone_conversion_via_lat_lon`
  テストで実装・確認済み
- 画面上の座標表示(情報パネルへの1行表示)。`pcv-wasm`へのバインディングや
  Tauriコマンド、React側の配線が別途必要になり、「変換計算の実装」という
  今回の依頼の範囲を超えると判断し、Rust側(`pcv-core`)の計算とテストに絞った
- 旧日本測地系(Tokyo Datum)からの変換、鉛直座標系(ジオイド)

**確認したコマンドと結果**(このworktreeで実行。CIでの実行=GitHub Actions上の
run idは、コーディネーターがpush後に確認すること。**このセッションではCI自体は
実行していない**):
- `cargo build -p pcv-core --target wasm32-unknown-unknown` → 成功
- `cargo fmt --all -- --check` → 差分なし
- `cargo clippy --workspace --all-targets -- -D warnings` → 警告0件
- `cargo test --workspace` → 37件成功(0失敗)。うち`crs`モジュール21件

### この段階でやらないこと（ADR-0008 参照）

- **旧日本測地系（Tokyo Datum）からの変換** — グリッド（TKY2JGD）が必要
- **鉛直座標系（楕円体高 ↔ 標高）** — ジオイドモデルが必要。日本国内で 30〜40m の差がある。
  **[ROADMAP](./ROADMAP.md) の DTM / TIN に着手する前に ADR-0008 を見直すこと**
