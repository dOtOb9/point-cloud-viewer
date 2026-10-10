# M4: 各種形式の取り込みと COPC への変換、および CRS

- 状態: 進行中（M4-1〜M4-7完了。M4-2 の決定は ADR-0006。M4-9で、M4-4の
  「E57/PLY/PCD→LAS→COPC」を「E57/PLY/PCD→COPC直接」に作り直し、アプリへの
  配線(デスクトップ・Android)も完了した。Webへはつないでいない(M4-9参照)。
  M4-10で、ノードごとのLAZ圧縮も並列化した(デスクトップ・Android。M4-8で
  見送っていたparallel-compressを、所有者の決定で「点の集合の一致」を条件に
  採用し直した)。
  実機・実際のブラウザでの目視確認は各節の「所有者が確かめる手順」参照）
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
`gh workflow run release.yml --ref main`を実行した(**run 36031251726**)。
結果はコーディネーターが`gh run view 36031251726`で確認すること
（本セッション終了時点で完走を待てなかった場合は、実行中のままの可能性がある。
「所有者への報告」に最新状況を記す）。**Androidのクロスコンパイル環境が
この開発機に無いため、Android向けのコードパス（`statvfs`によるdisk_space、
`content://`経由の変換、`redirect_os_temp_dir`のAndroid分岐）はこのCIでの
ビルド成功だけが唯一の確認手段であり、実機での動作（実際に変換が完走するか、
空き容量チェックが正しい値を返すか等）は確認できていない。**

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
- [x] 生の LAS/LAZ を開けるようになっている（デスクトップ・Android・Web。
      Webの変換はM4-6bでOPFS上に実装した。OPFSが使えない環境・大きすぎる
      入力(sofi級)では案内を出す、ADR-0006の追記参照）
- [x] 同じファイルを二度変換しない（デスクトップ・Android・Web）
- [x] `ARCHITECTURE.md` の「現在の状態」表が更新されている

---

## M4-4: E57 / PLY / PCD の取り込み

> **M4-9で中間LASの経路は廃止した。** この節が記録する「E57/PLY/PCD→LAS」
> (`to_las`、`las_out.rs`)は、M4-9で「E57/PLY/PCD→COPC」の直接変換
> (`convert_to_copc`)に置き換わっている。`to_las`・`las_out.rs`は削除済み。
> この節はM4-4時点の設計判断(クレート選定・属性の対応表・スケールの選び方の
> 元になった考え方)の記録として残す。詳細はM4-9の節とADR-0008の2026-10-03
> 追記を参照。

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

---

## M4-6: Web での変換（2026-09-30 着手。まず調査）

[ADR-0006](./ADR-0006-conversion-strategy.md) の追記のとおり、`copc-writer` はそのままではブラウザで動かない
（一時ファイルに `tempfile`、読み戻しに `memmap2` を使い、`wasm32-unknown-unknown` にはどちらも無い）。
見込みのある道筋は、`copc-writer` を `vendor/` に取り込んで**一時ファイル・索引・出力の読み書きを差し替えられる形**に改修し、
Web では OPFS（Worker 内の `FileSystemSyncAccessHandle`）を使うこと。**外部クレートへの改修量が読めない**ので、実装の前に調査する。

### 調査（M4-6a）でやること

1. `copc-writer` 0.9.0 のうちファイルシステムに触る箇所（`spill.rs`、`lod.rs`、出力の書き出し）を洗い出し、
   **「読み書きの口」を1つのトレイトにまとめる改修**を、`main` ではなく**ブランチ `spike/m4-6` の上で**試す
2. そのトレイトの**メモリ上の実装**でネイティブのテストが通ること（振る舞いが変わっていないこと）を確かめる
3. **`wasm32-unknown-unknown` でビルドできるか**を確かめる（メモリ上の実装で。OPFS はまだ作らない）
4. OPFS の容量の上限（ブラウザごと）と、`FileSystemSyncAccessHandle` が Worker の同期 I/O として使えることを、公式の資料で確かめる

### 判断の基準（測る前に決めておく）

| 調査結果 | 決定 |
|---|---|
| 改修が `copc-writer` の**約500行以内**に収まり、ネイティブのテストが通り、wasm32 でビルドできる | **実装（M4-6b）に進む** |
| wasm32 でビルドできるが、改修が約500行を大きく超える、またはアルゴリズム本体に手を入れる必要がある | 要判断。改修量と保守の負担を記録し、所有者と相談する |
| wasm32 でビルドできない依存がある（スレッド・OS 固有の機能など）、または OPFS で要件を満たせない | **Web での変換は見送る。** ADR-0006 に理由を書き、Web ではデスクトップでの変換を案内する今の形を続ける |

調査のコードは `main` に入れない。結果（改修量、ビルドの可否、分かったこと）だけをこのタスクシートに記録する。

### 結果（2026-09-30、Sonnet）

**作業ブランチ**: `spike/m4-6`（`main` から分岐、`main` へは一切 push していない）。
調査コード（`vendor/copc-writer/`、`crates/pcv-convert/examples/spike_*.rs`、
ルート`Cargo.toml`の`[patch.crates-io]`追記）はこのブランチにだけ存在する。

#### 1. ファイルシステムに触る箇所の洗い出し

`copc-writer` 0.9.0（crates.io から取得した無改造の版）を読み、3箇所を確認した。

| 箇所 | 何をしていたか |
|---|---|
| `spill.rs`（`SpillWriter::create`） | `tempfile::Builder::new().prefix(...).tempfile_in(spill_dir)` で点レコードの一時ファイルを作る |
| `spill.rs`（`SpillReader::open`） | `unsafe { Mmap::map(&file) }` でファイル全体をメモリマップし、ランダムアクセス読み出しする |
| `lod.rs`（`new_index_tempfile`、`write_root_index_run`・`partition_index_run`が呼ぶ） | `tempfile::Builder::new().tempfile()`（ディレクトリ指定なし=常にOS既定の一時ディレクトリ。`spill_dir`は効かない。M4-1bで確認済みの既知の挙動）でroot/partition/order索引の一時ファイルを作る。読み出しは`File::open`で開き直し`seek` |
| `writer.rs`（`PendingOutput`） | 出力先と同じディレクトリに一時名(`tempfile::Builder::tempfile_in(parent)`)で書き、成功時だけ`persist()`でアトミックにrenameする |

#### 2. 1つのトレイトへまとめる改修

`vendor/copc-writer/src/scratch.rs`（新設）に3トレイトを定義した。

```rust
pub trait ScratchFs: Send + Sync {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>>;
    fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>>;
}
pub trait ScratchWriter: Write + Seek + Send + Sync {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>>;
    fn finish_output(self: Box<Self>) -> Result<()>;
}
pub trait ScratchReader: Send + Sync {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>>;
    fn as_bytes(&self) -> Result<Arc<dyn AsRef<[u8]> + Send + Sync>>;
}
```

`spill.rs`・`lod.rs`・`writer.rs`は`tempfile`/`memmap2`/`std::fs`を直接呼ばず、
`&dyn ScratchFs`を経由するように書き換えた。2つの実装を用意した。

- **`NativeScratchFs`**（`native-fs`フィーチャ、既定オン）: 今までどおり
  `tempfile::NamedTempFile`+`memmap2::Mmap`。**振る舞いは変えていない**
  （4節「改修前後で変換結果が同じであることの確認」参照）
- **`MemoryScratchFs`**: `Vec<u8>`だけで完結する実装。OS一時ファイルもmmapも使わない

`native-fs`を切ると`tempfile`/`memmap2`への依存自体が`Cargo.toml`から外れる
（`optional = true`）。`NativeScratchFs`本体と、それを内部で使う公開関数
（`write_source`・`write_source_with_cancel`・`write_streaming_with_cancel`・
`convert_las_to_copc_streaming*`）も`#[cfg(feature = "native-fs")]`で外れる。
**`write_copc_inner`・`write_copc_from_spill`・`build_lod_index`・
`SpillWriter`/`SpillReader`自体は`&dyn ScratchFs`を受け取るだけで、
どちらのフィーチャでも常にコンパイルされる。** 公開APIの引数は変えていない
ので`pcv-convert`側は無変更で動く（3節で確認済み）。

改修中に1点だけ、あえて単純化した箇所がある。出力ファイルの書き込みは、
元は`PendingOutput`が`NamedTempFile`を保持しつつ書き込みには`.reopen()`で
別のファイルハンドルを使っていた（元コードに理由の記載なし）。この改修では
`ScratchWriter`が書き込みと確定（`finish_output`でのrename）を1つの
オブジェクトで担う形にし、この`reopen`を無くした。最終的に生成される
バイト列が同じであることは4節で確認済み。詳細は`vendor/copc-writer/PATCH.md`
参照。

#### 3. ネイティブのテスト（振る舞いが変わっていないこと）

`cargo test --workspace`（`main`と同じ全ジョブ）はすべて緑だった。

```
$ cargo test --workspace
pcv-convert（ユニットテスト）: 41 passed
pcv-convert（統合テスト: import_e57/import_pcd/import_ply/import_to_copc/roundtrip/streaming_conversion）
  : 1+4+5+1+1+5 = 17 passed
pcv-core: 31 passed
pcv-tauri: 6 passed
合計 95 件、失敗 0（M4-4節が記録した本数と一致）
```

`vendor/`はルートの`Cargo.toml`が`exclude`しているため、`copc-writer`自身の
`#[cfg(test)]`（`spill.rs`・`lod.rs`・`writer.rs`・`scratch.rs`）は
`cargo test --workspace`には含まれない（この制約は`vendor/copc-reader`も
同じで、今回新たに生じたものではない）。**単体で実行するため、
`vendor/copc-writer/Cargo.toml`に空の`[workspace]`テーブルを足した**
（ルートのワークスペースの一部だと誤認識されてエラーになるため。
`cargo test --manifest-path vendor/copc-writer/Cargo.toml`用の変更で、
`native-fs`フィーチャの追加とは別件）。

```
$ cargo test --manifest-path vendor/copc-writer/Cargo.toml
running 19 tests
test scratch::tests::memory_temp_round_trips_bytes ... ok
test scratch::tests::memory_output_is_stored_under_final_path_only_after_finish ... ok
test scratch::tests::memory_writer_supports_seek_like_the_output_header_patch ... ok
test scratch::native::tests::temp_file_is_removed_from_disk_after_reader_is_dropped ... ok
test scratch::native::tests::unfinalized_temp_writer_is_removed_from_disk_on_drop ... ok
test scratch::native::tests::output_file_is_renamed_into_place_only_on_finish_output ... ok
test spill::tests::spill_round_trips_records_and_bounds_native ... ok
test spill::tests::spill_round_trips_records_and_bounds_memory ... ok
test spill::tests::empty_spill_finalizes_without_mapping_an_empty_file ... ok
test spill::tests::empty_spill_finalizes_without_reading_out_of_range_memory ... ok
test lod::tests::spooled_lod_index_covers_each_point_once_native ... ok
test lod::tests::spooled_lod_index_covers_each_point_once_memory ... ok
test lod::tests::dense_cluster_stays_bounded_below_giant_chunks ... ok
test lod::tests::identical_points_fail_instead_of_creating_an_unbounded_leaf ... ok
test hierarchy_pages::tests::hierarchy_plan_splits_large_root_page ... ok
test metadata::tests::（3件） ... ok
test writer::tests::direct_point_encoding_matches_las_raw_point ... ok
test result: ok. 19 passed; 0 failed
```

**受け入れ条件「そのトレイトのメモリ上の実装でネイティブのテストが通ること」**
はこれで満たしている。`spill.rs`・`lod.rs`の主要テスト（点の往復・bounds・
octree分割・深さ上限）は同じ検証関数を`NativeScratchFs`/`MemoryScratchFs`
両方に対して実行する形にした（`_native`/`_memory`サフィックスの関数対）。

`cargo fmt --all -- --check`（差分なし）・
`cargo clippy --workspace --all-targets -- -D warnings`（警告0件）・
`cargo clippy --manifest-path vendor/copc-writer/Cargo.toml --all-targets`
（警告0件）・`cargo build -p pcv-core --target wasm32-unknown-unknown`
（成功。規約1に影響なし。`pcv-core`は無変更）も確認した。

#### 4. 改修前後で変換結果が同じであることの確認

`crates/pcv-convert/examples/spike_make_las.rs`（このスパイクだけの
使い捨てヘルパー、`main`には入れない）で、xyz全軸に散らした200,000点の
合成LASを作った（1ノードしかできないと改修の検証にならないため、
octreeが複数レベル・複数ノードに分かれるようにした）。

`crates/pcv-convert/examples/convert_streaming.rs`
（`copc_writer::convert_las_to_copc_streaming`をそのまま呼ぶ既存のexample）で、
ノードあたり最大点数5000として変換した。

| | 使った`copc-writer` | 出力ファイルのSHA-256 |
|---|---|---|
| 改修前 | crates.io 0.9.0（無改造、`[patch.crates-io]`を足す前の状態で変換） | `e1944a83e792cf2a25174199eefc7f6c384b7896f44840b894b13b4af2f747e1` |
| 改修後 | `vendor/copc-writer`（`NativeScratchFs`使用、`[patch.crates-io]`適用後） | `e1944a83e792cf2a25174199eefc7f6c384b7896f44840b894b13b4af2f747e1` |

**バイト同一。** `cargo fmt`でフォーマットを直した後にもう一度変換し直し、
ハッシュが変わらないことも再確認した。あわせて
`crates/pcv-convert/examples/spike_dump_hierarchy.rs`（同じく使い捨て
ヘルパー）でhierarchyの全ノード（レベル・キー・点数）をソート済みテキストに
ダンプし、改修前後で`diff`が空であることを確認した
（42ノード、`pcv_core::CopcFile::read_node`で全ノードの実点数が
hierarchyの申告と一致することも確認済み）。**アルゴリズム本体
（octree分割・LAZ圧縮・ヘッダー/VLR配置）には一切手を入れていないことが、
出力のバイト同一性という最も強い形で裏付けられた。**

#### 5. `wasm32-unknown-unknown` でのビルド確認

**分かったこと（想定外だった）**: タスクシート冒頭・ADR-0006の記述
「`tempfile`・`memmap2`には(wasm32-unknown-unknownが)どちらも無い」は、
**「ビルドできない」という意味では誤りだった。** 実際に確かめると:

```
$ cd <crates.io から取得した無改造のcopc-writer 0.9.0のコピー>
$ cargo build --target wasm32-unknown-unknown
   ...
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 19.16s
```

**無改造のcopc-writer 0.9.0がそのままwasm32-unknown-unknown向けにビルドできた。**
原因をソースで確認した。

- `tempfile` 3.27.0: ソース中に`wasm32`という文字列が一切無い。`std::fs`・
  `std::env::temp_dir()`をそのまま呼んでいるだけで、これらは
  wasm32-unknown-unknownのlibstdにも型として存在する（ADR-0003が
  M1時点で確認済みの事実と同じ）ため、コンパイルは通る
- `memmap2` 0.9.11: `src/lib.rs`に
  `#[cfg_attr(not(any(unix, windows)), path = "stub.rs")]`があり、
  unix・windows以外(wasm32-unknown-unknownを含む)では`src/stub.rs`を使う。
  中身を読むと、`MmapInner::map`等の**全メソッドが無条件に
  `Err(io::ErrorKind::Unsupported.into())`を返すダミー実装**だった
  （`enum Never {}`という決して構築されない型を使い、到達し得ない
  メソッドは`match self.never {}`で型だけ合わせている）

つまり**「ビルドできるか」はこの2クレートに関しては判定基準にならない
（どちらも常にビルドできる）。実際に問題になるのは実行時**で、
`memmap2`はwasm32-unknown-unknown上で`Mmap::map`を呼んだ瞬間に必ず
`Unsupported`エラーになる。`tempfile`もwasm32-unknown-unknownには
実ファイルシステムが無いため、`std::fs`呼び出しは（型は存在しても）
実行時にエラーになるはずである（ここは無改造版を実際にwasm32上で
実行して確かめてはいない。ソースを読んで導いた推論であり、コンパイルが
通ることは実測済みだが、実行時エラーの発生そのものは未確認)。

この事実を踏まえて3通り試した。

```
# (a) 無改造のcopc-writer 0.9.0(比較用、上記)
$ cargo build --target wasm32-unknown-unknown          → 成功

# (b) 改修版、native-fsフィーチャ込み(既定)
$ cargo build --manifest-path vendor/copc-writer/Cargo.toml \
    --target wasm32-unknown-unknown                     → 成功
    (tempfile/memmap2ともコンパイルされる。(a)と同じ理由で成功するだけで、
     NativeScratchFsを実際にwasm32上で呼べば同じ理由で失敗するはず)

# (c) 改修版、native-fsフィーチャを切った状態(メモリ実装のみ)
$ cargo build --manifest-path vendor/copc-writer/Cargo.toml \
    --no-default-features --target wasm32-unknown-unknown → 成功
    (警告100件、すべて「未使用」。native-fs限定の公開関数を外したことで
     write_copc_inner/build_lod_index等がこの設定では呼ばれなくなるため。
     エラーは0件)
```

(c)で依存グラフを確認すると、`tempfile`・`memmap2`のどちらも現れない。

```
$ cargo tree --manifest-path vendor/copc-writer/Cargo.toml \
    --no-default-features --target wasm32-unknown-unknown | grep -i "tempfile\|memmap2"
（出力なし）
```

**結論**: 「wasm32-unknown-unknownでビルドできるか」という問いは、
(a)(b)(c)いずれも「できる」という答えになり、**このクレートに関しては
判断基準として機能しなかった。** 改修の実質的な価値は、ビルドの可否ではなく、
**`MemoryScratchFs`がOS依存のAPIを一切使わない（`Vec<u8>`・`HashMap`・
`Mutex`のみ）ため、実行時にも動く見込みがあるパスを`native-fs`頼みのパスから
切り離せたこと**にある。この判断基準の空振りは、コーディネーターが
判断表を作った時点でのADR-0006の記述（未検証の推測）が誤っていたために
起きたもので、今回のスパイクで初めて実際にビルドして確かめたことで判明した。

#### 6. 改修の規模（`git diff --stat`）

crates.ioから取得した無改造のcopc-writer 0.9.0を基準に、
`vendor/copc-writer/src`とのdiffを取った。

```
$ git diff --no-index --stat <無改造版>/src vendor/copc-writer/src
 lib.rs        |  15 +-
 lod.rs        | 122 +++--
 scratch.rs (新規) | 599 +++++++++++++++++++++
 spill.rs      | 197 +++----
 writer.rs     | 174 +++---
 5 files changed, 821 insertions(+), 286 deletions(-)
```

`hierarchy_pages.rs`・`las_out.rs`・`metadata.rs`・`source.rs`・`validate.rs`
の5ファイルは無変更。`Cargo.toml`は`native-fs`フィーチャの追加で+21行。

**合計: 842 insertions(+), 286 deletions(-)**（`git diff --stat`がそのまま
表示する値）。読み方によって2通りの数字になる。

- **純増分**(insertions−deletions): 842−286 = **556行**。500行の約1.11倍
- **変更行数の合計**(insertions+deletions、新規ファイルの599行を含む):
  842+286 = **1,128行**。500行の約2.26倍

判断表の「約500行以内」がどちらの数え方を意図しているかはタスクシートに
明記が無い。純増分(556)なら「わずかに超過」、合計(1,128)なら「大きく超過」
という、解釈によって判断表の1行目と2行目のどちらに転ぶかが変わる差になる。
**この数え方の選択はコーディネーターが行うこと。**

#### 7. OPFS についての公式資料での確認

**(1) `FileSystemSyncAccessHandle`がWorker内で同期の読み書き・シーク相当・
truncate・flushを提供すること**

- [MDN: FileSystemSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle):
  `read(buffer, { at })`・`write(buffer, { at })`・`truncate(newSize)`・
  `flush()`・`getSize()`・`close()`を持ち、すべて**同期**
  （MDN注記: 仕様の初期版では`close`/`flush`/`getSize`/`truncate`が
  誤って非同期と規定されていたが、これらをサポートする現行の全ブラウザは
  同期として実装している）。**Dedicated Worker内でしか使えない**
  （メインスレッドをブロックしないため、という理由もMDNに明記）
- [WHATWG File System Standard](https://fs.spec.whatwg.org/):
  IDLで`[Exposed=DedicatedWorker, SecureContext]`と明記。`read`/`write`は
  `FileSystemReadWriteOptions`（`unsigned long long at`）を引数に取り、
  オフセット指定の読み書き（`seek`相当）ができる
- [web.dev: The origin private file system](https://web.dev/articles/origin-private-file-system):
  同じ6メソッドを実務的に解説。「Web Workerはメインスレッドをブロックしない
  ため、この文脈でだけ同期メソッドが許される」

**(2) 対応ブラウザ**

[MDN browser-compat-data(`api/FileSystemSyncAccessHandle.json`、
2026-09-30時点のmainブランチ)](https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemSyncAccessHandle.json)
によると、インターフェース本体(`createSyncAccessHandle`が返す型自体)の
`version_added`は:

| ブラウザ | 対応バージョン |
|---|---|
| Chrome | 102 |
| Edge | Chromiumをミラー(実質102相当) |
| Firefox | 111 |
| Safari | 15.2 |
| Chrome Android | 109 |
| Firefox Android / Safari iOS | それぞれデスクトップ版をミラー |

参考: OPFS自体(`getDirectory()`等、同期アクセスハンドルを使わない基本機能)
はより早く、[web.dev](https://web.dev/articles/origin-private-file-system)
によればChrome 86から対応している。`FileSystemSyncAccessHandle`
(`createSyncAccessHandle`)はそれより後に追加された機能。

**(3) 保存容量の上限の決まり方**

[MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
によると、OPFSを含むorigin単位のストレージ(IndexedDB・Cache Storage・OPFS)
の上限は、**空き容量ではなくディスクの総容量**を基準に決まる(空き容量を
基準にするとフィンガープリンティングに使われうるため)。

| ブラウザ | best-effort(既定) | persistent(`navigator.storage.persist()`後) |
|---|---|---|
| Chrome/Chromium系 | 総容量の**60%**(originごと) | 同じく60% |
| Firefox | 総容量の**10%**とグループ(同一サイト)上限**10GiB**の小さい方 | 総容量の**50%**、上限**8TiB**。グループ上限の対象外 |
| Safari(ブラウザアプリ、macOS14+/iOS17+) | 総容量の約**60%** | 同上。全origin合計は総容量の80%まで |
| Safari(組み込み/非ブラウザアプリ) | 総容量の約**15%** | 全origin合計は総容量の20%まで |

例: 1TiBのディスクなら、Chromeは1origin最大600GiB、Firefoxは
best-effortで最大10GiB(グループ上限が先に効く)。

#### 8. 判断表への当てはめ（数値のみで機械的に。最終判断はコーディネーターが行う）

| 調査結果の項目 | 実測・確認内容 | 判定 |
|---|---|---|
| ネイティブのテストが通るか | `cargo test --workspace`(95件)・`cargo test --manifest-path vendor/copc-writer/Cargo.toml`(19件、Native/Memory両方)がすべて成功 | ○ |
| wasm32-unknown-unknownでビルドできるか | 改修版・メモリ実装のみ(`--no-default-features`)で成功(依存に`tempfile`/`memmap2`が0個であることも確認済み) | ○ |
| 改修が約500行以内に収まるか | `git diff --stat`: 842 insertions(+), 286 deletions(-)。純増分556行(500の1.11倍)・合計1,128行(500の2.26倍)。**数え方によって「わずかに超過」「大きく超過」のどちらにもなる** | △(数え方に依存。上記6節参照) |
| アルゴリズム本体に手を入れる必要があったか | 改修前後で出力COPCファイルがSHA-256で完全一致(バイト同一)。octree分割・LAZ圧縮・ヘッダー配置は無変更 | いいえ(手を入れていない) |
| OPFSで要件を満たせるか | 同期read/write(at)/truncate/flush、Dedicated Worker限定という要件をWHATWG仕様・MDNで確認。Chrome/Edge/Firefox/Safariとも対応済み。容量上限は総容量の10〜60%(ブラウザ依存)で、sofi級(数GB)のファイルは一般的な環境で収まる見込み | ○ |

**判断表の3行のうち、3行目(wasm32でビルドできない・OPFSで要件を満たせない)
には該当しない**(wasm32ビルドは成功、OPFS要件も満たす)。1行目と2行目の
どちらに該当するかは、線数の数え方(純増分556 vs 合計1,128)と、
「大きく超える」の閾値の取り方に依存するため、**このスパイク単独では
機械的に一意に決まらない**。純増分(556、500の1.11倍)を採用するなら1行目に
近く、合計(1,128、500の2.26倍)を採用するなら2行目に該当する。
**最終判断はコーディネーターが行う。**

#### 9. 確認したコマンドと結果（まとめ）

```
$ cargo test --workspace
95 passed; 0 failed（M4-4節の記録と同数）

$ cargo test --manifest-path vendor/copc-writer/Cargo.toml
19 passed; 0 failed（Native/Memory両バックエンドのテストを含む）

$ cargo fmt --all -- --check
（差分なし）

$ cargo clippy --workspace --all-targets -- -D warnings
（警告0件）

$ cargo clippy --manifest-path vendor/copc-writer/Cargo.toml --all-targets
（警告0件）

$ cargo build -p pcv-core --target wasm32-unknown-unknown
Finished（成功。規約1に影響なし）

$ cargo build --manifest-path vendor/copc-writer/Cargo.toml --target wasm32-unknown-unknown
Finished（成功。native-fs込み）

$ cargo build --manifest-path vendor/copc-writer/Cargo.toml --no-default-features --target wasm32-unknown-unknown
Finished（成功。警告100件はすべて未使用警告、エラー0件）

$ cargo tree --manifest-path vendor/copc-writer/Cargo.toml --no-default-features --target wasm32-unknown-unknown | grep -i "tempfile\|memmap2"
（出力なし。依存グラフから両クレートが消えていることを確認）

# 改修前後の変換結果の比較(spike_make_las.rsで生成した200,000点の合成LAS)
改修前 SHA-256: e1944a83e792cf2a25174199eefc7f6c384b7896f44840b894b13b4af2f747e1
改修後 SHA-256: e1944a83e792cf2a25174199eefc7f6c384b7896f44840b894b13b4af2f747e1（一致）

$ git diff --no-index --stat <crates.io版copc-writer-0.9.0>/src vendor/copc-writer/src
5 files changed, 821 insertions(+), 286 deletions(-)
```

### 範囲外にしたこと（正直に）

- **OPFSの実装そのもの**（`FileSystemSyncAccessHandle`を実際に叩く
  `ScratchFs`実装）は作っていない。M4-6bの範囲
- **`pcv-wasm`への組み込み・UI**は作っていない
- **メモリ実装をwasm32上で実際に実行する確認**はしていない
  （ビルドが通ることまでの確認。`wasm-bindgen-test`等でブラウザ/Node上で
  実行して`write_copc_inner`が最後まで動くかは未確認）
- **無改造のcopc-writer 0.9.0をwasm32上で実行し、`tempfile`/`memmap2`が
  実際に`Unsupported`エラーを返すことの実機確認**はしていない
  （ソースコードを読んで導いた推論。コンパイルが通ることだけは実測済み）
- **`copc-writer`のライセンス・依存の再確認**はしていない（ADR-0006の
  M4-1bで既に確認済みで、今回変更していない）

---

## M4-6b: 実装する（2026-09-30、Sonnet）

### 所有者の決定

M4-6aの調査結果（改修約500行、ネイティブのテスト緑、wasm32ビルド可、OPFS要件を
満たす）を受け、**所有者が2026-09-30に「実装する」と決定した。**

### やったこと

1. **`vendor/copc-writer`を`main`に取り込んだ。** `spike/m4-6`ブランチの改修
   （`ScratchFs`/`ScratchWriter`/`ScratchReader`トレイト、`NativeScratchFs`/
   `MemoryScratchFs`）をそのまま持ち込み、ルート`Cargo.toml`に
   `[patch.crates-io] copc-writer = { path = "vendor/copc-writer" }`を追加した。
   調査用の使い捨てヘルパー（`crates/pcv-convert/examples/spike_*.rs`）は
   持ってこなかった。`vendor/copc-writer/PATCH.md`をスパイク限定の書き方から
   本採用の書き方に書き直した
2. **`write_copc_from_spill_with_fs`を新規公開した**（`vendor/copc-writer/
   src/writer.rs`）。`&dyn ScratchFs`を直接渡せる入口で、`native-fs`
   フィーチャの有無に関わらず常にビルドされる。Web版がこれを使う理由は
   下記「Web版の変換の流れ」参照
3. **ネイティブの回帰テスト**を`crates/pcv-convert/tests/streaming_conversion.rs`
   に追加した（`native_output_hash_matches_recorded_value`）。x/y/z全軸に
   散らした1,000点の合成LASを`max_points_per_node=50`で変換し、出力バイト列の
   FNV-1a(64bit)ハッシュを固定値と比較する（M4-6aが手動で確認した
   「改修前後でSHA-256が一致」を自動テスト化したもの。`sha2`等の新規クレートを
   増やさないよう自前のFNV-1aにした）
4. **OPFSの`ScratchFs`実装**（`crates/pcv-wasm/src/opfs.rs`の`OpfsScratchFs`）
   を追加した。設計の要点は下記「OPFSの一時ファイルプールについて」参照
5. **Web版の変換の流れ**を実装した（`crates/pcv-wasm/src/convert.rs`の
   `WasmConverter`、`src/datasource/copc.worker.ts`・`opfs.ts`・`web.ts`・
   `web-protocol.ts`・`src/state/useCopcViewer.ts`）。詳細は下記
6. `pcv-core`には一切触れていない（規約1）。`@tauri-apps/api`のimportは
   `src/datasource/tauri.ts`のみのまま（規約2、変更なし）。`src/renderer/`は
   触れていない（規約3）

### OPFSの一時ファイルプールについて（設計判断の理由）

`copc-writer`のLOD構築（`lod.rs`の`partition_index_run`、`assign`の再帰）は、
同期呼び出しの中で`ScratchFs::create_temp`を繰り返し（データ依存で数千〜
数万回）呼ぶ。一方、OPFSで新しいファイルを開く操作
（`FileSystemDirectoryHandle.getFileHandle`・
`FileSystemFileHandle.createSyncAccessHandle`）はどちらも**非同期**
（MDN/WHATWG仕様、M4-6a 7節参照）。`create_temp`が呼ばれるたびに非同期で
新しいOPFSファイルを開くことはできない。

そこで、変換を始める前に（`src/datasource/opfs.ts`の`createScratchPool`が）
固定個数（既定`OPFS_SCRATCH_POOL_SIZE`=600、`crates/pcv-wasm/src/opfs.rs`）の
OPFSファイルを`createSyncAccessHandle()`で開いておき（非同期、1回だけ）、
`OpfsScratchFs::create_temp`はこの配列から「空いているハンドルを借りる
（truncateして0バイトに戻す）」「使い終わった（`ScratchReader`がdropされた）
ら返す」という同期操作だけで実装した。個数の見積もりは、`lod.rs`の`assign`が
兄弟ノードを深さ優先で1つずつ処理する構造（同時に「使用中」のハンドル数は
再帰の深さ×8程度に収まる。深さ上限は30だが、そこまで深くなるのは病的な
データだけ）から、安全側に倍程度の余裕を見て決めた（詳細は`opfs.rs`の
ドキュメントコメント参照）。同種の制約（OPFSの非同期ハンドル取得と、
同期I/Oを前提にしたアルゴリズムの食い違い）に対する固定プール方式は、
他のOPFS利用ライブラリ（SQLite系のOPFS VFS実装など）でも使われる一般的な
対処だが、**本セッションで外部実装のソースを確認して裏付けたわけではない**
（設計上の妥当性は上記の再帰構造の分析から独立に導いた）。

### Web版の変換の流れ

- 入力はユーザーが選んだ`File`。Worker内で既存の`FileRangeReader`
  （`FileReaderSync`+`File.slice`、ADR-0012と同じ経路）で範囲読みし、
  `las::Reader`で点を読む。ファイル全体はメモリに読まない
- **読み込みはTypeScript側からバッチ単位（64Ki点）で駆動する。**
  `WasmConverter::feed(batch_size)`を繰り返し呼び、呼び出しの合間に
  `setTimeout(resolve, 0)`でWorkerのイベントループへ制御を返す。理由は
  「キャンセルの制約」参照。読んだ点は`SpillWriter`へ直接pushする
  （`copc_writer::SpillWriter::create`/`push`/`finalize`はすべて元から
  公開済みで、M4-6a時点で改修済みの`&dyn ScratchFs`を受け取る）
- 読み込み完了後、`WasmConverter::finish()`が`write_copc_from_spill_with_fs`
  を呼び、octree構築・チャンク圧縮・出力の書き出しを1回の同期呼び出しで行う
- 出力はOPFS上の`pcv-converted/<指紋ハッシュ>.copc.laz`に直接書く
  （native版のような「一時名で書いて成功時だけrename」は行わない。
  OPFSはオリジンの非公開ストレージで、書き込み中の内容が他から見える
  心配が無いため。`opfs.rs`のドキュメント参照）。変換後、そのまま
  `WebSource`に`registerFile`して`open()`する（通常のローカルファイル
  選択と同じ経路）
- **キャンセル**: 上記「読み込みのバッチ駆動」の合間にだけ即座に効く。
  後処理段階（`finish()`の中）でのキャンセル要求は、処理が終わってから
  出力を破棄して「キャンセルされた」扱いにする（即座には止められない。
  ADR-0006の追記に理由を記録した: GitHub PagesはCOOP/COEPヘッダーを
  設定できずSharedArrayBufferが使えない）
- **進捗**: デスクトップ版（M4-3）と同じ`ConversionProgress`の形
  （`phase: "reading"`で正確な割合、`phase: "postProcessing"`で段階名だけ）
  を使い、`LayerPanel`の既存UIがそのまま流用できる（変更不要だった）
- **容量の事前確認**: `navigator.storage.estimate()`の`quota - usage`が、
  入力サイズ×11（デスクトップ版`disk_space.rs`と同じ係数、ADR-0006の実測
  sofi: 入力2.03GB→一時ファイルピーク21.864GB、比≈10.77倍を根拠にする）
  未満なら、変換を始めずに`insufficientSpace`を返す（`src/datasource/
  opfs.ts`の`requiredScratchBytes`/`hasEnoughQuota`。純粋関数でテスト済み）
- **同じファイルを二度変換しない**: ファイル名・サイズ・`lastModified`から
  作ったキー（`src/datasource/opfs.ts`の`cacheKeyFor`、FNV-1a(32bit)。
  デスクトップ版の指紋サイドカーと同じ考え方）でOPFS上のメタデータJSON
  （`pcv-converted/<キー>.meta.json`）を探し、一致すれば変換をスキップして
  そのファイルを開く
- **ダウンロード**: OPFSの中身はブラウザの外から直接取り出せないため、
  変換完了時に`URL.createObjectURL(file)`でBlob URLを作り、`LayerPanel`に
  ダウンロードボタンを出す（`src/state/useCopcViewer.ts`の`downloadReady`）
- **一時ファイルの後始末**: 成功・失敗・キャンセルのいずれでも、
  `copc.worker.ts`の`finally`ブロックで全ハンドルを閉じ、一時ファイルの
  ディレクトリ（`pcv-scratch/`）を丸ごと削除する。失敗・キャンセル時は
  出力ファイルも削除する（成功時だけ残す）
- **OPFSが使えない環境**: `WebSource.startConversion`が`isOpfsAvailable()`
  で確認し、使えなければ`{kind: "opfsUnavailable"}`を返す。`useCopcViewer.ts`
  がデスクトップ版での変換を促すメッセージを出す（`copc-header.ts`付近の
  従来の「デスクトップ版で変換してください」という案内を、この場合だけ残した）

### 実施しなかったこと（正直に）

- **GeoTIFFのみのCRS**: WKTのVLRがあればそのまま引き継ぐが、GeoTIFFキーのみの
  入力はCRSが失われる（デスクトップ版のゾーン表からのWKT合成は持ち込んでいない。
  `crates/pcv-wasm/src/write_metadata.rs`参照）
- **任意のVLR/EVLRのパススルー**: デスクトップ版（M4-3）と同じ制約
  （`write_streaming_with_cancel`系のAPIを使う設計そのものの制約）
- **実際のブラウザでの動作確認**: GUIを目視できない環境で作業したため、
  OPFSでの変換の成功・容量不足時の実際の挙動・キャンセルの反応速度は
  未確認。下記「所有者が確かめる手順」に委ねる
- **Firefoxのbest-effort容量上限（10GiB）での実際の失敗確認**:
  ADR-0006の追記に計算上の見積り（入力約900MB超で足りなくなる見込み）を
  記録したが、実機では確認していない

### 新規テスト

- `crates/pcv-convert/tests/streaming_conversion.rs`の
  `native_output_hash_matches_recorded_value`（ネイティブ、`NativeScratchFs`
  の出力ハッシュ回帰）
- `crates/pcv-wasm/tests/memory_scratch_conversion.rs`（ネイティブ、
  `MemoryScratchFs`を使い`WasmConverter`と同じ手順
  ―`SpillWriter::create`/バッチpush/`finalize`→`write_copc_from_spill_with_fs`
  ―を再現し、`pcv-core`で開けることまで確認する統合テスト）
- `src/datasource/opfs.test.ts`（純粋関数: キャッシュのキー`cacheKeyFor`・
  容量判定`hasEnoughQuota`/`requiredScratchBytes`）
- `src/datasource/web-protocol.test.ts`に追加した
  `buildConvertStartRequest`/`buildConvertCancelRequest`のテスト
  （メッセージの組み立て）

OPFSそのもの（`FileSystemSyncAccessHandle`の実際の動作）はブラウザでしか
試せないため、自動テストの対象にしていない。下記「所有者が確かめる手順」参照。

### 確認したコマンドと結果（このworktreeで実行）

```
$ cargo fmt --all -- --check
（差分なし）

$ cargo clippy --workspace --all-targets -- -D warnings
（警告・エラー無し）

$ cargo test --workspace
pcv-convert（ライブラリ）: 41 passed
pcv-convert（統合テスト）: import_e57(1) + import_pcd(4) + import_ply(5) +
  import_to_copc(1) + roundtrip(1) + streaming_conversion(6、新規1件含む) = 18 passed
pcv-core: 31 passed
pcv-tauri: 6 passed
合計 96件、失敗 0（M4-6a節が記録した95件+回帰テスト1件）

$ cargo build -p pcv-core --target wasm32-unknown-unknown
Finished（成功。規約1に影響なし、pcv-coreは無変更）

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
Finished（成功）

$ cargo test --manifest-path crates/pcv-wasm/Cargo.toml
pcv-wasm（ユニットテスト、Worker非依存部分）: 12 passed
memory_scratch_conversion: 1 passed

$ cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check
（差分なし）

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --all-targets -p pcv-wasm -- -D warnings
（pcv-wasm自身は警告0件。vendor/copc-writerの「native-fs無効時の未使用」警告は
別クレートの既知の状態で、-D warningsの対象はpcv-wasm自身のみ）

$ npm run typecheck
（出力無し、終了コード0）

$ npm run lint
（出力無し、終了コード0）

$ npm run test
Test Files  27 passed (27)
     Tests  222 passed (222)

$ npm run build
✓ 78 modules transformed.
✓ built in 445ms

$ npm run build:wasm
（成功。src/wasm/pcv-wasm/を再生成し、コミット済み生成物を更新した）
```

CI（`ci.yml`）・Pages（`pages.yml`）: 本タスクの一連のpushで
`gh run list --branch main`を確認した。run 36721674097（CI）・36721674064
（Pages）・36723051482（CI）・36723051433（Pages）はすべて成功。最新コミット
（Web変換の配線）のPages run 36727381459は成功、CI run 36727381701は
本セッション終了時点で実行中だった可能性がある。所有者は
`gh run list --branch main --limit 5`で最新状況を確認できる。

### 所有者が確かめる手順

1. **デスクトップ・Android（M4-3の回帰確認）**: 変わっていないはずだが、
   念のため生のLAS/LAZを開いて変換が今までどおり動くことを確認する
   （手順はM4-3節の「所有者が確かめる手順」と同じ）
2. **Web版: 生のLAS/LAZを開く**（WebGPU対応ブラウザ、Chrome推奨。
   `FileSystemSyncAccessHandle`はChrome 102/Firefox 111/Safari 15.2以降）
   - GitHub Pagesのサイトを開き、`<input type="file">`で拡張子`.las`/`.laz`
     （COPCでない）のファイルを選ぶ
   - 進捗（%・プログレスバー・経過時間、読み込み段階）が出て、後処理段階では
     「octreeを構築・書き出し中(割合は出せません)」に切り替わり、完了後に
     自動的に点群が表示されることを確認する
   - devtoolsのApplication→Storageタブ（Chrome）でOPFS
     （`pcv-converted/`・変換直後は一時的に`pcv-scratch/`）の中身を確認する
   - 変換完了後、「ダウンロード」ボタンで`.copc.laz`が保存できることを確認する
3. **Web版: キャンセル**
   - 生のLAS/LAZを選び、読み込み段階（進捗バーが動いている間）に
     「キャンセル」を押す。すぐに止まり、devtoolsのOPFSビューで
     `pcv-scratch/`が消えている（一時ファイルが残っていない）ことを確認する
   - 後処理段階（「octreeを構築・書き出し中」表示の間）にキャンセルを押した
     場合、処理が終わるまで待たされてから「キャンセルされました」と表示される
     ことを確認する（この段階は即座には止まらない、ADR-0006参照）
4. **Web版: 同じファイルの再変換防止**
   - 同じファイルをもう一度選び、変換が走らず（進捗表示が出ず）即座に
     開くことを確認する
5. **Web版: 容量不足**
   - devtoolsで`navigator.storage.estimate()`を実行して現在の空き容量を
     確認し、それを超えるような大きい（または`navigator.storage.estimate`
     をdevtoolsのStorage Managerで制限した状態で小さい）ファイルを選び、
     変換が始まる前にエラーバナーで知らされることを確認する
6. **Web版: OPFS非対応ブラウザでの案内**（もし手元にあれば。旧Safari等）
   - 生のLAS/LAZを選び、「デスクトップ版でCOPCに変換してください」という
     趣旨のメッセージが出ることを確認する
7. **既にCOPCのファイルは即座に開く**（Web版、従来どおり変わっていないはず）

---

## M4-6b 追記: 実機不具合「読み込み中」に進まない（2026-10-01、Sonnet）

### 症状（所有者の実機、Chrome）

Web版でLAS/LAZを選ぶと「変換を準備しています…」のまま、**「読み込み中」に
一度も進まない**。devtoolsのconsoleにアプリ由来のエラーは出ない。

### 原因（コーディネーターが特定）

`crates/pcv-wasm/src/file_reader.rs`の`FileRangeReader::read`は、呼ばれる
たびに`File.slice`→`FileReaderSync::new()`→`read_as_array_buffer`→JSから
wasmへのコピー、という重い処理を行い、**自分ではバッファを持たない**。

`las::Reader`は、LAZ圧縮された入力では`laz`クレートのエントロピー復号器
(`LasZipDecompressor`)が下位の`Read`を細かい単位で何度も呼ぶ(本セッションで
`las`クレートのソースを読んで確認: 非圧縮の生LASは`fill_into_bytes`が
バッチ全体を1回の`read_exact`で読むため影響が小さいが、**LAZ圧縮では
実測で点数の9割程度の回数`read`が呼ばれる**。下記「確認したこと」参照)。
`FileRangeReader`を直接渡すと、1回ごとに重いJS往復が走り、最初の進捗
メッセージが出る前に実質止まって見えるほど遅くなる。

COPCを開く経路(`WasmCopcFile`、ADR-0012)は1ノード分のLAZチャンクを
まとめて読むため、この問題が表に出なかった。変換の経路だけがこの問題を
持っていた(`crates/pcv-wasm/src/convert.rs`のドキュメント参照)。

### 直したこと

`crates/pcv-wasm/src/convert.rs`の`WasmConverter::new`で、`FileRangeReader`
を`std::io::BufReader`(4MiB、`READ_BUFFER_BYTES`)で包んでから
`las::Reader::new`に渡すようにした。4MiBの根拠: 読み込みは`feed(64Ki点)`
単位で駆動するため(モジュールドキュメント参照)、本アプリが対象とする
LASの点フォーマットのうち最大のもの(36バイト程度)で64Ki点 ≈ 2.36MiB。
4MiBはこれに余裕を持たせ、**1回の`feed`呼び出しがほぼ1回のバッファ補充
(=1回の重いJS往復)で収まる**ように選んだ。

`BufReader<FileRangeReader>`は`FileRangeReader`が`Seek`を実装していれば
`Seek`も自動で実装される(`std::io::BufReader`の標準実装)ため、
`las::Reader::new`が要求する`Read + Seek + Send + Sync + 'static`を
そのまま満たす。`FileRangeReader`自体・COPCを開く経路(`WasmCopcFile`)は
変更していない(コーディネーターの指示どおり、恩恵が小さいと判断し、
チャンク単位で読む経路は変えなかった)。

### 新規テスト

`crates/pcv-wasm/tests/buffered_file_reader_reduces_read_calls.rs`
(ネイティブで実行可能)。`FileRangeReader`と同じ「呼ばれるたびに重い」
性質だけを再現した疑似リーダー(`CountingReader`、メモリ上のバイト列を
ラップし下位の`read`呼び出し回数を数える)を使い、**LAZ圧縮の**合成LASを
`las::Reader`で読み切るまでの下位`read`呼び出し回数を、バッファ無し/
`BufReader`で包んだ場合の両方で測って比較する。

- バッファ無し: 20,000点に対し**18,279回**(点数の9割以上。不具合の再現)
- バッファ有り(4MiB): **5回以下**(ファイルサイズ÷バッファサイズ程度)

バッファを外す(テスト内の`wrap_in_buf_reader`を`false`に固定する)と、
このテストが実際に落ちることを手元で確認した
(`buffered_calls=18279, expected_upper_bound=5`で失敗)。

**このテストを書く過程で、最初は非圧縮の生LASで試して不具合を再現できな
かった。** `las`クレートのソース(`src/reader/las.rs`)を読むと、非圧縮の
生LASは`fill_into_bytes`がバッチ全体を1回の`read_exact`で読む実装になって
おり、バッファの有無で呼び出し回数がほとんど変わらなかった(34回程度)。
LAZ圧縮の入力(`src/reader/laz.rs`の`decompress_many`経由)に切り替えて
初めて不具合を再現できた。実際の所有者のデータがLAZ圧縮かどうかまでは
確認していないが、拡張子`.laz`は慣習的に圧縮を意味し、素朴な生LASより
LAZ圧縮の方が実務では主流なため、これが実機で踏んだ経路だと考えられる。

### 副次的に見つけて直したこと: 回帰テストの非決定性

上記の修正を確認する過程で、`crates/pcv-convert/tests/streaming_conversion.rs`
の`native_output_hash_matches_recorded_value`(M4-6bの最初の実施記録で追加した
回帰テスト)が、**実行する日によって失敗する**不具合を見つけた。

原因: テストが使う合成LAS(`write_synthetic_las_scattered_in_3d`)が作成日時
(`las::Builder.date`)を設定しておらず、`copc-writer`の
`CopcWriteMetadata::to_output()`が未設定のcreation_dateを**実行時の今日の
日付**で埋める(`vendor/copc-writer/src/metadata.rs`の`current_utc_date()`)
ため、出力バイト列(ひいてはハッシュ)が実行する日によって変わっていた。
2026-09-30に記録した期待値が、本セッション中に日付が2026-10-01へ変わった
ことで実際に食い違い、`cargo test --workspace`が失敗した。

直し方: `write_synthetic_las_scattered_in_3d`で`builder.date`を固定の日付
(2026-01-01)に設定し、期待ハッシュを新しい値(`0x1835_0A7E_294F_68C3`)に
更新した。`chrono`を`pcv-convert`の`[dev-dependencies]`に追加したが、
`las`/`copc-writer`経由で既に依存グラフに入っているため、ワークスペース
全体では新規クレートは増えない。

### 確認したコマンドと結果

```
$ cargo test --manifest-path crates/pcv-wasm/Cargo.toml --test buffered_file_reader_reduces_read_calls
test buffering_drastically_reduces_underlying_read_calls ... ok

$ cargo test --workspace
合計96件、失敗0

$ cargo test -p pcv-convert --test streaming_conversion native_output_hash_matches_recorded_value
（日付を固定した後、同じ日に2回連続実行していずれもokを確認した。
翌日以降も安定するかは理屈のうえでは保証されるが、実際に日をまたいで
再実行して確認したわけではない）

$ cargo fmt --all -- --check
（差分なし）

$ cargo clippy --workspace --all-targets -- -D warnings
（警告・エラー無し）

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
Finished（成功）

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --all-targets -- -D warnings
（pcv-wasm自身は警告0件。vendor/copc-writerの既知の警告のみ）

$ npm run build:wasm
（成功。src/wasm/pcv-wasm/pcv_wasm_bg.wasmを再生成しコミットした。
.js/.d.tsは内容に変化無し=新しいexportは増えていない）

$ npm run typecheck / npm run lint / npm run test / npm run build
すべて成功（出力無しまたは期待どおりの成功メッセージ）
```

CIとPagesのrun idは、所有者への報告（本タスクの最終報告）に記載する。

### 正直に: 確認できていないこと

**ブラウザでの実際の動作確認はできない環境のため、「直った」とは断言しない。**
テスト(`buffered_file_reader_reduces_read_calls`)は「下位の`read`呼び出し
回数が劇的に減る」ことまでしか確認しておらず、実際のブラウザでの
`File.slice`+`FileReaderSync`往復1回あたりの実時間(所有者が報告した
「止まって見える」体感)がどれだけ改善するかは測っていない。
**所有者が実機(Chrome)で、実際にLAS/LAZを選んで読み込み中の進捗バーが
動き出すことを確かめてほしい。** 動き出すまでの時間が依然として長い場合は、
`READ_BUFFER_BYTES`(4MiB)をさらに増やす、または`feed`の呼び出し単位
(`CONVERT_BATCH_SIZE`、`src/datasource/copc.worker.ts`)を調整する余地がある。

---

## M4-6b 追記2: 実機不具合「変換に失敗しました: createSyncAccessHandle」（2026-10-01、Sonnet）

### 症状（所有者の実機、Chrome）

上記の読み込みバッファの修正は効いたが、今度は変換が失敗として画面に出た。

```
変換に失敗しました: Failed to execute 'createSyncAccessHandle' on
'FileSystemFileHandle': Access Handles cannot be created if there is
another open Access Handle or Writable stream associated with the same file.
```

### 原因（コーディネーターがコードで特定）

`src/datasource/opfs.ts`の`createScratchPool`に2つの不具合があった。

1. **一時ファイルの名前が毎回同じ**（固定ディレクトリ`"pcv-scratch"`に
   `scratch-0`〜`scratch-{poolSize-1}`）。別のタブのWorkerや、前の版で
   「準備中」のまま止まった変換がハンドルを握っていると、新しい変換が
   同じ名前のファイルを開こうとして衝突する
2. **途中で失敗すると、開いたハンドルが漏れる**。`for`ループの途中で
   `createSyncAccessHandle`が投げると、それまでに開いたハンドルが
   `handles`配列ごと呼び出し元へ返らず、`copc.worker.ts`の
   `scratchHandles`は空のままになる。`finally`の`closeHandles(scratchHandles)`
   に渡らないので**閉じられない**。そのページを開き直すまで、以後の変換が
   同じエラーで失敗し続ける

### 直したこと

1. **変換ごとに一意な一時ディレクトリ**を使う
   (`${SCRATCH_DIR_PREFIX}<crypto.randomUUID()>`、`src/datasource/opfs.ts`)。
   後始末はそのディレクトリ名(`createScratchPool`の戻り値)だけを消す
   (`copc.worker.ts`の`scratchDirName`)
2. **ハンドルを開くループを`openHandlePool`という汎用関数に切り出し、
   途中で失敗したらそれまでに開いたハンドルを閉じてから投げ直す**ように
   した。OPFSへの依存をこの関数自体から切り離してある(`createOne`/
   `closeOne`を引数で受け取るだけ)ので、ブラウザ無しでテストできる。
   `createScratchPool`自身も、`openHandlePool`が失敗したら自分が作った
   一時ディレクトリを自分で消すようにした(次回の掃除任せにしない)
3. **複数タブでの同時変換をWeb Locks API(`navigator.locks`)で防ぐ**
   (`opfs.withConversionLock`、`copc.worker.ts`の`handleConvertStart`)。
   `{ifAvailable: true}`でロックを試み、取れなければ`callback`
   (実際の変換、`runConversion`)を一切呼ばずに「別のタブで変換中です」と
   知らせる。取れればロックは`callback`が返すPromiseが解決・拒否される
   まで持つ(`navigator.locks.request`の仕様どおりで、成功・失敗・
   キャンセルのいずれでもロックは変換の終了まで持たれる)
4. **古い一時ディレクトリの掃除**(`opfs.cleanupStaleScratchDirs`)を、
   ロックを取った直後・実際の変換を始める前に試みる。新しい命名規則の
   ディレクトリ(`isScratchDirName`で判定)に加え、前の版が使っていた
   固定名`"pcv-scratch"`も掃除の対象に含めた。**使用中(他のタブが変換中)の
   ものは`removeEntry`が失敗するので、その失敗は無視する**(そのタブの
   変換を妨げない)。ロックの中で呼ぶことで、「掃除の最中に別のタブが
   ちょうど新しいディレクトリを作り始めた直後(まだハンドルを開く前)」
   というすり抜けの窓を無くしている(ロックを取っている間は他のタブが
   `createScratchPool`を同時に始められないため)

出力ファイル(`createOutputHandle`)は1個しか開かないため、途中で失敗しても
「それまでに開いたハンドル」は無い(`getFileHandle`自体はファイルの参照を
得るだけで、実際のハンドルは`createSyncAccessHandle`が返すため、それが
失敗すれば何も残らない)。漏れの心配は無いことをコードを読んで確認した。

### 新規テスト

`src/datasource/opfs.test.ts`に追加(9件、ブラウザ無しで実行可能)。

- `openHandlePool`: 全部成功する場合・**N個目で失敗する偽物を注入し、
  それまでに作ったハンドルがすべて閉じられ、エラーがそのまま再送出される
  こと**を確認(受け入れ条件どおり)。後始末(`closeOne`)自体が失敗しても
  残りを閉じ続けることも確認
- `withConversionLock`: 偽の`LockManagerLike`(`navigator.locks`と同じ形の
  インターフェース、`request`をテスト側で注入する)を使い、ロックが
  取れれば`callback`を実行しその結果を返すこと、**取れなければ`callback`を
  一切呼ばずbusyを返すこと**、`callback`が失敗したらそのまま再送出される
  ことを確認
- `isScratchDirName`: 新しい命名・旧固定名の両方を掃除対象と認識し、
  無関係な名前(`pcv-converted`等)は対象にしないことを確認

### 確認したコマンドと結果

```
$ npx tsc --noEmit
（出力無し、終了コード0）

$ npx eslint .
（出力無し、終了コード0）

$ npx vitest run
Test Files  27 passed (27)
     Tests  231 passed (231)（M4-6b追記1時点の222件+今回の9件）

$ npm run build
✓ 78 modules transformed.
✓ built in 505ms

$ cargo fmt --all -- --check / cargo clippy --workspace --all-targets -- -D warnings / cargo test --workspace
（Rust側は今回のコミットで変更していないが、回帰確認のため再実行した。
差分なし・警告0件・96件成功、いずれも変更無し）

$ cargo build -p pcv-core --target wasm32-unknown-unknown
$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
どちらも成功（Rust側は無変更なのでwasm-bindgen生成物の再生成は不要と判断した）
```

CIとPagesのrun idは、所有者への報告（本タスクの最終報告）に記載する。

### 正直に: 確認できていないこと

**ブラウザでの実際の動作確認はできない環境のため、「直った」とは断言しない。**
特に以下は理屈のうえでの裏付けはあるが、実機では確かめていない。

- 複数タブで実際に同時にLAS/LAZを選んだとき、2つ目のタブが本当に
  「別のタブで変換中です」と出て、1つ目が正常に完了すること
- 掃除(`cleanupStaleScratchDirs`)が、実際にタブを強制終了した後の残骸
  (閉じ忘れたハンドルを伴わない、純粋にディレクトリだけが残るケース)を
  正しく消せること
- `navigator.locks`がWorker内から実際に呼べること(仕様上はDedicated
  Workerでも`WorkerNavigator.locks`として使えるはずだが、実際にこの
  アプリのWorker内で呼び出して確認してはいない)

### 所有者が確かめる手順（追加分）

1. **基本の変換**: 生のLAS/LAZを1つ選び、以前のエラー
   （`createSyncAccessHandle`...）が出ずに変換が完了することを確認する
2. **複数タブでの同時変換**: 同じサイトを2つのタブで開き、ほぼ同時に
   それぞれで別の生LAS/LAZを選ぶ。片方が変換を始め、もう片方には
   「別のタブ(またはウィンドウ)で変換が進行中です」という趣旨の
   エラーバナーが出て、変換が始まらないことを確認する。1つ目のタブの
   変換が終わった後、2つ目のタブで改めて変換すると今度は成功することを
   確認する
3. **タブを閉じた後の掃除**: 変換の途中（読み込み中）でタブを閉じ、
   新しいタブで同じサイトを開いて別のファイルを変換する。
   devtoolsのApplication→Storageタブで、閉じる前のタブが使っていた
   一時ディレクトリ（`pcv-scratch-...`）が残っていないこと
   （新しい変換の開始時に掃除されるはず）を確認する
4. **以前の固定名ディレクトリの掃除**: もし以前のバージョンで変換を試して
   `pcv-scratch`という固定名のディレクトリがOPFSに残っている場合、
   新しいバージョンで何か1つ変換すると、そのディレクトリも消えている
   ことを確認する

---

## M4-6 追記3: 実機不具合「数千万点でunreachable」の調査と修正(2026-10-01〜02、Sonnet)

### 症状(所有者の実機、Chrome、数千万点の入力)

```
変換に失敗しました: unreachable
```

### 原因(コーディネーターがコードで確認済み)

`crates/pcv-wasm/src/opfs.rs`の`OpfsTempReader::as_bytes`(当時)は、
一時ファイル(spill。1点あたり50〜60バイト程度)の中身を`vec![0u8; len]`
へ**丸ごと**読み込んでいた。`copc-writer`本体はもともと一時ファイルを
`memmap2`でメモリマップし「ファイル全体を1つのスライス」として扱う
作りで、M4-6aの`ScratchReader::as_bytes`はその形をそのまま引き継いだ
API(`Result<Arc<dyn AsRef<[u8]>>>`)だった。ネイティブではメモリマップ
なのでOSが必要な部分だけ載せるが、OPFSにはメモリマップが無いため、
**一時ファイルを丸ごとメモリに載せる**ことでしかこの契約を満たせなかった。

数千万点では一時ファイルが数GBになり、wasm32のメモリ上限(実務上4GiB
未満)を超えて確保が失敗し、wasmが`unreachable`で止まっていた(メモリ
確保の失敗はpanicメッセージを出さない仕組みのため、`init_panic_hook`が
あっても何も出ていなかった)。

これはM4-1で退けた「メモリが点数に比例する」問題が、Web版で形を変えて
戻ってきたものである。**M4-6aの調査は改修前後の出力ファイルのバイト同一性
だけを確認基準にしており、読み込み中にどれだけのメモリを同時に保持するか
(メモリの使い方)は検証していなかった。** `as_bytes`というAPIの形自体が
「ファイル全体を1つのスライスとして返す」契約である以上、mmapを持たない
OPFSに対しては原理的に全体読み込み以外の実装のしようがなく、この構造的な
問題はM4-6b(OPFS実装を実際に書いた段階)でも出力一致の確認だけでは
見つからなかった。「出力が一致する」ことと「メモリの使い方が妥当である」
ことは別の軸であり、前者だけを確認基準にしたことが、この不具合を最後まで
見つけられなかった理由である。

### 直したこと

1. **`copc-writer`(`vendor/copc-writer`)の一時ファイルの読み方を、
   「全体のスライス」から「必要な範囲を読む」に変えた。**
   `ScratchReader`から`as_bytes`を廃止し、`read_at(offset, buf)`
   (範囲読み)と`len()`を追加した。`as_bytes`の唯一の呼び出し元だった
   `spill.rs`(`SpillReader`)は、`xyz_at`が24バイト(x/y/z)、
   `record_into`がレコード幅ぶんだけを、その都度`read_at`で読む形に
   変えた。`lod.rs`は元々`open_at`(逐次読み出し)しか使っておらず無変更。
   **アルゴリズム本体(octreeの分割・間引き・書き出しの順序)は変えていない**
   (`vendor/copc-writer/PATCH.md`の「M4-6 追記」に詳細を記録した)
2. **ネイティブの既定実装(`NativeScratchFs`)は、範囲読みをmmap上の
   スライスを範囲ぶんだけコピーする形で実装した**(性能特性は変えて
   いない)。**ネイティブの出力がバイト単位で変わらないことは、既存の
   回帰テスト(`crates/pcv-convert/tests/streaming_conversion.rs`の
   `native_output_hash_matches_recorded_value`)で確認した**(引き続き成功)
3. **OPFSの実装(`crates/pcv-wasm/src/opfs.rs`)の範囲読みは
   `FileSystemSyncAccessHandle::read`(`at`指定)で行い、ファイル全体を
   読み込まない。** 頻繁な小さい読み(1レコード=数十バイトごとのJS往復)が
   遅くなる懸念に対しては、64KiBブロック×最大64個(合計4MiB固定。
   点数・ファイルサイズによらず一定の上限)のLRUブロックキャッシュ
   (`ReadCache`)を追加した
4. **`init_panic_hook`が変換用のWorkerで呼ばれているかを確認した。**
   `crates/pcv-wasm/src/lib.rs`で`#[wasm_bindgen(start)]`が付いており、
   `init()`解決時にwasm-bindgenの生成コードが既に自動で1回呼んでいた
   (`src/datasource/copc.worker.ts`の`ensureWasmReady`は変換・COPC読込
   どちらの前にも`init()`を待つため)。この自動呼び出しはRust側の属性に
   依存しており.tsファイルだけを読んでも分からないため、
   `ensureWasmReady`で明示的にもう一度呼ぶようにした(`set_hook`の
   重複呼び出しに副作用は無い)。
   あわせて、**メモリ確保の失敗のときに「メモリ不足」と分かるメッセージを
   出す`#[global_allocator]`を追加した**(`crates/pcv-wasm/src/alloc_guard.rs`、
   新規)。`std::alloc::System`を薄くラップし、確保失敗(null)を検知した
   瞬間に`web_sys::console::error_1`でメッセージを出す
   (`#[alloc_error_handler]`はnightly限定の不安定機能でこのプロジェクトの
   stableツールチェーンでは使えないため、この形にした)。今後また`unreachable`
   で落ちることがあれば、このメッセージの有無でメモリ不足かどうかの
   当たりを付けられる

### 新規テスト

`vendor/copc-writer/tests/scratch_read_is_bounded.rs`(ネイティブで実行)。
`MemoryScratchFs`/`ScratchReader`を薄くラップし、`read_at`・`open_at`
(`Read::read`)に渡された1回あたりの読み取りバッファの最大サイズを記録する
トラッキング層(`TrackingScratchFs`等)を用意した。200万点の合成入力を
`write_copc_from_spill_with_fs`で最後まで変換し、記録された最大値が
固定の上限(2MiB)に収まる(=一度にメモリに持つ一時ファイルの量が点数に
比例しない)ことを確認する。`as_bytes`相当の全体読み込みが復活すれば、
200万点では数千万バイト規模になり、このテストが落ちる。

他に`crates/pcv-wasm/src/opfs.rs`の`ReadCache`(ブロックキャッシュの
LRU追い出しロジック)自体の単体テスト3件も追加した(ネイティブで実行可能。
OPFS自体に触れない純粋なRustのロジックのため)。

### 確認したコマンドと結果

```
$ cargo test --manifest-path vendor/copc-writer/Cargo.toml
20 passed; 0 failed(既存19件+新規の scratch_read_is_bounded 1件)

$ cargo test --workspace
native_output_hash_matches_recorded_valueを含め全テスト成功(96件、無変更)

$ cargo test --manifest-path crates/pcv-wasm/Cargo.toml
ユニット15件(新規のReadCache単体テスト3件含む)+統合2件、すべて成功

$ cargo clippy --workspace --all-targets -- -D warnings
警告・エラー無し

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --all-targets -p pcv-wasm -- -D warnings
pcv-wasm自身は警告0件(ネイティブ・wasm32ターゲットどちらでも確認)

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
成功

$ cargo fmt --all -- --check
$ cargo fmt --manifest-path vendor/copc-writer/Cargo.toml -- --check
$ cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check
いずれも差分無し
（vendor/copc-writer/src/lib.rsのpub use並びは、このセッションでは
触れていない箇所だがrustfmt 1.9.0が「要フォーマット」と判定したため、
意味の変わらないフォーマットのみの変更を別コミットで当てた。ツール
チェーンのバージョン差による可能性がある）

$ npm run build:wasm
成功(src/wasm/pcv-wasm/を再生成し、コミット済み生成物を更新した。
pcv_wasm_bg.wasmは797,563→798,692バイト)

$ npm run typecheck / lint / test / build
いずれも成功(testは27ファイル231件、無変更)
```

CIとPagesのrun idは、所有者への報告(本タスクの最終報告)に記載する。

### 並行作業との分担

別のセッションが「入力のLAZの展開の並列化」を担当していた
(`crates/pcv-convert/src/streaming.rs`・`crates/pcv-wasm/src/convert.rs`の
`feed`・`src/datasource/copc.worker.ts`のWorker構成)。本修正は
`vendor/copc-writer/`・`crates/pcv-wasm/src/opfs.rs`・`crates/pcv-wasm/src/
alloc_guard.rs`(新規)・`crates/pcv-wasm/src/lib.rs`(panic hookのドキュメント
のみ)・`src/datasource/copc.worker.ts`(panic hookの明示呼び出しのみ)に
限定し、`convert.rs`の入力側(`feed`)や`copc.worker.ts`の変換の流れ本体には
触れていない。

### 正直に: 確認できていないこと

**ブラウザでの実際の動作確認はできない環境のため、「直った」とは断言
しない。** 特に以下は理屈のうえでの裏付けはあるが、実機では確かめていない。

- 実際に数千万点のLAS/LAZをWeb版で変換し、`unreachable`が出ずに完了すること
- OPFSのブロックキャッシュ(64KiB×64個)が、実際のブラウザで
  `FileSystemSyncAccessHandle::read`のJS往復コストをどの程度減らすか
  (体感できるほどの速度改善があるか)
- `#[global_allocator]`で追加したメッセージが、実際のChrome devtoolsの
  consoleに表示されること

### 所有者が確かめる手順

1. **数千万点のLAS/LAZをWeb版で変換する**(今回の不具合の再現条件)。
   「変換に失敗しました: unreachable」が出ずに変換が完了することを確認する
2. もし依然として`unreachable`が出る場合は、devtoolsのconsoleに
   「pcv-wasm: メモリの確保に失敗しました。入力が大きすぎて、ブラウザの
   メモリ上限(wasm32は最大4GiB)を超えた可能性があります。」という
   メッセージが出ているか確認する(出ていれば、別の箇所にまだ点数に比例
   する確保が残っている可能性がある。出ていなければ、メモリ以外の原因を
   疑う)
3. 変換が完了したCOPCファイルが、今までどおり正しく表示されることを
   確認する(M4-6b節の「所有者が確かめる手順」と同じ)
4. **デスクトップ・Android(回帰確認)**: 変わっていないはずだが、念のため
   生のLAS/LAZを開いて変換が今までどおり動くことを確認する

---

## M4-6 追記4: 実機不具合「準備中のまま落ちる」の調査と対応(社内ではM4-11と呼んだ、2026-10-04、Sonnet)

### 症状(所有者の実機、Android(Chrome)・iPhone 17e(Safari)の両方)

LAS/LAZの変換を始めると「変換を準備しています…」で止まり、**そのあと
落ちる**(タブが落ちる・再読み込みされる類いと見られるが、どこで何が
起きているか所有者にも分からない状態だった)。

### コーディネーターの見立て(3つの候補)

「準備」の段階(最初の進捗が出る前)にやっていることのうち、スマホで
重いもの:

1. OPFSの一時ファイルのハンドルを約600個まとめて開く
   (`opfsScratchPoolSize()`と`createScratchPool`)
2. 展開用のWorkerを複数起動する(M4-7)。Workerごとにwasmモジュールを
   読み込みインスタンス化する
3. その他(Web Locksの取得、古い一時ディレクトリの掃除、`WasmConverter::new`)

**実機で確認できないため、「直った」とは断言しない。** 以下は上記3点
すべてに対処した内容と、その根拠(調査結果)である。

### 1. 準備の各ステップを画面に出す(対応済み)

`src/datasource/copc.worker.ts`の`reportPreparing`が、准備の各ステップ
(ロックの取得・古い一時ディレクトリの掃除・一時ファイルを開く(何個中
何個目か)・出力ファイルを開く・ヘッダーの読み込み・展開用Workerの起動
(何個中何個目か))を`ConversionProgressDto`の新しい`preparing`フェーズ
として送る(デスクトップ・Android側のRust実装はこのフェーズを送らない。
Web版だけの拡張)。`src/ui/shell/LayerPanel.tsx`の`preparingStepLabel`が
「変換を準備しています…」の代わりにステップ名を表示する。

**目的は「直すこと」単独ではなく、次に落ちたときにどこで止まったかを
所有者が報告できるようにすること。** 下記「所有者が確かめる手順」参照。

### 2. OPFS一時ファイルプールの大きさを実測に基づいて減らす

#### 調査: 同時に開く一時ファイルの最大数

Web版は`copc-writer`を`parallel-lod`フィーチャ無し(逐次)でビルドしている
(`crates/pcv-wasm/Cargo.toml`の`copc-writer`依存は`default-features =
false`。`rayon`はwasm32で使えないため)。`vendor/copc-writer/src/lod.rs`の
逐次版`assign`(読むだけで変更はしていない。`vendor/copc-writer/`は並行
作業中の別エージェントの担当のため)を読むと、ある時点で開いている一時
ファイルは次の3種類に限られる:

1. 現在処理中のノードに至る**祖先**それぞれの`run.reader`(Rustの所有権
   どおり、`assign`が値として受け取った`run`はその呼び出しがreturnする
   まで保持され続ける)
2. 祖先の各レベルで`partition_index_run`が返した最大8個の子のうち、
   **まだ再帰していない兄弟**(そのレベルの`assign`が終わるまで保持)
3. 現在のレベルで`partition_index_run`が新しく開いている**最大8個の
   書き込み中パーティション**(1回の線形スキャンの間、データ次第で
   8オクタント全部が同時に書き込み中になりうる)

これに全体を通して開いたままの`order`書き込み用一時ファイル1個を加えると、
深さ`D`まで降りた時点のピークの**理論上の上限は`8*(D+1)+1`**になる。
`copc-writer`の深さの上限は30(`lod.rs`の`MAX_OCTREE_DEPTH`。そこまで
深くなるのは同一座標の点が大量に重なるような病的なデータだけ)なので、
`D=30`を代入すると**249**。

この理論値を、8分木がちょうど指定した深さまでフル分岐する人工データ
(`crates/pcv-wasm/tests/sequential_lod_open_files_bounded.rs`、新設。
`vendor/copc-writer`には触れず、公開API`MemoryScratchFs`経由で測る)で
実測して裏付けた:

| 深さ | 0 | 1 | 2 | 3 | 5 | 8 | 12 | 16 |
|---|---|---|---|---|---|---|---|---|
| 実測ピーク | 5 | 11 | 19 | 26 | 40 | 61 | 89 | 117 |
| 理論上限(`8*(D+1)+1`) | 9 | 17 | 25 | 33 | 49 | 73 | 105 | 137 |

実測はおおよそ`7*深さ+5`で、理論上限を常に下回る(余裕がある側に外れている
ことを実測で確認した。旧実装の「深さ上限30×8+予備」という見積もりは、
この調査の理論値(249)と桁は同じだが根拠(なぜ×8なのか)を明記していな
かったため、本タスクで再導出した)。

#### 決定: プールの大きさを600→256へ

`crates/pcv-wasm/src/opfs.rs`の`OPFS_SCRATCH_POOL_SIZE`を、理論値249に
約3割の余裕を見て**256**にした(旧実装は600。約2.3倍の削減)。所有者の
実機で「準備中」に時間がかかっていた一因(600個のOPFSハンドルを`await`
しながら順番に開く)を減らすのがねらい。

**プールを使い切った場合は、黙って壊れたファイルを作るのではなく分かる
エラーを返す**(受け入れ条件)。既存の`create_temp`のエラーメッセージ
(`OPFS一時ファイルの枠(N個)を使い切りました...`)を`take_free_pool_slot`
という、`FileSystemSyncAccessHandle`に一切触れない純粋な関数として切り出し、
ネイティブの`cargo test`で「空のプールから借りようとしたらエラーになり、
プールサイズと要求元のラベルがメッセージに含まれること」を確認した
(`crates/pcv-wasm/src/opfs.rs`の`#[cfg(test)]`)。

### 3. 展開用Workerの数をモバイルで抑える

#### 調査で分かったこと(当初の見立てより大きいコストだった)

コーディネーターの見立ては「Workerごとにwasmモジュールを読み込み
インスタンス化する」という固定コストだったが、`crates/pcv-wasm/src/
convert.rs`の`decompress_point_range`を読むと、**各展開Workerは担当する
点範囲「全体」のシリアライズ済みレコードを`Vec<u8>`としてメモリに
貯めてから`postMessage`で返す**設計だった
(`out = Vec::with_capacity(to_read * record_width)`)。1点あたり約
43〜57バイト(`vendor/copc-writer/tests/scratch_read_is_bounded.rs`の
実測値を参照。`copc_core::serialize_le`の幅は`spill`のレコード幅と同じ)。

つまり、数千万点の入力を例えば2分割しただけでも、1Workerあたり数百MB〜
1GB超のバッファになりうる。これは「Workerの数だけ固定コストがかかる」
話ではなく、**Workerの数を増やすほど1個あたりの負担は減るが、合計の
ピークは点数にほぼ比例して残る**という点で、M4-1が一度退けた「メモリが
点数に比例する」問題がまた別の場所(展開Workerの出力バッファ)で形を
変えて出ていたことになる。

#### 決定: モバイルでは追加のWorkerを立てない(MAX_DECOMPRESS_WORKERS_MOBILE=1)

`src/datasource/decompress-partition.ts`の`decompressWorkerCountFor`に
`isMobile`を追加し、モバイルでは`MAX_DECOMPRESS_WORKERS_MOBILE`(=**1**)
で頭打ちにした。`decompressWorkerCountFor`が1を返すと、呼び出し側
(`copc.worker.ts`)は既存の「追加Workerを一切立てず、変換用Worker自身の
`feed`で逐次に展開する」経路にそのままフォールバックする設計になっていた
ため、**値を1にするだけで「Workerを1つも追加で立てない」という選択肢を
選んだことになる**(新しい分岐を増やさずに済んだ)。

1〜2の間で迷ったが、上記の調査(展開Workerのメモリコストが点数に比例し、
固定コストより大きい)を踏まえ、**最も保守的な1を選んだ**。実機で
クラッシュしなくなったことを確認できれば、2以上へ緩める余地を残す値として
コメントに理由を書いてある(`decompress-partition.ts`参照)。

`isMobile`は`device-profile.ts`の`isMobileDevice`(タッチ主体の判定=
`matchMedia("(pointer: coarse)")`、または`navigator.deviceMemory`が
4GiB以下)をメインスレッド(`useCopcViewer.ts`が既に持つ
`deviceProfileDefaults.isMobile`)で求め、`ConvertStartRequest`で
Workerへ渡す(Worker内には`matchMedia`が無くタッチUIの判定ができない
ため、Worker内で再判定できない。`navigator.deviceMemory`が無いSafariでは
`isMobileDevice`がタッチ主体の判定だけでモバイル扱いになる。
`device-profile.ts`の既存のフォールバック設計どおり)。

### 4. メモリの使い方の目安(推定、一部は静的に測定)

実機のブラウザでの計測はできないため、以下は**推定、または静的な
測定**であり、実行時のヒープ使用量の実測ではない。

- **wasmモジュールの初期メモリ**: `src/wasm/pcv-wasm/pcv_wasm_bg.wasm`の
  バイナリを直接パースして確認した(Node.jsで、`WebAssembly.instantiate`
  せずにメモリセクション(section id 5)を読んだ)。**初期17ページ=
  1,114,112バイト(1.06 MiB)、上限指定なし**(`flags=0`。成長は
  wasm32の実務上の上限である約4GiBまで可能)。これは「Workerを1個
  起動した直後、まだ何も変換していない時点」のベースラインであり、
  実際の使用量はここから各種バッファ(下記)ぶん増える
- **変換用Worker1個あたりの固定バッファ**: `READ_BUFFER_BYTES`(4MiB、
  `BufReader`)+OPFSの`ReadCache`(4MiB固定、後処理段階でのみ使う)
  ≈ 8MiB程度(ベースライン1.06MiBに加えて)
- **展開用Worker1個あたりのバッファ**: 固定分(`READ_BUFFER_BYTES`
  4MiB)に加え、上記3節で判明した**担当点数に比例する出力バッファ**
  (1点あたり約43〜57バイト)。モバイルでは本タスクの対応により
  このWorker自体を追加で立てない設定にした

### 確認したコマンドと結果

```
$ cargo test --manifest-path crates/pcv-wasm/Cargo.toml
19 passed(opfs::testsの新規2件を含む。unittests)
2 passed(sequential_lod_open_files_bounded、新規)
1 passed(memory_scratch_conversion)
1 passed(buffered_file_reader_reduces_read_calls)
2 passed(convert::tests、既存)

$ cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check
(差分無し)

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --all-targets -- -D warnings
(pcv-wasm自身は警告0件。vendor/copc-writerの既知の警告のみ)

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
Finished(成功)

$ cargo fmt --all -- --check
$ cargo clippy --workspace --all-targets -- -D warnings
$ cargo test --workspace --release
いずれも差分無し・警告0件・成功(vendor/copc-writer・crates/pcv-convertは
無変更)

$ npm run build:wasm
成功(pcv_wasm_bg.wasmを再生成しコミット。808,094→808,186バイト。
.js/.d.tsに差分無し=API面の変更無し)

$ npx tsc --noEmit / npx eslint . / npx vitest run / npm run build
すべて成功(testは29ファイル256件)
```

CI・Pagesのrun idは所有者への最終報告に記載する。

### 並行作業との分担

`vendor/copc-writer/`・`crates/pcv-convert/`には触れていない(並行作業中の
別エージェントが後処理の圧縮の並列化・PCDテストデータ作りを担当している
ため。調べるために読んだだけ)。所有者の別セッションのui-forge
(`src/ui/shell/Dock*`)にも触れていない。

### 正直に: 確認できていないこと

**ブラウザでの実際の動作確認はできない環境のため、「直った」とは断言
しない。** 特に以下は理屈のうえでの裏付けはあるが、実機では確かめていない。

- 今回の3つの対応(プール256個への削減・モバイルでの展開Worker抑制・
  準備段階の進捗表示)で、実際にクラッシュが解消するか
- `preparing`フェーズの各ステップが、実際のAndroid(Chrome)・iPhone
  (Safari)で意図どおりの頻度・タイミングで表示されるか
- wasmモジュールの初期メモリ(1.06MiB)以外の、実行時の実際のヒープ
  使用量(mallocされた総量。今回は静的な測定・推定のみ)

### 所有者が確かめる手順

1. **準備段階の表示**: スマホ(Android/Chrome、iPhone 17e/Safari)で生の
   LAS/LAZを選び、「変換を準備しています…」の代わりに、ステップ名
   (「変換のロックを取得しています…」→「古い一時ファイルを掃除して
   います…」→「一時ファイルを開いています(i/256)…」→「出力ファイルを
   開いています…」→「ヘッダーを読み込んでいます…」→(大きい入力かつ
   複数コアのデスクトップ相当でなければ出ないはず)→「読み込み中:
   x/y点」)が順に表示されることを確認する
2. **再発時の報告のお願い**: もし依然として落ちる場合、**最後に画面に
   表示されていたステップ名(上記のどれか)を教えてほしい。** どの
   ステップで止まったかが分かれば、残り2つの候補(OPFS・展開Worker)の
   どちらが原因か、あるいは全く別の原因かを絞り込める
3. **基本の変換が今までどおり動くこと**: 生のLAS/LAZを選び、変換が完了し
   結果が表示されることを確認する(今までの手順と同じ)
4. **デスクトップ・Android(回帰確認)**: 変わっていないはずだが、念のため
   生のLAS/LAZを開いて変換が今までどおり動くことを確認する

### 関連: Web版でPCDを開くと「空き容量が足りません」と出る不具合(別件、2026-10-04)

同じセッションで、所有者からもう一件(Web版でPCDを開くと容量不足と誤判定される
不具合)の報告を受けて対応した。本節(準備中に落ちる不具合)とは原因が別
(こちらは容量の見積もり方式とPCD変換経路が未接続だったこと)だが、どちらも
Web版の変換まわりの作業なので、記録はM4-9に置いた。詳細・所有者が確かめる
手順は**M4-9の「追記2」**を参照。

---

## M4-6 追記5: 実機不具合「空き容量が足りません(10.0GiB)」の対処(2026-10-08、Sonnet)

### 背景

所有者から「Web版で大規模点群を読み込もうとすると『空き容量がありません
(10.0GiB)』のように出て始められない」という報告があった。コーディネーターの
最初の見立ては「10.0GiBがちょうどFirefoxのbest-effort上限と一致するので
Firefoxではないか」だったが、後に**所有者のブラウザはVivaldi(Chromium系)**と
判明し、この見立ては外れだった。Chromium系での見立て(容量不足の表示が
「必要」か「空き」か文言だけでは分からない、過去の失敗分のキャッシュ・一時
ファイルが溜まっている可能性、`navigator.storage.estimate()`のquotaが
ディスクの実際の空き容量にも左右される可能性)に沿って対処した。

### 調査(公式資料での確認、出典付き)

**(1) `navigator.storage.persist()`/`persisted()`のブラウザごとの挙動**

- [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)の
  “Does browser-stored data persist?”節:
  > In Firefox, when a site chooses to use persistent storage, the user is
  > notified with a UI popup that their permission is requested.
  >
  > Safari and most Chromium-based browsers, such as Chrome or Edge,
  > automatically approve or deny the request based on the user's history of
  > interaction with the site and do not show any prompts to the user.

  **Firefoxは確認のポップアップを出す。Chrome/Edge/Safari(Vivaldiを含む
  Chromium系も同じ)はユーザーへの確認を出さず、サイトの利用履歴から自動で
  判定する。**
- [web.dev: Persistent storage](https://web.dev/articles/persistent-storage)は
  Chromeの自動判定の具体的な観点を示す:
  > How high is the level of site engagement? Has the site been installed or
  > bookmarked? Has the site been granted permission to show notifications?

  （サイトエンゲージメントの高さ・インストール/ブックマーク済みか・通知の
  許可があるか。具体的なスコアの閾値は非公開）。
- `StorageManager.persist()`/`persisted()`はTypeScriptの`lib.dom.d.ts`
  (`node_modules/typescript/lib/lib.dom.d.ts`、確認した版で行36023〜36048)に
  既に型があり、`FileSystemSyncAccessHandle`(M4-6a節で追加したアンビエント宣言)
  のような独自型定義は不要だった。

**(2) Chromiumのquotaがディスクの実際の空き容量にも左右されること**

M4-6a節(7節)は「quotaは総容量の60%で決まる」とだけ記録していたが、これは
不完全だった。

- [developer.chrome.com: Estimating Available Storage Space](https://developer.chrome.com/blog/estimating-available-storage-space):
  > The quota value depends on constant factors like overall storage size,
  > but also volatile factors including unused storage space, so as other
  > applications write or delete data, the browser's quota allocation for an
  > origin will likely change.

  (quotaはストレージの総容量のような一定要因だけでなく、未使用のストレージ
  容量という変動要因にも依存する。他のアプリがディスクに書き込む・消すたびに
  quotaの割り当ては変わりうる)
- 同ページの旧版の記述(Chrome 57以前〜58以降の変遷)によれば、歴史的にも
  Chromeのpool sizeはディスクの空き容量を基準に計算されてきた
  (「空き容量の1/3」→「ボリュームサイズの1/3、ただしドライブの10%は空けておく」
  等)。**「総容量の60%」は固定の答えではなく、実際にはディスクの空き容量も
  絡めて動的に決まる**、というコーディネーターの訂正は裏付けられる。
- MDNの同じページ(Storage quotas and eviction criteria)も
  “the amount of storage currently unused”をquotaの変動要因として明記して
  おり、Chrome公式のブログと整合する。

**結論**: 所有者が報告した「10.0GiB」は、Chromium系では**Firefoxの固定上限
ではなく**、その時点のディスク空き容量・使用履歴から動的に決まったquotaの
一部である可能性が高い。文言から「必要量」か「空き」かが分からないという
問題と、実際にOPFS内に何が溜まっているか見えない問題の両方を、本追記で
対処する。

### 実装したこと

1. **変換前に永続的な保存を求める** (`src/datasource/opfs.ts`の
   `ensurePersistentStorage`): `navigator.storage.persisted()`で既に永続化
   済みか確かめ、まだなら`persist()`を呼ぶ。`web.ts`の
   `checkInsufficientSpace`が変換ごとに(ただし既に永続化済みなら`persist()`
   自体は呼ばず)実行し、その後で`estimateQuota()`をやり直す
   (`PersistableStorageLike`というテスト用の差し替え可能なインターフェースを
   経由する。`LockManagerLike`と同じ方針)。
2. **OPFSの使用量の内訳を見せて消せるようにする** (`opfs.ts`の
   `getOpfsUsageBreakdown`/`removeCachedConversionEntry`/
   `clearAllCachedConversions`/`removeScratchDirByName`):
   変換済みキャッシュ(ファイルごとの名前・サイズ)と、残っている一時ディレクトリ
   (タブを閉じる等で後始末できなかったもの)を列挙し、個別・まとめて消せる。
   **置き場所は設定画面(`SettingsModal.tsx`)の新しい節「ブラウザの保存領域」**
   にした(`viewer.isBrowser`で弾き、Tauri版には出さない)。理由:
   一覧+削除ボタンという密なフォームはADR-0005が設定画面に求める「不透明で
   安定したコントラスト」の対象そのもので、容量不足のエラーバナー
   (`GpuErrorBanner.tsx`、1行のメッセージをflexで縦に積むだけの軽いUI)に
   一覧・削除ボタンを持ち込むと設計が歪む。バナー側には「設定の『ブラウザの
   保存領域』から消せる」という案内文だけを出す。
3. **容量不足の表示を分かりやすくする** (`opfs.ts`の
   `describeInsufficientSpaceWeb`、純粋関数): 「空き容量が足りません
   (必要: 約XGiB／空き: 約YGiB(上限 約ZGiB、使用中 約WGiB))。空けるには、
   …のいずれかを試してください。」という形にした。空ける方法の提案は
   状況に応じて変える(消せるキャッシュ・一時ファイルがあるときだけ
   「キャッシュ・一時ファイルを消す」を提案し、未永続化のときだけ
   「永続的な保存を許可する」を提案する。常に「デスクトップ版で変換する」を
   加える)。デスクトップ版の`insufficientSpace`(OSの実際の空きディスク)とは
   中身が違うため、`ConversionOutcome`に`insufficientSpaceWeb`という
   Web専用の値を追加した(`opfsUnavailable`と同じ扱い)。
4. **見積もり(`requiredBytesForPointCount`)の根拠を見直した**: 下記「見つけた
   不具合」参照。1点あたりのバイト数の根拠コメントに誤りを見つけて直したが、
   定数の値(60/10)自体は変えていない。

### 見つけた不具合: `OUTPUT_BYTES_PER_POINT`の根拠コメントが実装の異なる2値を混在させていた

受け入れ条件4「見積もりが過大でないかを確かめる」の作業中に見つけた。

旧コメントは「M4-1bの実測(出力サイズ÷点数): beer.laz 7.48 B/点、
sofi.copc.laz 9.07 B/点」としていたが、出典を遡ると**2つの異なる実装の値を
混在させていた**:

- **7.48 B/点(beer.laz)**: M4-1節(46行目〜)の**素朴な実装**(全点メモリ、
  M4-2で`copc-writer`採用により不採用)の出力(500.04MB/66,848,096点)から
  来ていた
- **9.07 B/点(sofi.copc.laz)**: M4-1b節の**`copc-writer`**の出力
  (3,305.84MB/364,384,576点)から来ていた

現在の実装(デスクトップ・Web版とも)は`copc-writer`系列のみを使うため、
素朴な実装の値(7.48)を根拠に使う理由が無い。本セッションで、M4-1bのスパイクが
残していた実際の出力ファイル(`data/beer.copc.laz`、2026-10-04時点でもworktree
外の`C:\rust\point-cloud-viewer\data\`に残っていた)を使って、beer.lazも
`copc-writer`側の値で再計算した。

```
$ node -e '
const fs = require("fs");
const path = "C:/rust/point-cloud-viewer/data/beer.laz";
const fd = fs.openSync(path, "r");
const head = Buffer.alloc(300);
fs.readSync(fd, head, 0, 300, 0);
fs.closeSync(fd);
console.log("minorVersion", head[25], "headerSize", head.readUInt16LE(94), "legacyCount", head.readUInt32LE(107));
console.log("beer.laz size", fs.statSync(path).size);
console.log("beer.copc.laz size", fs.statSync("C:/rust/point-cloud-viewer/data/beer.copc.laz").size);
'
minorVersion 2 headerSize 227 legacyCount 66848096
beer.laz size 470528077
beer.copc.laz size 606308379
```

LASヘッダーから読んだ点数(66,848,096)はM4-1/M4-1b節の記載と一致し、
`beer.copc.laz`のサイズ(606,308,379バイト)もM4-1bの表の「606.31MB」
(10進MB、606,308,379÷10^6=606.31)と一致する。すなわちこのファイルは
M4-1bのスパイクが実際に書き出した出力そのものである。

```
$ node -e '
console.log("beer output B/点(copc-writer):", 606308379/66848096);
console.log("sofi output B/点(copc-writer、M4-1b記載値からの再計算):", 3305.84e6/364384576);
console.log("beer output B/点(M4-1素朴実装、参考・不使用):", 500.04e6/66848096);
'
beer output B/点(copc-writer): 9.069942381006634
sofi output B/点(copc-writer、M4-1b記載値からの再計算): 9.072392789754087
beer output B/点(M4-1素朴実装、参考・不使用): 7.480242967578314
```

**`copc-writer`ベースでは、beer(9.0699)とsofi(9.0724)は9.07前後に一致する。**
旧コメントが示唆していた「7.48〜9.07の範囲がある」という形は誤りで、実際は
1点に近い値に収束していた。`OUTPUT_BYTES_PER_POINT`の値(切り上げて10)自体は
変えていない(根拠が誤っていても、切り上げ先の10という値は結果的に変わらない。
むしろ2点が独立に9.07前後へ一致したことで、10という値への約10%の安全余裕は
過大ではないという確信が強まった)。コメントだけを修正した
(`src/datasource/opfs.ts`)。

**未確認のまま残した点(正直に)**: M4-7/M4-8/M4-10(入力読み込みの並列化、
後処理の高速化、ノードごとのLAZ圧縮の並列化)が、LAZの**圧縮率自体**
(並列化・バッチ化ではなく出力バイト数)を変えていないことは検証していない。
これらの変更は性能(速度・メモリ)が目的で圧縮アルゴリズム自体は変えていない
はずだが、実際にbeer.laz等を現在のコードで再変換して出力バイト数を比較する
再検証はしていない。`data/beer.copc.laz`がどのセッションでいつ生成されたか
(M4-1bのスパイクか、その後の回帰確認か)もコミット履寚からは追えていない
(ファイルはgitignore対象で、worktreeの外`C:\rust\point-cloud-viewer\data\`に
置かれているため)。

### `SCRATCH_BYTES_PER_POINT`(60)は見直して問題無しと判断した

こちらはM4-1b節の表(「一時ディスク(バイト/点)」行、beer 59.06・sofi 60.00)が
**どちらも`copc-writer`の同じ実測から来ており**、実装の混在は無かった。
Web版(OPFS)の一時ファイルも、`vendor/copc-writer`の`ScratchFs`経由で同じ
`spill.rs`/`lod.rs`のコードパスを通る(M4-6a/M4-6bで改修した箇所そのもの)ため、
ネイティブで実測したこの値はそのまま転用できる(M4-6aが出力のバイト同一性を
SHA-256で確認済み、7節参照)。値(60)は変えていない。

### 判断: デスクトップ版の容量不足表示は変えなかった

デスクトップ版の`insufficientSpace`(`src-tauri/src/conversion.rs`が返す、
OSの実際の空きディスク容量)は今回変更していない。所有者からの報告・
コーディネーターの指示がいずれもWeb版(OPFS)についてのものであり、デスクトップ版は
`availableBytes`が既にOSの実際の空き容量そのもの(quota/usageという
ブラウザ固有の中間層が無い)で、今回の「必要・空き・上限・使用中」を分ける
改善の対象にはならないため。

### 新規テスト

`src/datasource/opfs.test.ts`に追加(31件→既存+16件。詳細は下記確認のvitest出力):

- `ensurePersistentStorage`: 既に永続化済み/未永続化で許可/未永続化で拒否の3パターン
- `toGiBLabel`: バイト→表示文字列の変換
- `describeInsufficientSpaceWeb`: 必要・空き・上限・使用中が文言に含まれること、
  消せる量が0のときキャッシュの提案を出さないこと、永続化済みのとき許可提案を
  出さないこと、常にデスクトップ版の案内を出すこと、空きが負にならないこと

OPFS実機I/O(`getOpfsUsageBreakdown`・`removeCachedConversionEntry`・
`clearAllCachedConversions`・`removeScratchDirByName`)自体は、既存の
`findCachedOutput`等と同じ理由(vitestのjsdom環境には実体が無い)で単体テスト
対象にしていない。下記「所有者が確かめる手順」でブラウザ上での確認を依頼する。

### 確認したこと(実行したコマンドと出力)

```
$ npx tsc --noEmit -p tsconfig.json
(エラー無し)

$ npx eslint .
(警告・エラー無し)

$ npx vitest run
 Test Files  33 passed (33)
      Tests  300 passed (300)

$ npm run build
✓ 83 modules transformed.
✓ built in 208ms

$ npm run ui:check
(差分無し)
```

CI: https://github.com/dOtOb9/point-cloud-viewer/actions/runs/37712871719 (push後に実行)
Pages: https://github.com/dOtOb9/point-cloud-viewer/actions/runs/37712871689

### 確認していないこと(ブラウザでの実機確認、未確認)

- **Vivaldi(Chromium系)実機での動作確認はしていない。** `navigator.storage.persist()`が
  実際に何を返すか、`estimate()`のquotaが所有者の実機でどう変化するか、
  設定画面の「ブラウザの保存領域」節が意図どおり表示・削除できるかは、
  いずれも所有者の確認が必要
- 永続化を許可した後に実際にquotaが増えるかどうか(Chromium系は表の通り
  best-effortと永続化で同じ60%のはずなので、増えないのが期待される挙動。
  増えなくても不具合ではない)
- 大規模点群(所有者が実際に「空き容量が足りません」に遭遇したファイル)を
  Vivaldiで実際に変換し、新しい表示(必要・空き・上限・使用中)が実際の状況を
  正しく説明しているか

### 所有者が確かめる手順(Vivaldiで)

1. GitHub PagesのWeb版を開く(Pages run完了後のURL)
2. 設定(⚙)を開き、「ブラウザの保存領域 (OPFS, M4-6)」節が表示されることを
   確認する。「使用中」「上限」「永続的な保存: 許可済み/未許可」が出る
3. 「許可を求める」ボタンを押す(未許可の場合)。Vivaldiは確認ポップアップを
   出さずに自動判定するはず(本追記の調査(1)参照)なので、ボタンを押した
   直後に「許可済み」に変わるかどうかを確認してほしい(変わらない場合、
   自動判定がこの時点では「不許可」と判断したという意味で、不具合ではない)
4. 変換済みキャッシュ・残っている一時ファイルの一覧に、過去に試した変換が
   出るか確認する。「消す」「すべて消す」を押して一覧が更新されることを
   確認する
5. 以前「空き容量が足りません(10.0GiB)」が出たのと同じ(または近い規模の)
   ファイルを開き直し、新しい表示(「必要: 約XGiB／空き: 約YGiB(上限
   約ZGiB、使用中 約WGiB)。空けるには、…」)が出ることを確認する。
   このとき「必要」「空き」「上限」「使用中」のどの数字が実際に報告された
   「10.0GiB」に近いかを教えてほしい(この情報が、まだ残っている謎
   ――10.0GiBがFirefoxの上限と一致していたのは単なる偶然だったのか――を
   解く手がかりになる)
6. キャッシュ・一時ファイルを消す、または永続化を許可した後、同じファイルで
   再度変換を試し、表示される「空き」の数値が変わるか(増えるか)を確認する

---

## M4-7: 入力の読み込み(LAZの展開)を並列化する(2026-10-02、Sonnet)

### 背景・所有者の要望

「並列化しようか、さすがに遅すぎる。数千万点」。`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`
は「並列度だけを上げて、1回あたりのコストを疑わなかった」失敗を記録しており、
本タスクはその教訓を前提に進める: **まず読み込み段階の内訳を測り、LAZの展開が
半分以上を占める場合だけ並列化に進む**(コーディネーターが事前に決めた基準)。

計測・実装は`crates/pcv-convert/src/streaming.rs`(デスクトップ・Android)と
`crates/pcv-wasm/src/convert.rs`・`src/datasource/copc.worker.ts`(Web)が対象。
`vendor/copc-writer/`・`crates/pcv-wasm/src/opfs.rs`・`alloc_guard.rs`は
並行作業中の別エージェント(Web版のメモリ不足修正)の担当のため触っていない。

開発機: 20論理コア。計測対象: `C:\rust\point-cloud-viewer\data\beer.laz`
(66,848,096点、LAZ、448.7MiB。worktreeの外の絶対パスから読んだ。出力はコミットしていない)。

### 1. まず測る: 読み込み段階の内訳(ネイティブ、実測)

専用の計測ハーネス`crates/pcv-convert/examples/read_stage_bench.rs`を新設した
(`cargo run -p pcv-convert --release --example read_stage_bench -- <file>`)。
「読み込み」段階を次の3つに分けて測る:

1. **入力の読み込み(ファイルI/O)**: `std::fs::read`でファイル全体を読む時間
   (解凍・パース無し)
2. **LAZの展開**: 1.のバイト列を`std::io::Cursor`に包み、**ディスクI/Oを
   一切発生させない状態**で`las::Reader`に読ませ、全点を展開する(点は捨てる)
3. **点を`copc-writer`に渡して一時ファイルに書く部分**: ディスクから読みながら
   `copc_writer::SpillWriter::push`でspillへ書く。`fill_points`呼び出しの時間と
   `push`呼び出しの時間を、ループの中でそれぞれ別の`Duration`に実測で積算し、
   直接分離した(推測ではない)

参考として、読み込みの後の段階(octree構築・書き出し、
`write_copc_from_spill_with_fs`の1回の呼び出し)も測った。

**実測結果**(`main`を`origin/main`にrebaseした後、`vendor/copc-writer`の
一時ファイル読み出しが`as_bytes`(全体スライス)から`read_at`(範囲読み、
メモリ不足修正)に変わった状態で測り直したもの):

```
beer.laz  ファイルサイズ: 448.7 MiB

[1] 入力の読み込み(ファイルI/O、std::fs::read):
       0.294 秒  ( 1524.1 MiB/秒)

[2] LAZの展開(ディスクI/Oゼロ、メモリ上のバイト列から読む):
      40.979 秒  (66848096 点,    1631294 点/秒)

[3] 読み込み段階の内訳(ディスクから読みながらspillへ書く、実測):
    fill_points合計(ディスクI/O+LAZ展開):   38.790 秒
    spill.push合計(一時ファイルへの書き込み):   10.212 秒
    読み込み段階合計:                          49.002 秒  (66848096 点)

[参考] 読み込みの後の段階(octree構築・書き出し):
      64.212 秒
```

(rebase前、`read_at`化前の`main`でも同条件で一度測っており、
読み込み段階合計55.822秒・展開41.074秒・spill9.234秒・後処理73.447秒と、
誤差の範囲で同じ傾向だった。`read_at`化は`SpillReader`側(ランダムアクセス
読み出し)の変更なので、`SpillWriter`を使うこの計測への影響は無いはずで、
実測でもその通りだった。後処理の64.212秒 vs 73.447秒の差は、同一ファイルを
繰り返し読んだことによるOSページキャッシュの温まり具合の違いが大きいと見ており
(`ADR-0006`が記録した「計測値の食い違い(未解決)」と同種の揺れ)、
`read_at`化による明確な悪化は観測していない。)

**内訳**: 読み込み段階合計49.002秒のうち、
- LAZの展開: fill_points合計38.790秒に対して[2]の展開単体が40.979秒
  (ほぼ同じ、測定誤差の範囲。**展開が読み込み段階の合計の約79%、
  fill_points部分だけで見れば100%以上**=展開がfill_points全体を
  ほぼ説明する)
- spillへの書き込み: 10.212秒(読み込み段階合計の約21%)
- 参考: 入力のファイルI/O単体は0.294秒(読み込み段階合計の1%未満。
  OSページキャッシュ済みの条件でもあり、ディスクI/O自体がボトルネックで
  ないことは明らか)

### 判断

**LAZの展開が読み込み段階の過半数(約79%、fill_points部分では実質
全体)を占めるため、事前に決めた基準(半分以上なら並列化に進む)に従い、
展開の並列化に進む。**

### 2. 並列化(デスクトップ・Android)

#### 「あれば使う」: `las`/`laz`クレートの並列展開機能を確認した

自前でチャンクを分担する実装を書く前に、`laz`クレート(0.12.2)のソースを
確認したところ、**`parallel`フィーチャ(`rayon`使用)で`ParLasZipDecompressor`・
`par_decompress_buffer`等が既に提供されている**ことが分かった
(`laz-0.12.2/src/laszip/parallel/decompression.rs`)。さらに`las`クレート
(0.10.0)は、この機能への入口を`laz-parallel`フィーチャとして既に持っている
(`las-0.10.0/src/reader/mod.rs`の`ReaderOptions`/`LazParallelism`)。

**自前実装は不要と判断し、この既存機能を使うことにした**
(`crates/pcv-convert/Cargo.toml`で`las`の`features`に`laz-parallel`を追加)。
`las::ReaderOptions::default()`は`laz-parallel`フィーチャが有効なとき既定で
`LazParallelism::Yes`を選ぶため、`crates/pcv-convert/src/streaming.rs`の
`las::Reader::new(source)`という既存の呼び出し自体はコード変更不要だった
(`las`クレートのソースで確認済み)。

#### 仕組みと、点の順序への影響(コードを読んで確認)

LAZは約5万点ごとの「チャンク」に分かれ、チャンクテーブルに各チャンクの
位置が記録されている。チャンク間に展開上の依存は無い。`ParLasZipDecompressor`は
要求された点数を埋めるのに必要なチャンク群をまとめて読み、`rayon`のスレッド
プールでチャンクごとに並列展開する。**各チャンクの展開結果は出力バッファの
自分の位置へそのまま書き込まれるため、点の順序は変わらない**
(`laz-0.12.2/src/laszip/parallel/decompression.rs`の`par_decompress_selective`を
読んで確認。実測による確認ではなくコードの読み込みによる確認であることを
明記する)。したがって`copc-writer`に渡す点の順序は並列化前後で変わらず、
「順序が変わってよいか」を心配する必要は無かった。

#### バッチサイズを増やした理由(実測)

`fill_points(n, ..)`は`decompress_many`を呼ぶが、**1回の呼び出しがまたぐ
チャンク数の分だけ並列化される**。改修前の`READ_BATCH_SIZE`(64Ki点)は
1チャンク(約5万点)の1.3倍程度にしかならず、並列化の余地がほとんど無い。
専用の計測ハーネス`crates/pcv-convert/examples/parallel_read_bench.rs`で、
バッチサイズを振って直列/並列を比較した(`beer.laz`、ディスクI/O+展開、
spill書き込みは含まない。2回実測、1回目→2回目の順に記載):

| バッチサイズ | 直列(1回目) | 並列(1回目) | 倍率 | 直列(2回目) | 並列(2回目) | 倍率 |
|---|---|---|---|---|---|---|
| 65536(旧値) | 43.022秒 | 25.450秒 | 1.69倍 | 18.088秒 | 30.206秒 | **0.60倍** |
| 262144 | 17.252秒 | 5.275秒 | 3.27倍 | 20.306秒 | 5.633秒 | 3.60倍 |
| 1048576(採用) | 17.611秒 | 3.306秒 | 5.33倍 | 18.311秒 | 3.490秒 | 5.25倍 |
| 4194304 | 17.553秒 | 2.787秒 | 6.30倍 | 18.606秒 | 2.995秒 | 6.21倍 |

2回の実測で直列側の所要時間が揺れている(65536で43.0秒→18.1秒、
262144以降は17〜20秒程度)。同じファイルを同じセッションで繰り返し読んだ
ことによるOSページキャッシュの温まり方の違いが原因と考えられる
(`ADR-0006`が記録した既知の揺れと同種)。**測っていない値を実測したと
書かないため、揺れも含めてそのまま記載する。**

揺れはあるものの、一貫して観測できたのは次の2点:
- **64Ki(旧バッチサイズ)では並列化の効果が薄く、2回目の計測では
  むしろ並列の方が遅かった(0.60倍)。** 1回あたりのチャンク数が
  少なすぎて、`rayon`のスレッド分配のオーバーヘッドが展開本体の時間より
  目立つためと考えられる
- **バッチサイズを大きくするほど並列化の効果が安定して伸びる。**
  1048576(1Mi)で5.25〜5.33倍、4194304(4Mi)で6.21〜6.30倍

**1Mi(1,048,576)を採用した。** 4Miの方がわずかに速いが、1回の
`fill_points`呼び出しの間はキャンセルを割り込ませられない
(`copc-writer`は4096点ごとにキャンセルを確認するが、それは我々の
`Iterator`が払い出す点の単位であり、`Iterator`の内部で新しいバッチを
埋めている最中はキャンセルを確認できない)。1Miなら1バッチの所要時間は
66,848,096点÷(1,048,576点ごと)≈64バッチ、3.3〜3.5秒÷64≈52〜55ms程度。
4Miでは1バッチ≈175〜187msとやや増える。速度の伸び(5.3→6.3倍)に対して
キャンセル遅延の増分(3倍以上)が割に合わないと判断し、1Miにした
(`crates/pcv-convert/src/streaming.rs`の`READ_BATCH_SIZE`)。

メモリ面: 1Mi点の一時バッファは、点1つを最大38バイト程度としても
約40MB程度で、out-of-coreの前提(全点をメモリに載せない)を崩さない。

#### 実測: デスクトップで読み込み段階全体の時間が前後でどう変わったか

専用のベンチ`crates/pcv-convert/examples/read_stage_before_after.rs`
(本番と同じ`SpillWriter`を使う経路を、改修前後それぞれの設定で1回ずつ
同一プロセス内で連続実行して比較。`beer.laz`):

```
beer.laz

[前] 直列・バッチ65536点(改修前の設定):    24.755 秒
[後] 並列・バッチ1048576点(改修後の設定):    14.858 秒

倍率: 1.67倍
```

**読み込み段階全体では1.67倍。** LAZの展開単体は5.25〜6.30倍速くなったが、
**spillへの書き込み(`SpillWriter::push`、約9〜10秒、並列化していない)が
相対的に支配的になった**ため、全体の伸びはアムダールの法則どおり頭打ちに
なっている。spillへの書き込みは`vendor/copc-writer`(別エージェントの担当、
本タスクでは触らない)の中にあり、本タスクの範囲では並列化できない。
**正直に書く: 読み込み段階「全体」の体感速度は約1.7倍にとどまる。**
数千万点規模のファイルで「LAZ展開」自体が支配的だった区間(ADR-0007の
sofi相当、あるいはより大きい入力)ほど、この改修の効果は大きくなる見込み。

### 3. 新規テスト: 並列展開と逐次展開が同じ点の集合になること

`crates/pcv-convert/tests/parallel_laz_decompression.rs`(新設)。
複数チャンクにまたがる合成LAZ(300,000点、約6チャンク分)を作り、
`las::ReaderOptions`で`LazParallelism::No`/`Yes`を明示的に切り替えて
同じファイルを読み、次を確認する:

- 点数が一致する
- 全点の(x, y, z)座標の集合(`BTreeSet`。浮動小数点だが合成データは
  有理数で誤差が出ない値を使っている)が一致する(順序は見ない。
  `ParLasZipDecompressor`は順序を変えないことをコードで確認済みだが、
  受け入れ条件どおり「順序が変わっても集合が保たれること」を確認する
  テストにした)
- 並列設定のまま`convert_path`(本番の変換経路)を通した出力が
  `pcv-core`で開け、hierarchyの点数の合計が入力点数と一致する

### 確認したコマンドと結果(デスクトップ・Android分)

```
$ cargo fmt --all -- --check
(出力無し、終了コード0)

$ cargo clippy --workspace --all-targets -- -D warnings
(警告・エラー無し)

$ cargo test --workspace
pcv-convert(ライブラリ): 既存のテストすべて成功
pcv-convert(統合テスト、parallel_laz_decompression.rs新設):
  parallel_and_serial_laz_decompression_yield_the_same_point_set ... ok
  production_conversion_path_with_parallel_decompression_opens_in_pcv_core ... ok
pcv-core・pcv-tauri: 既存のテストすべて成功
合計(ワークスペース全体、doc-test含む): 失敗0
```

コミット: `perf(M4-7): デスクトップ・AndroidのLAZ展開を並列化する`
(`origin/main`へpush済み)。

### 4. Web版の並列化

#### 背景: ネイティブと同じ手段が使えない

デスクトップ・Android(上記2.)は`las`クレートの`laz-parallel`フィーチャ
(`rayon`、OSスレッド)で解決したが、**Web版では`rayon`が使えない。**
`rayon`はOSスレッドか`wasm32`の`atomics`(`SharedArrayBuffer`)のどちらかを
要求するが、GitHub Pagesは静的ホスティングでCOOP/COEPヘッダーを設定できず
`crossOriginIsolated`にならないため、`SharedArrayBuffer`は使えない
(`TaskSheets/ADR-0012-web-worker-sync-io.md`・`TaskSheets/ADR-0006-conversion-strategy.md`
のWeb版の節が既に確認済みの制約)。

課題にある通り、**独立したWeb Workerを複数立ててチャンク範囲(点インデックスの
範囲)を分担させる**方式にした。Workerはメモリを共有しないJSのグローバルなので、
`SharedArrayBuffer`無しで真の並列実行になる。

#### 実装したもの

- `crates/pcv-wasm/src/convert.rs`(新規関数`decompress_laz_range`、
  `WasmConverter`に`totalPoints()`・`recordWidth()`・`pushSerializedRecords()`
  を追加。モジュールドキュメント「M4-7」参照):
  - `decompress_laz_range(file, start_index, count)`: 展開専用Workerから呼ぶ。
    `WasmConverter`とは完全に独立した`las::Reader`を自分の`File`に対して開き、
    `las::Reader::seek`で担当範囲の先頭近くまで直接ジャンプしてから展開する
    (全点を先頭から読み直さない)。読んだ点は`copc_core::serialize_le`
    (`vendor/copc-writer`とは別の、両エージェントが自由に使える公開クレート
    `copc-core`の関数)でspillと同じ固定長バイト列にシリアライズして返す
  - `WasmConverter::pushSerializedRecords(bytes)`: 変換用Worker側で、展開
    Workerから届いたバイト列を`deserialize_le`で`LasPointRecord`に戻し、
    今までどおり1本の`SpillWriter`へ`push`する(`SpillWriter`はWorkerを
    またいで共有できないため、spillへの書き込みは引き続き1本のWorkerだけが行う)
  - ロジック本体(`decompress_point_range`)は`web_sys::File`に依存しない形に
    切り出し、ネイティブの`cargo test`から`Cursor<Vec<u8>>`で検証できるようにした
    (後述のテスト参照)
- `src/datasource/laz-decompress.worker.ts`(新設): 展開専用Worker本体。
  `{file, startIndex, count}`を受け取り`decompressLazRange`を1回呼んで
  バイト列を返すだけの単純な作り(範囲の途中で進捗を細かく報告する仕組みは
  持たない。後述「進捗の粒度」参照)
- `src/datasource/decompress-partition.ts`(新設): 範囲分割
  (`pointRangesFor`)とWorker数の決定(`decompressWorkerCountFor`)を、
  Worker固有のAPIに依存しない純粋関数として切り出した(`copc.worker.ts`から
  使うが、普通のvitestで直接テストできる)
- `src/datasource/copc.worker.ts`: 読み込み段階を`runParallelReadPhase`に
  分岐させた。`decompressWorkerCountFor`が1を返す(入力が小さい、または
  `hardwareConcurrency`が不明・1)場合は、今までどおり`WasmConverter.feed`の
  逐次バッチループにフォールバックする

#### Worker数・しきい値の決め方(実測の裏付けが無いので保守的に)

- **`PARALLEL_MIN_POINTS`(50万点)未満では並列化しない。** ネイティブの実測
  (上記2.の表)で、分担の単位が小さすぎるとスレッド起動のオーバーヘッドが
  展開本体の時間を上回り、**直列より遅くなる逆転が実際に観測された**
  (バッチサイズ64Ki点、20コアで直列18.1秒・並列30.2秒)。Web Workerの起動・
  `File`の構造化クローンのコストはネイティブのスレッド起動よりさらに重いと
  見て、ネイティブの観測よりさらに余裕を持った値にした
- **`MAX_DECOMPRESS_WORKERS`(8)を上限にする。** `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`
  の`POOL_SIZE`と同じ考え方の決め打ち。各Workerは独立したwasmヒープを持つため、
  `navigator.hardwareConcurrency`をそのまま無制限に使わない
- どちらも実機で測り直せていない値であることを明記する(次節「正直に:
  Web版は推定」参照)。`src/datasource/decompress-partition.ts`に根拠ごと
  コメントを残したので、将来実測して変えられる

#### 点の順序・キャンセル・進捗

- **点の順序**: `runParallelReadPhase`は担当範囲の順(点インデックスの昇順)で
  結果を取り出して`pushSerializedRecords`に渡す(到着順ではない)。全Workerは
  `postMessage`直後に並行して動き始めるため、取り出す順序を決め打ちにしても
  並列度は落ちない。もっとも、順序の保存自体は本質的な要件ではない
  (`convert.rs`のモジュールドキュメント参照。`SpillWriter`の検証・統計は
  1点ごとに閉じた計算で順序に依存しないことをソースで確認済み)
- **キャンセル**: `convertCancel`メッセージのハンドラが、進行中の展開Worker
  全員に`Worker.terminate()`を呼ぶ。`terminate()`は実行位置に関わらず即座に
  止まるため、デスクトップ版の「バッチの合間に制御を返す」方式より反応は
  悪くならない。ただし`terminate()`されたWorkerは応答を返さないため、
  `Promise`が永遠に解決しない問題が起きる。これを避けるため、進行中の
  Workerの`reject`を`activeDecompressWorkers`に保持しておき、キャンセル時に
  `terminate()`と同時に`reject(new ParallelReadCancelledError(...))`を呼んで
  待ちを即座に解消する実装にした(`copc.worker.ts`参照)
- **進捗**: 各展開Workerは担当範囲を1回の`decompressLazRange`呼び出しで
  丸ごと展開するため、**進捗はWorker単位の粗い粒度になる**(1つのWorkerが
  完了するたびに更新。デスクトップ版の4096点ごとより粗い)。範囲の途中で
  細かく刻んで進捗を出す設計も検討したが、実装の複雑さ(Worker内での
  バッチループ・yield・キャンセル確認を展開Worker側にも持ち込む必要がある)
  に見合わないと判断し、単純さを優先した。**この粗さは正直に書く
  (「測っていないことを実測したと書かない」と同じ精神で、実装の制約を
  誇張も矮小化もしない)。**

#### 新規テスト

- `crates/pcv-wasm/src/convert.rs`の`#[cfg(test)]`(ネイティブ、`cargo test`):
  - `concatenated_ranges_match_a_single_full_range_read`: 複数チャンクに
    またがる合成LAZ(30万点)を、1回で全体を読んだ結果と、3つの範囲
    (チャンク境界と揃っていない、わざと不均等な区切り)に分けて連結した
    結果とで、**バイト単位で一致する**ことを確認する。M4-7の受け入れ条件
    (点数・点の集合の一致)より強い確認(連結順が決まっているため)
  - `range_starting_past_total_points_returns_empty`: 範囲外の開始でも
    エラーにならず空を返すこと(端数の扱い)を確認する
- `src/datasource/decompress-partition.test.ts`(vitest): `pointRangesFor`
  (均等分割・余りの寄せ方・範囲が重ならないこと)と`decompressWorkerCountFor`
  (しきい値・上限・`hardwareConcurrency`不明時のフォールバック)を確認する

#### 正直に: Web版は推定(実測していない)

**Web版の並列化の効果は実機で測っていない。** GUIを目視できない環境のため、
実際のブラウザでWorkerを複数立てて計測することができない。以下は
**ネイティブの実測から推定した見込みであり、実測ではない**:

- ネイティブで観測したLAZ展開の並列化効果(5.25〜6.30倍、20論理コア)が
  Web版でもある程度は再現すると見込む。ただしWeb Workerの起動コスト
  (wasmモジュールの初期化を複数回行う)・`File`の構造化クローンのコスト
  (ネイティブのスレッド起動より重い)・ブラウザ・端末のコア数のばらつき
  (ネイティブの開発機の20論理コアより少ない環境が多いと見込まれる)により、
  **実際の倍率はネイティブより低くなる可能性が高い**
- ネイティブと同じく、読み込み段階「全体」では、spillへの書き込み
  (`pushSerializedRecords`が内部で呼ぶ`SpillWriter::push`、並列化していない)
  が相対的に支配的になるため、展開単体の倍率より低い倍率にとどまる見込み
  (アムダールの法則。ネイティブでは1.67倍だった)
- `PARALLEL_MIN_POINTS`・`MAX_DECOMPRESS_WORKERS`の値は、ネイティブの実測から
  類推した保守的な決め打ちであり、Web版自体での計測に基づく値ではない

**実機での確認が必須。** 下記「所有者が確かめる手順」に委ねる。

### 確認したコマンドと結果(Web版)

```
$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
Finished(成功)

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --all-targets -- -D warnings
(警告・エラー無し)

$ cd crates/pcv-wasm && cargo test
17 passed(concatenated_ranges_match_a_single_full_range_read・
           range_starting_past_total_points_returns_emptyを含む)
buffered_file_reader_reduces_read_calls: 1 passed
memory_scratch_conversion: 1 passed

$ cd crates/pcv-wasm && cargo fmt --all -- --check
(出力無し、終了コード0)

$ npm run build:wasm
(成功。生成物をコミット)

$ npx tsc --noEmit
(出力無し、終了コード0)

$ npx eslint .
(出力無し、終了コード0)

$ npx vitest run
Test Files  28 passed (28)
     Tests  240 passed (240)

$ npm run build
dist/assets/laz-decompress.worker-*.js    9.38 kB (新しいWorkerチャンクが
  独立して生成されていることを確認。Viteが`new URL(...)`パターンを認識し、
  正しく別チャンクとして扱えている証拠)
dist/assets/copc.worker-*.js             15.08 kB
✓ built in 709ms
```

### 所有者が確かめる手順(Web版、実機必須)

1. **大きめの生LAS/LAZ(50万点以上)をWeb版で変換する。** devtoolsの
   Networkタブ・Performanceタブ、またはOSのタスクマネージャで、複数の
   Workerスレッドが同時にCPUを使っていることを確認する(`laz-decompress.worker`
   という名前のWorkerが`navigator.hardwareConcurrency`に応じた数だけ
   立っているはず、上限8)
2. 変換が今までどおり完了し、結果が正しく表示されることを確認する
   (点数・見た目がデスクトップ版と変わらないこと)
3. **キャンセル**: 変換中(特に読み込み段階、展開Workerが動いている間)に
   キャンセルを押し、即座に止まる(体感で遅延を感じない)ことを確認する。
   devtoolsのconsoleにエラーが残っていないか、OPFSの一時ファイルが
   残っていないかも確認する(今までどおりの受け入れ条件)
4. **小さいLAS/LAZ(50万点未満)**: 並列化されず、今までどおり`feed`の
   逐次ループで変換されることを確認する(進捗の出方が今までと変わらない
   はず。`PARALLEL_MIN_POINTS`未満なので`decompressWorkerCountFor`が1を返す)
5. 可能であれば、同じファイルで並列化の前(このコミットの前のバージョン)と
   後で変換にかかる時間を比べ、実際の倍率を記録して本節に追記してほしい
   (上記「正直に: Web版は推定」のとおり、実測はまだ無い)
6. コア数の少ない端末(スマートフォン等)でも、変換が壊れずに完了する
   ことを確認する(並列化されないだけで、動作自体は保証されるはず)

## M4-7 追記: 展開Workerのメモリが点数に比例していた不具合の修正(2026-10-07、Opus調査・Sonnet実装)

### 何が問題だったか

本節(M4-7)で導入した並列展開は、**各展開Workerが担当範囲の点を全部
シリアライズして`Vec<u8>`にメモリに貯めてから、1回の`postMessage`で返す**
設計だった(旧`decompress_laz_range`、`crates/pcv-wasm/src/convert.rs`)。
1点あたり約43〜57バイト(`vendor/copc-writer/tests/scratch_read_is_bounded.rs`)
なので、Worker1個の担当範囲が数千万点規模になると、1Workerあたり数百MB〜
1GB超のバッファになりうる。これは**M4-6で直した「メモリが点数に比例する」
問題と同じ種類の不具合**で、本節(M4-7)の並列化で再び入り込んでいた
(`decompress-partition.ts`の`MAX_DECOMPRESS_WORKERS_MOBILE`のドキュメントが
既にこの問題を指摘していたが、直すのはM4-11の時点では見送られていた)。

さらに、変換用Worker(`copc.worker.ts`)側も、展開Workerから届いたバイト列を
`pushSerializedRecords`で消費するまでの間は参照を持ち続けるが、消費自体は
即座に行われていたため、**変換用Worker側に長期間のため込みは無かった**
(=問題は展開Worker側の「全部まとめて作る」設計そのものにあった)。

(所有者の実機で実際に踏んだ「変換に失敗しました: unreachable」は、調査の
結果これとは**別の原因**(`Instant::now()`がwasm32でpanicする、M4-8追記参照)
だったと判明したが、この「メモリが点数に比例する」設計上の欠陥自体は独立に
実在する不具合であり、コーディネーターの指示どおりM4-8追記の後に引き続き
修正した)。

### 直し方

1. **展開Workerをバッチ単位で駆動する(pull型)。** `crates/pcv-wasm/src/
   convert.rs`に`LazRangeDecompressor`(`new`で担当範囲を受け取り、`feed
   (batch_size)`を呼ばれるたびに**そのバッチ分だけ**メモリを確保して返す)
   を追加し、旧`decompress_laz_range`(担当範囲全体を1回で返す)を置き換えた。
   `laz-decompress.worker.ts`は`init`→(`requestBatch`→`decompress-batch`/
   `decompress-done`を繰り返す)という新しいプロトコルになった。
   - **バッチサイズの値と根拠**: `DECOMPRESS_BATCH_POINTS = 64 * 1024`点
     (`decompress-partition.ts`)。既存の`CONVERT_BATCH_SIZE`(変換用Workerの
     逐次バッチループ)と同じ桁に揃え、1点最大約57バイトで見積もると
     1バッチ最大約3.65MiB(点数に関係なく一定)になる。
2. **変換用Workerは届いたバッチを順に`pushSerializedRecords`へ渡し、渡し
   終えたバッチは即座に捨てる(参照を残さない)。同時に抱えるバッチの数・
   バイト数に上限を設け、上限に達したら展開Workerへの次の`requestBatch`を
   送らずに待つ(背圧)。** この判定を`BoundedBatchFlow`(`decompress-
   partition.ts`、ブラウザ・wasmに依存しない小さなクラス)に切り出した。
   上限は`workerCount * MAX_IN_FLIGHT_BATCHES_PER_WORKER`
   (`MAX_IN_FLIGHT_BATCHES_PER_WORKER = 2`、値の根拠はコード内コメント参照)。
   展開Worker側は「次のリクエストが来るまで何もしない」ので、これが
   そのまま背圧として働く(新しいメッセージ型や「待って」の往復は増やさず、
   pull型プロトコル自体が背圧の実装になっている)。
3. **`copc-writer`に渡す点の順序が変わってよいか**: 本節(M4-7)のデスクトップ
   並列化の確認と同じ考え方(「点の集合が同じなら、順序が変わっても
   octree構築の結果は変わらない」、`validate_spill_record`・`PointStats`が
   1点ごとに閉じた計算であることをソースで確認済み)で検証した。
   以前は「展開Workerは並行して動くが、結果を取り出す順序は範囲の昇順に
   決め打ち」だったが、この設計ではそれをやめた。順序を決め打ちにするなら、
   「次に取り出す番のWorker」以外から届いたバッチは、取り出されるまで
   どこかに貯めておくしかなく、これは「バッチを受け取ったら即座にpushして
   捨てる」という本修正の前提(同時に抱える量を点数に比例させない)を崩す。
   そのため**Worker間の順序は到着順に変えた**(各Workerの担当範囲内の
   順序は保たれる)。この変更が安全であることを、
   **新規の統合テスト**(`crates/pcv-wasm/tests/parallel_push_order_point_set.rs`、
   `reordered_push_matches_sequential_push_point_set`)で直接確認した:
   同じ点の集合を(a)元の順序、(b)複数Workerのラウンドロビンを模した
   入れ替え順序でそれぞれ`SpillWriter`へpushし、`write_copc_from_spill_with_fs`
   で別々のCOPCへ書き出した上で、両方を`las::Reader`で開き直して座標+
   intensityの集合が一致することを確認する。
4. **PCDの経路(`pcd_import.rs`)の確認結果**: `WasmPcdConverter::feed`は
   `pcd_rs::DynReader`の`next()`イテレータを1点ずつ呼ぶ逐次バッチループ
   (`SpillWriter::push`も1点ずつ)で、担当範囲全体を`Vec`にため込む処理は
   どこにも無い。全点を一括でメモリに載せるのは`binary_compressed`形式の
   LZF展開(モジュールドキュメントに記載済みの512MiB上限チェックが既にある)
   だけで、ASCII/binary(非圧縮)形式は点数に比例しない。**この確認は
   `feed`メソッドのループ構造を読んで行ったもので、`pcd-rs`自身の内部実装
   (LZF展開の詳細)までは読み直していない**(既存のモジュールドキュメントが
   `pcd-rs` 0.9.0のソースを根拠にしていると記録している。本タスクでは
   その記述を信頼し、`feed`側に新たな全件バッファ処理が無いことだけを
   新たに確認した)。コード変更は無し。
5. **`alloc_guard`のメッセージを画面のエラー表示にも出す。** メモリ確保の
   失敗は`unreachable`命令のトラップにしかならず、JSの例外メッセージは
   単に`"unreachable"`で、画面にはその文字列しか出せなかった。
   `crates/pcv-wasm/src/alloc_guard.rs`に、確保失敗時のメッセージを
   `thread_local`へ残す仕組みを足し、`lastAllocationFailureMessage()`
   (`lib.rs`)でJS側から読めるようにした。`copc.worker.ts`の
   `describeConversionFailure`が、変換失敗のメッセージが`unreachable`/
   `RuntimeError`らしきものなら、この詳細(読めればそれを、読めなければ
   「Consoleを確認してください」という案内文)を画面のエラーに足す。
   トラップ後も別のexport関数からこの`thread_local`を読めることは、
   wasmの仕組み上(トラップは呼び出した特定の処理だけを異常終了させ、
   インスタンス自体やメモリ上の値を破壊しない)正しいはずだが、**実際の
   ブラウザでトラップ後にこの関数を呼べることまでは確認できていない**
   (ブラウザが無い環境のため)。所有者の実機確認で、うまく働かなかった
   場合は報告してほしい。

### 新規テスト

- **最重要の受け入れ条件**: `crates/pcv-wasm/src/convert.rs`の
  `feed_batch_size_stays_bounded_regardless_of_total_point_count`。
  `LazRangeDecompressor`(内部は`RangeDecompressorCore`)の`feed`1回あたりの
  戻り値の大きさが`batch_size * recordWidth()`を超えないことを、点数
  10,000点・100,000点(10倍)の両方で確認する。**点数を10倍にしても、
  1回のfeedが確保する最大バイト数は変わらない**ことを直接アサートする。
- `src/datasource/decompress-partition.test.ts`の`BoundedBatchFlow`
  (6件のテスト)。ブラウザ・wasmに依存しない純粋なクラスとして背圧の
  制御を切り出し、上限に達したら`canAcquire()`がfalseを返すこと、
  `release`で解放すると再びtrueに戻ること、**総リクエスト数を10倍にしても
  同時に抱える量(`inFlightBatches`/`inFlightBytes`)の山は上限を超えず、
  10倍にする前と同じ値になる**ことを、乱数シミュレーションで確認する。
- `crates/pcv-wasm/tests/parallel_push_order_point_set.rs`の
  `reordered_push_matches_sequential_push_point_set`(上記3参照)。
- 既存の`concatenated_ranges_match_a_single_full_range_read`は、新しい
  バッチ駆動APIに合わせて書き直した上で維持した(範囲の分割・バッチの分割
  どちらも結果に影響しないことを確認する形に強化した)。

### 確認したこと(コマンドと結果)

- `cargo test --manifest-path crates/pcv-wasm/Cargo.toml`: 31件成功
  (ユニットテスト25件+結合テスト5ファイル分6件)
- `cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check` /
  `cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target
  wasm32-unknown-unknown --all-targets -- -D warnings`: 成功
- `cargo fmt --all -- --check` / `cargo clippy --workspace --all-targets --
  -D warnings` / `cargo test --workspace`(122件): 成功
- `cargo clippy --manifest-path vendor/copc-writer/Cargo.toml
  --no-default-features --target wasm32-unknown-unknown --lib --
  -D clippy::disallowed_methods`: 成功(disallowed_methodsは引き続き通る。
  このタスクでは`convert.rs`・`alloc_guard.rs`・`lib.rs`に変更を加えたが
  `Instant::now`/`SystemTime::now`の直接呼び出しは増やしていない)
- `npx vitest run src/datasource/decompress-partition.test.ts`: 16件成功
- `npm run build:wasm`: 成功。生成物を今回のコミットに含めた
- `npm run typecheck` / `npm run lint` / `npm run test`(289件) /
  `npm run build`: 成功
- `grep -rl "@tauri-apps/api" src/`: `src/datasource/tauri.ts`のみ(規約2)

### 確認していないこと(所有者に見てもらう必要がある)

- **実機での動作確認はできない。** 所有者に、数千万点規模のLAZ(以前
  メモリ不足が疑われたファイル)をWeb版で変換してもらい、
  1. 変換が完了すること。
  2. devtoolsのタスクマネージャ(`chrome://inspect` or `Shift+Esc`)で、
     変換中のメモリ使用量が、以前(このタスク前)より明らかに低い
     ピークで安定していること(上限が点数に比例しないことの実感的な確認。
     厳密な測定ではなく「増え続けない」ことの確認で十分)。
  3. キャンセルが今までどおり即座に効くこと(pull型に変えても、
     `Worker.terminate()`で止める仕組み自体は変えていない)。
  4. 複数Workerでの変換結果が、従来どおり正しく表示されること(点数・
     見た目がこのタスクの前と変わらないこと)。
  の4点を確認してほしい。
- `alloc_guard`のメッセージが実際に画面のエラー表示に出ることも、わざと
  メモリ不足を起こせる環境でないと確認できない(上記「新しいテスト」の
  とおり、仕組みの正しさはコードレベルでしか確認していない)。

---

## M4-9: E57/PLY/PCDを中間LASを経ずに直接COPCへ変換する(2026-10-03、Sonnet)

### なぜこの節が要ったか(コーディネーターがコードで確認した問題)

M4-4(「E57/PLY/PCDの取り込み」節)が実装した経路は、`crates/pcv-convert/src/import/point.rs`の
`ImportedCloud{ points: Vec<ImportedPoint> }`に**全点をメモリへ読み込んでから**、
いったんプレーンなLAS(非圧縮)へ書き出し(`las_out.rs`)、その後は既存のLAS/LAZ→COPC経路
(`copc-writer`、ADR-0006)にそのまま乗せる設計だった。これには2つの問題があった。

1. メモリが点数に比例する(M4-1・M4-6が素朴な全点メモリ実装として退けたのと同じ問題)。
   数千万点で数GBになり、Android・Webでは破綻する規模
2. 中間LAS(非圧縮)を書いてから読み直しており、余計なディスクI/Oと時間がかかる
3. **アプリへのつなぎ込みが未実装**だった(ファイル選択からE57/PLY/PCDを開けなかった)

### やったこと

- `crates/pcv-convert/src/import/point.rs`: `ImportedCloud`(全点を`Vec`に持つ)を
  廃止し、`RawPoint`(1点ぶんの値)と`PointSource`トレイト(`has_color`・
  `declared_point_count`はヘッダーだけで分かる値、`for_each_point(self, visit)`が
  1点読むたびに即座に`visit`コールバックへ渡す)に置き換えた
- `crates/pcv-convert/src/import/convert.rs`(新設): `PointSource`から直接COPCへ
  書き出す`run_import`。設計の要点は下記「1パスで書ける」参照
- `e57.rs`・`ply.rs`・`pcd.rs`: それぞれ`PointSource`を実装するストリーミング
  読み込みに書き換えた。詳細は各モジュール冒頭のコメントと、ADR-0008の
  2026-10-03追記を参照
- `las_out.rs`・`to_las`を削除した。変換の経路を1本(`convert_to_copc`)にした
- `src-tauri/src/conversion.rs`・`src/datasource/tauri.ts`: デスクトップ・Android
  のファイル選択からE57/PLY/PCDを開けるようにした(下記「アプリへのつなぎ込み」参照)

設計上の判断(1パスで足りる理由、PCDの`binary_compressed`の例外と上限値、
CRSが不明でも`pcv-core`で開けること、Webへつながなかった理由)は、実装の
詳細に深く関わるため**ADR-0008の2026-10-03追記**にまとめた。この節は
受け入れ条件との対応と、確認したコマンド・所有者が確かめる手順に絞る。

### 受け入れ条件との対応

- [x] E57 / PLY / PCD → COPC が、中間LASを作らずに行われる。`to_las`と
      `las_out.rs`が無くなっている(`git rm`済み、上記「やったこと」参照)
- [x] **新規テスト**: メモリが点数に比例しないこと。
      `crates/pcv-convert/tests/import_memory_is_bounded.rs`(新設)。
      `vendor/copc-writer/tests/scratch_read_is_bounded.rs`と同じ考え方
      (1回の`read()`呼び出しが要求する最大バイト数を代理指標にする)だが、
      「点数を変えても最大読み取りサイズが変わらないこと」を直接比較する形に
      した(小:1,000点程度 vs 大:20万点(E57は5万点)で、入力への最大読み取り
      サイズが完全に一致することを確認)。PLYのASCII/binary、PCDのASCII/binary
      (非圧縮)、E57の計5パターンを確認した。`binary_compressed`は対象外
      (ADR-0008参照)
- [x] 各形式の小さな合成ファイルを直接COPCにし、`pcv-core`で開けて、点数・
      座標(スケールの丸めの範囲内)・色が元と一致することを確認した
      (`tests/import_e57.rs`・`import_ply.rs`・`import_pcd.rs`、いずれも
      `pcv_core::CopcFile`でCOPCを開いてノードをデコードする形に書き換えた。
      共通の検証コードは`tests/common/mod.rs`に切り出した)。E57は姿勢の適用も
      確認した(`import_e57.rs`の`combines_multiple_scans_applying_pose_and_spherical_conversion`、
      M4-4のテストを書き換えて残した)。色の検証では、`pcv-core`が
      COPC出力を読む際に行う「8bit色か16bit色かの自動判定」
      (`crates/pcv-core/src/color_depth.rs`、直近のバグ修正対象)を踏まえ、
      期待する16bit色から同じ判定規則で8bit色を導く形にした
      (`tests/common/mod.rs`の`expected_u8_colors`)
- [x] CRSが不明でも出力が`pcv-core`で開ける(`tests/import_pcd.rs`の
      `crs_wkt_is_written_when_provided_and_unknown_when_not`で確認)
- [x] デスクトップ・Androidのファイル選択からE57/PLY/PCDを開け、進捗・
      キャンセル・キャッシュがLAS/LAZと同じく働く(下記「アプリへのつなぎ込み」
      参照。**Android実機での確認はできていない**。下記「所有者が確かめる手順」参照)
- [x] Webの扱い(つないだか、知らせるだけか)と理由が記録されている
      (ADR-0008参照。結論: 今回はつながない)

### アプリへのつなぎ込み(デスクトップ・Android)

`src-tauri/src/conversion.rs`の`decide_and_start`が
`pcv_convert::import::detect_format(path_for_naming)`でE57/PLY/PCDかどうかを
拡張子から判定し、`run_conversion_thread`に`import_format: Option<SourceFormat>`
として渡す。`None`(LAS/LAZ)なら今までどおり`streaming::convert`、`Some`なら
新設の`import::convert_to_copc`を呼ぶ。どちらも同じ`ReadProgress`・
`copc_core::Result<()>`でやり取りする(`ImportError`から`copc_core::Error`への
`From`実装を`pcv_convert`側に用意し、`Cancelled`かどうかの判定を含めて呼び出し側が
経路によらず同じ`match`で扱えるようにした)ため、**進捗イベント・キャンセル・
キャッシュ(同じファイルを二度変換しない)・空き容量の事前チェック・一時
ディレクトリの誘導は、M4-3がLAS/LAZ向けに作った仕組みにそのまま乗っている**
(新しい仕組みは増やしていない)。

`src/datasource/tauri.ts`の`pickLocalFile`のファイル選択フィルタに
`e57`/`ply`/`pcd`拡張子を追加した(デスクトップ・Androidとも同じ
`tauri-plugin-dialog`の`open()`を使うため、片方だけの対応にはならない)。

CRSのUI選択は作っていない(タスクシートの指示どおり)。`convert_to_copc`への
`crs_wkt`は常に`None`を渡す(ADR-0008「CRSが不明でも`pcv-core`で開けること」参照)。

### 範囲外にしたこと(正直に)

- **Web版への配線**: wasm32でビルドできる見込みが高いことまでは確認したが
  (ADR-0008参照)、実際の配線(OPFS経由のバッチ駆動、UI、進捗・キャンセル)は
  行っていない。Web版は引き続き「デスクトップ版で変換してください」という
  案内のまま
- **CRSの推測・UI選択**: ADR-0008・M4-4から変えていない。推測しない方針のまま
- **binary_compressedの上限を超えた場合の回避策**(分割変換など)は提供していない。
  エラーメッセージで「デスクトップ版で、より小さく分割するか、ASCII/binary
  (非圧縮)形式に変換してください」と案内するに留める
- **Android実機・GUIでの確認全般**: 確認手段が無いため、下記「所有者が
  確かめる手順」に委ねる

### 確認したコマンドと結果

```
$ cargo fmt --all -- --check
(差分なし)

$ cargo clippy --workspace --all-targets -- -D warnings
(警告・エラー無し)

$ cargo test --workspace
pcv-convert(ユニットテスト): 41 passed
pcv-convert(統合テスト: import_e57/import_memory_is_bounded/import_pcd/
            import_ply/import_to_copc/parallel_laz_decompression/
            roundtrip/streaming_conversion):
            1+5+5+5+1+2+1+6 = 26 passed
pcv-core: 39 passed
pcv-tauri: 6 passed
失敗 0

$ cargo build -p pcv-core --target wasm32-unknown-unknown
Finished(成功。規約1を満たす。`pcv-core`には一切触れていない)

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
Finished(成功。`crates/pcv-wasm`には一切触れていない、既存の挙動を壊していないことの確認)

$ npx tsc --noEmit
(出力無し、終了コード0)

$ npx eslint .
(出力無し、終了コード0)

$ npx vitest run
Test Files  28 passed (28)
     Tests  240 passed (240)

$ npm run build
✓ 78 modules transformed.
✓ built in 768ms
```

`npm run build:wasm`は`crates/pcv-wasm`に触れていないため実行していない
(wasm生成物に変更が無い)。

CI(`ci.yml`)・Pages(`pages.yml`)・Androidビルド(`gh workflow run release.yml`)の
run idは、push後にコーディネーターが確認すること(「所有者への報告」節に記す)。

### 所有者が確かめる手順

1. **デスクトップ: E57/PLY/PCDを開く**
   - 拡張子`.e57`/`.ply`/`.pcd`のファイルを「ファイルを選ぶ…」で選ぶ。
     進捗(%・プログレスバー・経過時間)が出て、変換完了後に自動的に点群が
     表示されることを確認する(LAS/LAZと同じ見せ方のはず)
   - 変換中に「キャンセル」を押し、UIが操作できたまま変換が止まり、
     一時ファイルと書きかけの出力が残っていないことを確認する
   - 同じファイルをもう一度開き、変換が走らず即座に開くことを確認する
   - 色・座標が元のファイルと対応しているか、見た目で確認する(測量用途の
     実データがあれば、QGIS等の別ツールで同じファイルを開いて見た目を
     比べるとより確実)
2. **デスクトップ: PCDのbinary_compressedで大きすぎる入力**
   - 展開後サイズが512MiBを超えるbinary_compressedのPCD(もしあれば)を
     開こうとして、展開を始める前にエラーバナーで知らされることを確認する
     (無ければこの手順はスキップしてよい。自動テストで同等の状況は確認済み)
3. **Android実機**: `gh run download <run-id> -n android-apk`でAPKを取得し、
   OPPO Pad Air等にインストールする。E57/PLY/PCDファイルを選び、
   - 変換が始まり進捗が出るか
   - 完了後に自動的に開くか
   - `adb logcat -s pcv:*`でエラーが出ていないか(ADR-0013)
   を確認する。**これらはすべて未確認**(実機・Android向けビルド環境が
   この開発環境に無いため)
4. **Web版**: `.e57`/`.ply`/`.pcd`はそもそもOSのファイル選択ダイアログに
   出てこない(`accept`フィルタを変えていないため)ことを確認する。意図した
   挙動(今回はつながない)であり、不具合ではない

### 並行作業との調整

`vendor/copc-writer/`には一切触れていない(別のエージェントが変換の後処理の
並列化を進めている)。`crates/pcv-convert/src/streaming.rs`も変更していない
(LAS/LAZ経路は`crate::streaming::convert`のまま、今回触ったのは
`crates/pcv-convert/src/import/`配下と`src-tauri/src/conversion.rs`・
`src/datasource/tauri.ts`)。

### 追記: 数億点規模のPCDテストデータを作る(2026-10-04、Sonnet)

所有者が「数億点規模のPCDで試したい」が、手元に大きなPCDが無い。既存のCOPC
(`data/sofi.copc.laz`、364,384,576点、RGB無し・強度あり)をPCDへ書き出せば、
同じ点を使ってPCD→COPCの経路(このM4-9の`convert_to_copc`)を大規模データで
試せる。**本番の変換経路には含めず、examplesとして追加した**(所有者の指示どおり)。

#### 作ったもの

- `crates/pcv-convert/examples/copc_to_pcd.rs`: COPC → PCD(binary、非圧縮)の
  書き出しツール。COPCのhierarchyをノード単位(`pcv_core::CopcFile::read_node`)で
  読み、読んだその場でPCDへ書く。全点を一度にメモリへ載せない(下記「メモリが
  点数に比例しないこと」参照)
- `crates/pcv-convert/examples/import_bench.rs`: 作ったPCDを本番の経路
  (`pcv_convert::import::convert_path_to_copc`、M4-9の`convert_to_copc`)で
  COPCへ変換し直すための薄いラッパー(`examples/convert_streaming.rs`と同じ
  考え方)。計測(所要時間・ピークメモリ)はプロセスの外(PowerShell)から行う

#### 座標の型: double(f64)を選んだ理由

sofiはUTM規模の大きな座標(X・Yが50万〜400万のオーダー)を持つ。検討した
3案とその判断:

1. **f32でそのまま書く**: 仮数部が足りずmm〜cm単位の精度が失われる(M1-2の
   `node_format.rs`が同じ理由でノードローカル相対座標を導入しているのと
   同根の問題)。却下
2. **全点から共通のオフセットを引いてf32で書く**: 精度は保てるが、
   オフセットをどこかに記録し、変換後に正しく足し戻す仕組みが別途要る。
   さらに**PCDのヘッダー`VIEWPOINT`はこの用途に使えない**ことを
   `crates/pcv-convert/src/import/pcd.rs`のソースで確認した——読み込み側
   (`PcdSource::for_each_point`)はx/y/zフィールドの値をそのままCOPCへ渡す
   だけで、`VIEWPOINT`を足し戻す処理が無い(`pcd-rs`の`DynReader`自体も
   `VIEWPOINT`をメタデータとして保持するだけで、座標変換には使わない)。
   つまり「`VIEWPOINT`にオフセットを書いて読み込み側で足し戻す」という
   設計は実際には機能しない。オフセットをファイル名や別ファイルで運ぶ案も
   検討したが、実装・検証の手間が増える割に得るものが(桁を減らす以外)無い。却下
3. **double(f64)でそのまま書く**: 何も考えずに済む。採用

`pcd.rs`の`field_to_f64`(44行目〜)は`Field::F64`を含む全数値型を素直に
f64へ変換しており、doubleで書いても読み込み側に問題が無いことをソースで
確認済み(`match field { ... Field::F64(v) => v.first().copied().unwrap_or(0.0), ... }`)。
コストはf32に対して1点あたり12バイト増えるだけ(xyzで24B対12B)で、
3.64億点でも増加分は高々4.4GB程度に収まり、実行前に確認したディスク空き容量
(278〜299GB)に対して無視できる。**よってx/y/zはdoubleで書くことにした。**

intensityは元のLAS/COPCの型(u16)のまま`TYPE U, SIZE 2`で書いた(値の変換・
丸めが不要)。rgb(色を持つ入力の場合)は`0x00RRGGBB`のpacked `u32`
(`TYPE U, SIZE 4`)で書いた(読み込み側`decode_packed_rgb`の`Field::U32`
分岐がビット演算だけで復元でき、浮動小数点のビット再解釈のような変換が
不要なため)。sofiはRGBを持たないため、`data/sofi.pcd`のFIELDSは
`x y z intensity`の4つのみ。

#### メモリが点数に比例しないこと

COPCのhierarchyをノード単位で読み、都度PCDへ書き出す設計にした。1ノードの
点数はCOPCの`max_points_per_node`(既定10万点)が上限なので、オンメモリに
載るのは常に高々その1ノード分(数MB)だけであり、全体の点数が3.64億点でも
1,000万点でも、ピークメモリは変わらない。ノードキー自体は先に全て
(`Vec<NodeKey>`)メモリへ集めるが、ノード数は点数ではなくoctreeの分割数に
比例するだけで、sofi規模でも8,588個(下記「出力の検証」参照)程度にとどまる。

PCDの`POINTS`ヘッダーは、COPCのヘッダーが申告する総点数
(`CopcFile::info().point_count`)から、1点も読まずに先に分かる値として書いた。

#### 実行環境とディスク空き容量の事前確認

`TaskSheets/M4-1b`と同じ機体(Core i5-14600K、RAM 31.8GB、Windows 11)。
実行前に`Get-PSDrive C`でCドライブの空き容量を確認した: **278〜299GB**
(作業中の増減込み)。sofi.pcd(9.47GB)・変換時の一時ファイル(スパイル等、
M4-1bの実測(sofi入力2.03GB→一時ファイルピーク21.864GB)を参考にしても
最大20GB程度と見積もれる)・出力COPC(2.4GB)を合計しても30〜40GB程度で、
空き容量に対して十分な余裕があることを確認した上で実行した。

#### 作ったファイル

| ファイル | 元データ | 点数 | サイズ |
|---|---|---|---|
| `data/sofi.pcd` | `data/sofi.copc.laz`(364,384,576点、RGB無し) | 364,384,576 | 9,473,999,172 バイト(9474.00 MB) |
| `data/autzen.pcd`(所有者が手早く試せる小さいもの) | `data/autzen-classified.copc.laz`(10,653,336点、RGBあり) | 10,653,336 | 319,600,284 バイト(319.60 MB) |

どちらも**コミットしていない**(`data/`はgitignore済み。`git status`で
未追跡のままであることを確認済み)。

#### 実測: COPC → PCD(`copc_to_pcd`、このタスクで新設したツール自体)

```
$ ./target/release/examples/copc_to_pcd.exe data/autzen-classified.copc.laz data/autzen.pcd
点数(ヘッダー): 10653336
色を持つか    : true
書き出した点数: 10653336
出力サイズ    : 319.60 MB
所要時間      : 4.78 秒

$ ./target/release/examples/copc_to_pcd.exe data/sofi.copc.laz data/sofi.pcd
点数(ヘッダー): 364384576
色を持つか    : false
書き出した点数: 364384576
出力サイズ    : 9474.00 MB
所要時間      : 162.07 秒
```

所要時間はプロセス内部(`Instant`)の計測のみで、プロセス外(壁時計)では
測っていない(正直に書く)。点数比(364,384,576 / 10,653,336 ≈ 34.2倍)に
対し時間比(162.07 / 4.78 ≈ 33.9倍)がほぼ一致しており、この2点の範囲では
処理時間が点数にほぼ比例していることが分かる。

#### 実測: PCD → COPC(本番の経路、`import_bench`経由)

**計測した時点のmainのコミット**: `e7f8258e8cc2c73fd62ade2169cfc75eb4da6090`
(M4-10「ノード圧縮の並列化(parallel-compress採用)」を含む。並行して進んでいた
変換の後処理の並列化が、この計測の直前にmainへ入った)。`cargo build -p
pcv-convert --release --examples -v`で`copc-writer`に`parallel-lod`・
`parallel-compress`の両フィーチャが実際に有効化されていることを確認した上で
計測した(`cargo clean -p copc-writer --release`で強制再ビルドし、
`feature="parallel-lod"`・`feature="parallel-compress"`の両方がコンパイラ
呼び出しに現れることを確認)。

ピークプライベートメモリの測り方はM4-1bのコーディネーターによる再計測と同じ
(`System.Diagnostics.Process.PrivateMemorySize64`を500msごとにポーリングして
最大値を取る。ワーキングセットではなくプライベートメモリを使う理由も
M4-1bと同じ: `copc-writer`の一時ファイルはmmapされるため、ワーキングセットは
メモリ不足の指標にならない)。

```
$ cargo run -p pcv-convert --release --example import_bench -- data/sofi.pcd <出力> <spill_dir>
入力      : data/sofi.pcd
出力サイズ(入力): 9474.00 MB
  読み込み中: 320000000/364384576
変換完了(内部計測): 170.80 秒
点数            : 364384576
出力サイズ      : 2393.07 MB

=== PowerShellでの外部測定 ===
ElapsedSeconds        : 171.19
PeakPrivateMemoryBytes: 243,486,720
PeakPrivateMemoryGiB  : 0.227
```

**出力の検証**(`examples/verify.rs`、`CopcFile::open`→hierarchy点数合計→
`read_node`):

```
入力の申告点数  : 364384576
CloudInfo点数   : 364384576
hierarchyノード : 8588 個, 点数の合計 = 364384576
read_nodeで確認したノード数: 5(いずれも申告点数と一致)
OK: pcv-core で開け、点数が一致し、ノードを読めた
```

同じ経路でautzen.pcd→COPCの往復も確認した(内部計測6.27秒、hierarchyノード
222個、点数10,653,336が一致、`read_node`5個確認)。

**点数の一致(このタスクの核心の受け入れ条件)**: 元の`sofi.copc.laz`
(364,384,576点)→`sofi.pcd`(364,384,576点)→本番経路で変換した
`sofi_from_pcd.copc.laz`(364,384,576点、hierarchy合計も一致)。**3箇所とも
一致した。**

**参考: M4-1bのsofi(LAS経由)の実測との比較(単純比較はできないことに注意)**。
M4-1bはsofiを**LASとして**(`sofi.copc.laz`を生LAZとして)`copc-writer`の
高水準APIへ流し込んだ計測で、時間553.81秒(エージェント)〜1,079.3秒
(コーディネーター再計測)、プライベートメモリピーク0.053GiBだった。
今回はPCDとして(中間LASを経ない、M4-9の`convert_to_copc`経路で)流し込み、
時間170.80〜171.19秒、プライベートメモリピーク0.227GiBだった。**mainの
コミットが異なる**(今回はM4-10のoctree分割並列化・ノード圧縮並列化の両方が
入った後、M4-1bはどちらも入っていない)ため、速くなった分がどちらに
起因するか(並列化によるものか、入力形式の違いによるものか)はこの計測
だけでは切り分けられない。**プライベートメモリが0.053→0.227GiBに増えている
点は、並列化で同時に扱う一時ファイル・バッファの数が増えたことが一因と
推測されるが、実測で確認したわけではない**(M4-8のタスクシートに記録済みの
`parallel_lod_open_files_bounded`テストが「点数に比例しない」ことは保証して
いるが、絶対値がどの程度増えるかは別の話)。いずれにせよ0.227GiBは
8GBの基準に対して無視できるほど小さく、判断に影響しない。

#### 範囲外にしたこと(正直に)

- **PCDからのCRSの引き継ぎ**: 今回作った`sofi.pcd`・`autzen.pcd`はCRS情報を
  持たない(PCD形式自体がCRSの概念を持たないADR-0008の既存の制約どおり)。
  本番経路で変換すると、他のPCD入力と同じく「CRS不明」のCOPCになる
  (M4-9「CRSが不明でも`pcv-core`で開けること」の既存動作そのまま)。
  これは意図した挙動であり、不具合ではない
- **座標の往復精度の検証**: `copc_to_pcd`は`pcv_core::CopcFile::read_node`が
  返す`NodeBuffer`(M1-2のノードローカル相対座標形式、原点をf32に丸める)を
  経由して世界座標を復元している。これはビューアが実際に描画で使っている
  のと同じ経路・同じ精度であり、ノードのバウンディングボックスが大きい
  (特にルート付近の)ノードではcm〜m単位の丸め誤差が入りうる。本タスクは
  「点数の一致」を受け入れ条件として実行したため、座標値そのものの
  往復精度(mm単位で元に戻るか)は検証していない。より高精度が要るなら、
  `copc_reader::CopcReader`を直接使って(`pcv_core`を経由せず)f64のまま
  読み出す実装に変える余地がある
- **一時ディスク使用量のピーク**: M4-1bが記録したような一時ファイルサイズの
  ポーリングは行っていない(このタスクの受け入れ条件に無いため)

#### 確認したコマンドと結果

```
$ cargo build -p pcv-convert --release --examples
Finished(警告無し)

$ cargo fmt --all -- --check
(差分無し)

$ cargo clippy -p pcv-convert --example copc_to_pcd --all-targets -- -D warnings
(警告・エラー無し)

$ cargo clippy --workspace --all-targets -- -D warnings
(警告・エラー無し)

$ cargo test --workspace
pcv-convert(ユニットテスト): 41 passed
pcv-convert(統合テスト): 26 passed
pcv-core: 39 passed
pcv-tauri: 7 passed
失敗 0(M4-9時点から変わっていない。examplesはテスト対象に含まれないため、
既存のテスト件数に影響しない)
```

CI(`ci.yml`)の最新runは、push後に所有者または次のエージェントが
`gh run list --branch main --limit 5`で確認すること(本セッションでは
`gh`を使った確認を行っていない)。

#### 所有者が確かめる手順

1. **大きいPCDを開く**: アプリ(デスクトップ)の「ファイルを選ぶ…」から
   `data/sofi.pcd`(約9.47GB)を選ぶ。進捗(%・プログレスバー・経過時間)が
   出て、変換完了後に自動的に点群が表示されることを確認する(所要時間は
   このセッションの計測で約171秒だったが、実機では空き容量・ディスク速度に
   よって変わりうる)
2. **小さいPCDですぐ試す**: 同様に`data/autzen.pcd`(約320MB、10,653,336点、
   色あり)を選ぶ。こちらは数秒〜十数秒で変換が終わるはず
3. **点数の確認**: どちらも、変換後に表示される点数(左パネルの点数表示、
   または開発者ツールのログ)が、元のCOPC(sofi: 364,384,576、autzen:
   10,653,336)と一致することを確認する
4. **色**: `sofi.pcd`は色を持たない(強度のみ)ため単色・強度ベースの
   着色になるはず。`autzen.pcd`は色を持つため、元の`autzen-classified.copc.laz`
   を開いたときと近い見た目になるはず(座標の丸め誤差程度の差はありうる、
   上記「範囲外にしたこと」参照)

---

### 追記2: Web版でPCDを開くと「空き容量が足りません」と出る不具合の調査と対応(2026-10-04、Sonnet)

#### 症状(所有者の報告)

Web版でPCD(`data/sofi.pcd`、9.47GB、364,384,576点、座標f64)を開くと、
変換を試みる前に「空き容量が足りません」と出る。

#### 原因(コーディネーターの見立てを確認)

1. **Web版はCOPCでないファイルをすべてLAS/LAZ変換の経路に回していた。**
   `src/state/useCopcViewer.ts`の`openFile`は、`isCopcFile`(ヘッダー判定)で
   「COPCでない」と分かったファイルを、形式を確かめずに`WebSource.
   startConversion`(LAS/LAZ専用)へ渡していた。PCD・PLY・E57をWeb版で変換する
   経路は、M4-9本体では「後回し」にしたまま繋いでいなかった(本節冒頭の
   「実施記録」参照)
2. **容量の事前確認がファイルサイズ×11で見積もっていた。** `src/datasource/
   opfs.ts`の旧`hasEnoughQuota`は「入力ファイルサイズ×11」で見積もっていた。
   この係数はADR-0006/M4-1bの実測(sofi.copc.laz、**LAZ圧縮**)から来ており、
   **非圧縮・f64座標のPCDでは大きく外れる**: 9.47GB×11≈104GBという、実際に
   必要な量(後述)の何倍もの過大な見積もりになり、ブラウザのストレージ
   クォータ(`TaskSheets/M4-import-and-conversion.md`のM4-6a 7節、Chrome/
   Chromium系で総容量の60%等)を簡単に超えてしまっていた

#### 直したこと

**1. 容量の見積もりを点数から出す(`src/datasource/point-count-estimate.ts`、新設)**

変換の一時領域(OPFSスクラッチ)・出力COPCのサイズはどちらも**点数**に
ほぼ比例する(copc-writerの設計、M4-1b/ADR-0006の実測)。ファイルサイズでは
なく点数から見積もることで、入力の圧縮の有無・座標のデータ型によらず
一貫した見積もりになる。

- LAS/LAZ: ヘッダーのバイト配置(ASPRS LAS仕様書)を直接読む。LAS 1.4は
  64bitの点数フィールド(オフセット247)を持つため、32bitのレガシー
  フィールド(オフセット107。点数が`u32`に収まらない、または点フォーマット
  6〜10では0になりうる)より優先する
- PCD: ヘッダー(ASCIIテキスト)の`POINTS`行を読む。無ければ`WIDTH`×
  `HEIGHT`で計算する(PCD仕様では`POINTS`は必須だが、安全策として)
- PLY: ヘッダー(binary形式でもヘッダー自体は常にASCII)の`element vertex N`
  行を読む
- E57: このセッションでは実装していない(後述「やらなかったこと」参照)

どの読み取りも**ヘッダー(ファイル先頭の小さい範囲)だけ**で完結し、
メインスレッドから`File.slice`+`arrayBuffer()`/`text()`で読める
(`FileReaderSync`のようなWorker専用APIは不要)。

1点あたりのバイト数は`src/datasource/opfs.ts`に新設した定数で管理する:
`SCRATCH_BYTES_PER_POINT`(=60、M4-1bの実測した一時ディスクのピーク÷点数の
うち安全側の最大値)+`OUTPUT_BYTES_PER_POINT`(=10、M4-1bの実測した出力
サイズ÷点数を切り上げ)。ファイルサイズ×11という旧来の見積もりは、点数が
読み取れない場合のフォールバックとして`requiredScratchBytes`に残した。

**2. 形式を先に判定してから変換経路を選ぶ(`src/datasource/source-format.ts`、新設)**

`detectSourceFormatByName`(拡張子判定、`crates/pcv-convert/src/import/
mod.rs`の`detect_format`と同じ考え方)で、`useCopcViewer.ts`の`openFile`が
`isCopcFile`の次に形式を確かめ、PCDならPCD専用の経路、PLY/E57なら
(後述の理由で)案内を出して終える、という分岐にした。

**3. Web版でPCDを中間LASを経ずに直接COPCへ変換する(`WasmPcdConverter`)**

`crates/pcv-wasm/src/pcd_import.rs`(新設)に、`crates/pcv-convert/src/
import/pcd.rs`と同じロジック(`pcd-rs`でのフィールド対応、
`binary_compressed`の展開後サイズ上限512MiBの事前チェック、
`scale`/`offset`の選び方)をOPFS向けに移植した。`WasmConverter`(LAS/LAZ)と
同じ部品(`SpillWriter`→`finalize`→`write_copc_from_spill_with_fs`)を使うが、
PCDの読み込みはLAZのようなエントロピー復号を伴わないため、M4-7の並列展開の
仕組みは持たない(`feed`は常に逐次バッチループ)。

Worker側(`src/datasource/copc.worker.ts`)は、新しいメッセージ
`pcdConvertStart`で`handlePcdConvertStart`/`runPcdConversion`を呼ぶ
(LAS/LAZ版`runConversion`とほぼ同じ構造の、並列展開を持たない簡略版)。
準備段階の進捗表示(M4-6追記4で実装した`preparing`フェーズ)・キャンセル・
キャッシュ(`opfs.ts`の指紋ベースの仕組みをそのまま流用)・ダウンロードは
LAS/LAZ版と同じ仕組みに乗る(コードの変更不要だった)。

**なぜ`crates/pcv-convert`を直接の依存にしなかったか**: `crates/pcv-wasm/
Cargo.toml`の`pcd-rs`依存のコメントに詳細を記録した。要点は2つ:

1. `pcv-wasm`はルートワークスペースの外にある独立した1クレートの
   ワークスペースだが、`pcv-convert`はルートワークスペースの通常メンバー。
   パス依存で引き込むと、`pcv-convert`の`Cargo.toml`がワークスペースを
   持たないため上位のルートワークスペースへ参加しようとし、`pcv-wasm`
   自身の独立したワークスペース宣言と衝突してcargoがエラーになる
   (実際に試して確認した)
2. 仮にこれを回避できたとしても、`pcv-convert`の`copc-writer`依存は
   `parallel-lod`/`parallel-compress`(`rayon`使用)を要求しており、
   同じ`[patch.crates-io]`先(`vendor/copc-writer`)を共有する以上、
   依存グラフのフィーチャ統合で`pcv-wasm`のwasm32ビルドにまで`rayon`が
   混入してしまう(「wasm32向けビルドに`rayon`は入り込まない」という、
   このプロジェクトの前提を破る)

そのため、PCDの読み込みロジック自体を`pcd_import.rs`に独立に書いた
(意図した重複。`pcd-rs`・`byteorder`はwasm32-unknown-unknownでのビルドを
実際に確認した上で、新規の直接依存として追加した)。

#### やらなかったこと(正直に)

- **Web版でのPLY/E57の変換**: `e57`クレートも`pcd-rs`と同様に
  wasm32-unknown-unknownでビルドできることを実際に確認した(デフォルト
  フィーチャで、新規に`cargo build --target wasm32-unknown-unknown`する
  最小クレートを作って検証した)。PLYも外部クレートに依存しない自前実装
  (`crates/pcv-convert/src/import/ply.rs`、約600行)なので技術的な障害は
  無い。**それでも本セッションでは実装を見送った**: PCD(具体的に報告された
  不具合の形式)の修正を優先し、PLY/E57はコードの複製量(PLYは600行規模、
  E57はXMLパーサ込みで139行だが呼び出し側の設計も含めると相応の量)と
  レビュー・テストに必要な時間を考えると、このセッションの範囲では
  中途半端に終わらせるリスクの方が大きいと判断した。PLY/E57を選んだ場合は
  「このファイル形式はWeb版ではまだ変換できません。デスクトップ版で
  COPC(.copc.laz)に変換してから開いてください」という案内を出す
  (`useCopcViewer.ts`)。将来実装する場合は、この追記と`pcd_import.rs`の
  構造をそのまま踏襲できる見込み
- **E57の点数見積もり**: PCD/PLYと違い、E57はXML+バイナリ構造で、
  スキャンごとの点数の合計を軽量に読む実装をこのセッションでは用意して
  いない(そもそもWeb版のE57変換自体を見送っているため、見積もりだけ
  作っても使い道が無い)
- **実際のブラウザでの動作確認**: GUIを目視できない環境のため、Web版で
  実際にPCDを選んで「空き容量不足」が解消すること、変換が完走すること、
  開いた点群が正しく表示されることは確認できていない。下記「所有者が
  確かめる手順」に委ねる

#### 新規テスト

- `src/datasource/point-count-estimate.test.ts`: LAS(1.2のレガシーフィールド・
  1.4の拡張フィールド・拡張フィールドが0のときのフォールバック)・PCD
  (`POINTS`・`WIDTH`×`HEIGHT`フォールバック)・PLY(`element vertex`、
  他のelementが混在する場合)の各ヘッダー解析を確認する
- `src/datasource/source-format.test.ts`: 拡張子判定(大文字小文字を
  区別しない、未知の拡張子は`unknown`)
- `src/datasource/opfs.test.ts`に追加: `requiredBytesForPointCount`
  (M4-1bの実測値どおりの係数か、点数に比例するか、sofi.pcd相当で旧来の
  ファイルサイズ×11の見積もりより現実的な値になるか)、`hasEnoughQuota`の
  シグネチャ変更(ファイルサイズではなく見積もり済みのバイト数を受け取る
  形に変えた)
- `src/datasource/web-protocol.test.ts`に追加: `buildPcdConvertStartRequest`
- `crates/pcv-wasm/tests/memory_pcd_conversion.rs`(新設): `MemoryScratchFs`
  経由で、バッチ駆動のPCD読み込み→spill→COPC書き出しが`pcv-core`で開ける
  ことを確認する統合テスト(`memory_scratch_conversion.rs`のPCD版)
- `crates/pcv-wasm/src/pcd_import.rs`の`#[cfg(test)]`: `choose_scale_offset`
  の回帰テスト(`crates/pcv-convert/src/import/scale.rs`の複製であることの
  確認)、パック済みrgbのデコード、`binary_compressed`の展開後サイズの
  覗き見(検出する場合・しない場合の両方)

#### 確認したコマンドと結果

```
$ cargo test --manifest-path crates/pcv-wasm/Cargo.toml
24 passed(unittests、pcd_import::testsの新規5件を含む)
1 passed(memory_pcd_conversion、新規)
1 passed(memory_scratch_conversion)
1 passed(buffered_file_reader_reduces_read_calls)
2 passed(sequential_lod_open_files_bounded)

$ cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check
(差分無し)

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --all-targets -- -D warnings
(pcv-wasm自身は警告0件)

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
Finished(成功。pcd-rsを新規に含めても成功することを確認)

$ cargo fmt --all -- --check / cargo clippy --workspace --all-targets -- -D warnings / cargo test --workspace --release
いずれも差分無し・警告0件・成功(vendor/copc-writer・crates/pcv-convertは
無変更)

$ npm run build:wasm
成功(pcv_wasm_bg.wasmを再生成。808,094→1,089,920バイト。pcd-rsを含めた分
サイズが増えた。.d.tsに`WasmPcdConverter`クラスが追加されたことを確認した)

$ npx tsc --noEmit / npx eslint . / npx vitest run / npm run build
すべて成功(testは31ファイル276件)
```

CI・Pagesのrun idは所有者への最終報告に記載する。

#### 並行作業との分担

`vendor/copc-writer/`・`crates/pcv-convert/`には触れていない(並行作業中の
別エージェントが後処理の圧縮の並列化・PCDテストデータ作りを担当している
ため。調べるために読んだだけ)。

#### 所有者が確かめる手順

1. **Web版: `data/sofi.pcd`を開く。** GitHub PagesのサイトでPCDファイルを
   選ぶ(ファイル選択ダイアログの絞り込みに`.pcd`を追加したので、既定の
   表示でも選べるはず)。「空き容量が足りません」と出ずに変換が始まり、
   進捗(%・プログレスバー)が表示され、完了後に自動的に点群が表示される
   ことを確認する
2. **Web版: `data/autzen.pcd`(小さい方、約320MB)も同様に確認する。**
   色が付いて表示されることを確認する(RGBを持つPCDのため)
3. **Web版: 同じファイルの再変換防止。** 同じPCDをもう一度選び、変換が
   走らず即座に開くことを確認する
4. **Web版: PLY/E57を選んだ場合の案内。** もし手元にPLY/E57ファイルが
   あれば、「すべてのファイル」であえて選び、「このファイル形式は
   Web版ではまだ変換できません。デスクトップ版で変換してください」という
   趣旨のメッセージが、誤った「空き容量不足」ではなく表示されることを
   確認する
5. **デスクトップ・Android(回帰確認)**: 変わっていないはずだが、念のため
   E57/PLY/PCD・LAS/LAZを開いて変換が今までどおり動くことを確認する

---

## M4-8: 後処理(octree構築・ノードごとのLAZ圧縮・書き出し)を速くする(2026-10-03、Opus計画・Sonnet実装)

### 背景・所有者の要望

M4-7で読み込み(LAZ展開)を並列化し、beer.lazの読み込み段階が約5倍速くなった。その結果、
**並列化していない後処理(M4-7実測で64〜73秒)が変換時間の大半を占めるようになった。**
所有者も「octree構築に時間がかかっている」と見ている。`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`の
教訓(並列度だけを上げて1回あたりのコストを疑わなかった失敗)に倣い、今回も**まず測ってから
並列化するか決める**。

開発機: Core i5-14600K(14コア/20論理スレッド)、RAM 31.8GB、Windows 11(M4-7と同じ機体)。
計測対象: `C:\rust\point-cloud-viewer\data\beer.laz`(66,848,096点、448.7MiB。worktreeの外の
絶対パスから読んだ。出力はコミットしていない)。

### 1. まず測る: 後処理の内訳(実測)

専用の計測ハーネス`crates/pcv-convert/examples/post_process_stage_bench.rs`を新設した
(`cargo run -p pcv-convert --release --example post_process_stage_bench -- <file>`)。

後処理を次の3段階に分けて測るため、`vendor/copc-writer`に**計測専用のAPI**
(`PostProcessStageTimings`構造体、`write_copc_from_spill_with_fs_and_timings`関数。
本番の変換経路は使わない)を追加した。既存の`write_copc_inner`に`Instant`での区間計測を
3箇所(octree分割の前後・ノード圧縮の前後・残り)挟んだだけで、アルゴリズム自体は
変えていない。

1. **octreeの分割**(LODの索引作り、点のノードへの振り分け。`lod.rs`の`build_lod_index`)
2. **ノードごとのLAZ圧縮**(圧縮したバイト列を出力ストリームへ書く部分を含む。`writer.rs`の`compress_nodes`)
3. **書き出し**(ヘッダー・VLR・hierarchyの書き出し。圧縮以外の全て)

あわせて、**一時ファイルの読み戻し(`read_at`)の重さ**を単独で測った。`SpillReader::xyz_at`
(octree分割が点ごとに呼ぶ、24バイトの範囲読み)と`record_into`(ノード圧縮が点ごとに呼ぶ、
レコード全体の範囲読み)を、本番と同じ経路(mmap上の範囲読み)で全点ぶんまとめて1回だけ
区間計測する方式にした。個々の`read_at`呼び出しを`Instant`で包む案(`ScratchFs`ラッパー)も
検討したが、数億回の呼び出しに計測自体のオーバーヘッド(関数呼び出し+`Instant::now()`2回)
が無視できない大きさで乗ってしまう(観測者効果)ため採用しなかった。

**実測結果**(`cargo run -p pcv-convert --release --example post_process_stage_bench -- beer.laz`、
改修前のコードで4回実行):

| 実行 | [1]octree分割 | [2]ノード圧縮 | [3]書き出し | 合計 |
|---|---|---|---|---|
| 1回目 | 48.610秒(69.9%) | 20.601秒(29.6%) | 0.004秒(0.0%) | 69.552秒 |
| 2回目 | 39.694秒(52.0%) | 36.051秒(47.2%) | 0.087秒(0.1%) | 76.372秒 |
| 3回目 | 32.601秒(70.9%) | 12.862秒(28.0%) | 0.195秒(0.4%) | 45.992秒 |
| 4回目 | 33.350秒(70.8%) | 13.317秒(28.3%) | 0.101秒(0.2%) | 47.113秒 |

4回とも揺れが大きい(合計46〜76秒)。`ADR-0006`が記録した既知の揺れ(OSページキャッシュの
温まり方・Defenderのリアルタイム保護等)と同種とみられ、原因は深追いしていない。揺れは
あるものの、**4回中3回でoctreeの分割がノード圧縮より明確に大きく(約70%)、残り1回でも
ほぼ互角(52.0% vs 47.2%、分割の方がわずかに大きい)**。書き出し(ヘッダー・VLR・hierarchy)は
常に1秒未満で無視できる。

参考として、`read_at`単独の実測(全点ぶん一括、揺れが大きいため参考値):
`xyz_at`全点が0.861〜4.463秒、`record_into`全点が0.867〜2.409秒。どちらも後処理全体
(46〜76秒)に対して小さく、**読み戻し自体(mmap上の範囲読み)が後処理のボトルネックでは
ない**ことを示している。

**寄り道: fsync(`sync_all`)を疑って計測した(結果、原因ではなかった)**。`NativeScratchFs`の
`finish_temp`は一時ファイルを確定するたびに`sync_all`(fsync)を呼んでおり、octree分割は
多数の一時ファイル(root・partition・order)を作っては確定するため、「大量のfsyncが
ボトルネックではないか」という仮説を立てた。一時的に呼び出し回数・累積時間を数える
カウンタを仕込んで測ったところ、1,990回・合計4.619秒だった(octree分割の実測41.556秒の
約11%)。**ボトルネックではなかった**ため、この仮説は退け、カウンタは削除した
(ADR-0007の教訓どおり、疑ったら実測で裏付けを取り、裏付けが無ければ別の説明を探す)。

### 判断

**octreeの分割(LOD構築)が後処理全体の過半数(4回中3回で約70%、残り1回でも52%で
最大)を占めるため、事前に決めた基準(最大の部分が半分以上かつ並列化できる構造なら
並列化する)に従い、分割の並列化に進む。**

分割の構造: `lod.rs`の`build_lod_index`は、ルートを8分木のオクタントへ分割した後、
**各オクタント以下の部分木を完全に独立に処理する**(あるオクタントの点は他のオクタントの
分割処理と一切データを共有しない)。これは「ノードや部分木ごとに独立」という、並列化を
進めてよい構造にそのまま当てはまる。

### 2. 並列化の実装

#### `rayon`は既に依存に入っている(確認)

`crates/pcv-convert`は M4-7で`las`の`laz-parallel`フィーチャ(内部で`rayon`を使う)を
既に有効にしており、ワークスペースの依存グラフに`rayon`が既にある。`vendor/copc-writer`
自体にも**upstream由来の`parallel`フィーチャ(`dep:rayon`)が最初からあった**(後述)。

#### octreeの分割(`parallel-lod`フィーチャ、新規実装)

`vendor/copc-writer/src/lod.rs`の`build_lod_index`に`#[cfg(feature = "parallel-lod")]`の
並列版を追加した(既存の逐次版は`#[cfg(not(feature = "parallel-lod"))]`で残した。
`writer.rs`の`compress_nodes`が逐次/並列を`cfg`で切り替えている既存の作法と同じ)。

**設計: なぜ「ルート直下の1段」だけを並列化するか**。ルートを8オクタントへ分割した後、
**残った子(最大8個)をオクタントごとに独立したローカルの一時ファイル(order-branch)へ
逐次処理し**(既存の`LodIndexBuilder::assign`をそのまま再利用、アルゴリズム自体は
変えていない)、`rayon`でこれを並列に実行する。全レベルを再帰的に並列化する(子の
そのまた子も並列化する)案も検討したが、部分木ごとに新しい一時ファイルを作るコストが
あるため、葉に近い小さな部分木まで並列化すると「小さすぎる仕事を並列化してかえって
遅くなる」(M4-7がバッチサイズ64Kiで観測した逆転と同種)おそれがあり、実装の見通しの
良さも考慮して1段に留めた。

**出力の決定性**: 並列処理が終わったら、**オクタント順(0→7)でローカルのorderファイルの
中身をグローバルなorderファイルへバイトをそのまま連結する**(オフセットを足すだけ)。
逐次版も同じDFS順(ノード自身の割り当て→子をオクタント順に処理)でorderファイルを
埋めるため、連結後の内容は逐次版とバイト単位で一致する。既存の回帰テスト
`native_output_hash_matches_recorded_value`(ネイティブ出力のハッシュ一致)で確認した。

**`CopcPointSource: Sync`化(前提作業)**: 複数スレッドから`&S`(点データソース)を
共有して`xyz()`を呼ぶ必要があるため、`CopcPointSource`トレイトに`Sync`を上位トレイトとして
追加した。これに伴い、`SpillSource`(`source.rs`)・`SpillReader`(`spill.rs`)が内部の
使い回しバッファに使っていた`RefCell`(`Sync`でない)を`Mutex`に変えた。`record_into`
(ノード圧縮が単一スレッドから呼ぶ。並列化したのは`xyz_at`呼び出し側=octree分割だけ)
からしか触れないため、実質的なロック競合は無い。

**`CancelCheck`の型を`&dyn CancelCheck`→`&(dyn CancelCheck + Sync)`に変更**: 同じ理由
(複数スレッドから`cancel.check()`を呼ぶ)で、`copc_core::CancelCheck`トレイトオブジェクトの
参照型に`Sync`マーカーを足した。`copc_core`クレート自体は編集できない(vendorしていない
外部クレート)ため、トレイト定義は変えず、受け取る側の型だけを変えた。既存の実装
(`NeverCancel`・`AtomicCancel`)はどちらも元から`Sync`なので、呼び出し側のコード変更は
不要(型が自動的に合う)。`vendor/copc-writer`内の該当箇所と、`crates/pcv-convert/src/streaming.rs`
の`convert`/`convert_path`の型注釈を機械的に揃えた(振る舞いは変えていない)。

#### ノードごとのLAZ圧縮(`parallel-compress`フィーチャ、**採用しなかった**)

`vendor/copc-writer`の`writer.rs`を読んだところ、**ノードごとのLAZ圧縮を並列化する
実装が、upstream(`copc-writer` 0.9.0そのもの)に元から存在していた**ことが分かった
(`#[cfg(feature = "parallel")] fn compress_nodes`。`rayon`でバッチ単位
(`batch = 2 * rayon::current_num_threads()`、同時に圧縮するノード数の上限そのもの)
に区切り、ノードごとに独立した`LasZipCompressor`で圧縮してから、元の順序で書き出す
実装。チャンクテーブルは自前で組み立て直す)。このフィーチャはこれまで一度も
有効化されたことが無く(`pcv-convert`は`copc-writer = "0.9.0"`とだけ書いていた)、
**検証もされていなかった**。

実際に有効にして`native_output_hash_matches_recorded_value`を実行したところ、
**出力がバイト単位で変わった(ファイルサイズ自体が3バイト違う。ヘッダーのEVLRオフセットから
hierarchy領域まで広範囲に差分がある)**。`cargo test -p pcv-convert --test streaming_conversion
native_output_hash_matches_recorded_value`を次の4通り(`crates/pcv-convert/Cargo.toml`の
`copc-writer`依存のフィーチャを切り替えて再ビルド)で実行し、切り分けた:

| 構成 | 結果 |
|---|---|
| `parallel-lod`+`parallel-compress`(両方) | 失敗 |
| `parallel-compress`のみ | 失敗(両方のときと同じハッシュ。`parallel-lod`の有無は無関係) |
| `parallel-lod`のみ | **成功** |
| フィーチャ無し(逐次のみ。`CopcPointSource: Sync`化・`RefCell`→`Mutex`化は
  含むがoctree分割・ノード圧縮はどちらも逐次) | **成功**(念のため最後に確認) |

`parallel-lod`のみ・フィーチャ無しのどちらも、本タスク開始前から記録されている
期待ハッシュ(`EXPECTED_HASH`)と一致した。**出力のバイト不一致は`parallel-compress`
(upstream由来、本タスクでは実装していない)だけが原因で、`CopcPointSource: Sync`化・
`RefCell`→`Mutex`化・`parallel-lod`はどれも出力に影響していない。**

専用の使い捨てスクリプト(`examples/dump_synthetic_output.rs`。確認後に削除済み、
`main`には含めていない)で、同じ合成LASを逐次版・`parallel-compress`版それぞれで
変換して`cmp -l`でバイト差分を取ったところ、ヘッダーのEVLRオフセット・COPC info VLRの
`root_hier_offset`(ファイルサイズが違うので当然ずれる)に加えて、**点データ領域の
途中にも複数箇所の差分があった**。これは「連続した1本の`LasZipCompressor`でチャンク
境界ごとに`finish_current_chunk()`する」(逐次版)場合と、「ノードごとに新しい
`LasZipCompressor`を作って独立に圧縮する」(upstreamの並列版)場合とで、**LAZの
圧縮バイト列そのものが異なる**ことを示している。`laz`クレート内部の挙動差が原因と
見られるが、このタスクでは深追いしていない(本タスクの担当範囲は`copc-writer`の
利用方法であり、`laz`クレート自体のバグ調査は範囲外と判断した)。

**「どうしてもバイト単位の一致を保てない場合は、止まって理由を報告する(期待値を
書き換えて済ませないこと)」という約束に従い、`parallel-compress`は採用しない。**
`crates/pcv-convert/Cargo.toml`では`parallel-lod`だけを有効にした。

この2つの並列化を独立に検証・選択できるよう、`vendor/copc-writer/Cargo.toml`の
`parallel`フィーチャを`parallel-lod`(本タスクの新規実装)と`parallel-compress`
(upstream由来、未採用)に分割した。`parallel = ["parallel-lod", "parallel-compress"]`
は後方互換のため残したが、`pcv-convert`はこれを使わず`parallel-lod`だけを指定する。

#### メモリ: 同時に開く一時ファイル数が点数に比例しないことを確認

新規テスト`vendor/copc-writer/tests/parallel_lod_open_files_bounded.rs`。`ScratchFs`を
薄くラップし、「一時ファイルが作られてから(writer→readerの変換をまたいで)完全に
手放されるまで」の区間をRAIIで数える`OpenFileTracker`を用意した。点数が10倍違う
2つの入力(20,000点・200,000点、同じ`max_points_per_node`)を変換し、**同時に開いていた
一時ファイル数のピークが10倍にはならない**(3倍以内という機械的な閾値で判定。実際の
構造上は`rayon`のスレッド数程度の定数倍にしかならないはず)ことを確認した。

#### キャンセル: 並列化の後も働くことを確認

新規テスト`vendor/copc-writer/tests/parallel_lod_cancel.rs`。呼ばれた回数を数えて
途中で`Err(Cancelled)`を返す`CancelCheck`実装(スリープや実時間に頼らない決定的な
方法)で、octreeの分割が本格化した頃合い(21回目の`check()`呼び出し)にキャンセルが
入るようにし、(1)呼び出し全体が`Err(Error::Cancelled)`を返すこと、(2)キャンセル経路でも
一時ファイルが全て手放される(RAIIで0に戻る)ことを確認した。`rayon`の各並列ワーカーは
それぞれ独立に`cancel.check()`を呼ぶ(既存の`LodIndexBuilder::assign`が元から持っていた
ポーリングをそのまま使い回しているだけ)ため、1つの共有フラグで全ワーカーが気づいて
止まる。

#### Web: 対象外であることの確認

`crates/pcv-wasm`は別のワークスペース(このタスクのCargo.tomlとは独立したビルドグラフ)
で`copc-writer`に`default-features = false`のまま依存しており、`parallel-lod`・
`parallel-compress`のどちらも有効にしていない(`rayon`はwasm32向けビルドに一切
入り込まない)。ただし`CopcPointSource: Sync`化・`RefCell`→`Mutex`化は**フィーチャに
関わらず常にコンパイルされる**変更のため、wasm32向けの生成物(`pcv_wasm_bg.wasm`)の
バイト列自体は変わる(`npm run build:wasm`で再生成し、コミットに含めた)。TypeScript向けの
型定義(`.d.ts`)には差分が無い(API面は変わっていない)ことを確認した。

### 3. 実測: 並列化の前後比較(デスクトップ、beer.laz)

`parallel-lod`を有効にした状態で、同じ計測ハーネスを3回実行した。

| 実行 | [1]octree分割 | [2]ノード圧縮(変更なし) | 合計 |
|---|---|---|---|
| 1回目 | **12.681秒**(44.8%) | 15.310秒(54.0%) | 28.333秒 |
| 2回目 | **18.370秒**(35.1%) | 33.035秒(63.1%) | 52.346秒 |
| 3回目 | **18.552秒**(36.7%) | 31.087秒(61.5%) | 50.548秒 |

**octreeの分割(並列化した部分)**: 改修前4回(32.601・33.350・39.694・48.610秒、中央値
約36.5秒)→改修後3回(12.681・18.370・18.552秒、中央値18.370秒)。**中央値で約2.0倍
(36.5秒/18.4秒)速くなった。**

**後処理合計**: ノード圧縮(変更していない)自体の揺れが依然として大きい(12.9〜36.1秒)
ため、合計の改善率はこの揺れに埋もれて明確には出ていない(改修前合計の中央値
約58.6秒 vs 改修後合計の中央値50.5秒)。**正直に書く: 並列化した部分(octree分割)
単体では明確に約2倍速くなっているが、後処理「合計」としての体感速度向上は、
ノード圧縮側のシステムノイズに隠れて今回の計測では綺麗に見えていない。** 圧縮側の
揺れの原因はADR-0006・本タスク冒頭と同種(未解決)で、本タスクの範囲ではない
(`parallel-compress`は上記の理由で採用していない)。

### 確認したコマンドと結果

```
$ cargo fmt --all -- --check
(出力無し、終了コード0)

$ cargo fmt --manifest-path vendor/copc-writer/Cargo.toml -- --check
(出力無し、終了コード0)

$ cargo clippy --workspace --all-targets -- -D warnings
(警告・エラー無し)

$ cargo test --workspace --release
pcv-convert(ライブラリ41件・import_e57等の統合テスト・streaming_conversion 6件
  [native_output_hash_matches_recorded_valueを含む]・parallel_laz_decompression 2件・
  roundtrip 1件): 全て成功
pcv-core(31件)・pcv-tauri(6件): 全て成功
doc-tests: 0件(対象無し)

$ cargo test --manifest-path vendor/copc-writer/Cargo.toml --release --features parallel-lod
19件(ライブラリ。lod.rsの既存テストが並列版を実際に通している)+
parallel_lod_cancel(新規)1件+parallel_lod_open_files_bounded(新規)1件+
scratch_read_is_bounded(M4-6の既存回帰テスト)1件、合計22件成功

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
成功

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --all-targets -p pcv-wasm -- -D warnings
pcv-wasm自身は警告0件

$ cargo test --manifest-path crates/pcv-wasm/Cargo.toml
ユニット17件+統合2件、すべて成功

$ npm run build:wasm / typecheck / lint / test / build
いずれも成功(testは28ファイル240件)
```

**vendor clippyについて**: `cargo clippy --manifest-path vendor/copc-writer/Cargo.toml
--all-targets -- -D warnings`は本タスクと無関係の既存のlint(`ScratchReader`トレイトが
`len`を持つが`is_empty`を持たない、`clippy::len_without_is_empty`)で失敗する。
`git diff origin/main -- vendor/copc-writer/src/scratch.rs`で確認したところ、この
トレイト定義は本タスクで一切変更していない(diffが空)ため、**本タスクが持ち込んだ
問題ではない**。CI(`ci.yml`)も`cargo clippy --workspace --all-targets`(`vendor`は
ワークスペース除外)しか実行しないため、本タスクの受け入れ条件には影響しない。

### 新規・変更したファイル

- `vendor/copc-writer/src/writer.rs`: `PostProcessStageTimings`(計測専用)、
  `write_copc_from_spill_with_fs_and_timings`(計測専用)、`CancelCheck`の型を
  `&(dyn CancelCheck + Sync)`に変更
- `vendor/copc-writer/src/lod.rs`: `build_lod_index`の並列版(`parallel-lod`)を追加
- `vendor/copc-writer/src/source.rs`・`spill.rs`: `CopcPointSource: Sync`化に伴う
  `RefCell`→`Mutex`
- `vendor/copc-writer/src/validate.rs`: `CancelCheck`の型変更(機械的)
- `vendor/copc-writer/Cargo.toml`: `parallel`を`parallel-lod`/`parallel-compress`に分割、
  新規テスト2件を登録
- `vendor/copc-writer/tests/parallel_lod_open_files_bounded.rs`・`parallel_lod_cancel.rs`: 新規
- `crates/pcv-convert/Cargo.toml`: `copc-writer`に`parallel-lod`フィーチャを指定
- `crates/pcv-convert/examples/post_process_stage_bench.rs`: 新規(計測ハーネス)
- `src/wasm/pcv-wasm/*`: `npm run build:wasm`による再生成(API面の変更なし)

### 所有者が確かめる手順

1. **デスクトップ: 大きめの生LAS/LAZ(beer.laz等、数千万点)を変換する。** 変換が
   今までどおり完了し、結果が正しく表示されることを確認する
2. 可能であれば、タスクマネージャ等で後処理中(進捗表示が「後処理中」になった後)に
   複数のCPUコアが使われていることを確認する(octreeの分割がルート直下で並列に
   走っている区間)
3. **キャンセル**: 変換中(特に後処理が始まった後)にキャンセルを押し、今までどおり
   止まり、一時ファイルが残っていないことを確認する
4. 同じファイルを複数回変換し、出力が毎回同じになる(バイト単位で決定的)ことを
   確認したい場合は、出力のハッシュ(例: PowerShellの`Get-FileHash`)を比較する
5. Android実機: `gh run download <run-id> -n android-apk`でAPKを取得し、生のLAS/LAZの
   変換が今までどおり完了することを確認する(`parallel-lod`はAndroidでも有効)

### 追記: M4-9とのrebase後の再検証(2026-10-03)

本タスクの作業中に`origin/main`へM4-9(E57/PLY/PCDを中間LASを経ずに直接COPCへ
変換する)・M2-2の追加修正(RGBの8bit判定)が入ったため、`git rebase origin/main`で
取り込んだ(コンフリクトはwasmバイナリの再生成コミット1箇所のみ。再生成し直して解消、
詳細は下記コミット参照)。

**M4-9が追加した`crates/pcv-convert/src/import/`(`convert.rs`・`mod.rs`)が、
本タスクの`CancelCheck`の型変更(`&dyn CancelCheck`→`&(dyn CancelCheck + Sync)`)より
前の型のままだったため、rebase後にビルドが失敗した。** 同じ機械的な型変更を
この2ファイルにも適用し(`fix(M4-8): M4-9のimportモジュールのCancelCheck型を
Sync対応に揃える`というコミットで分離)、ビルドを通した。

rebase後に受け入れ条件を再確認した:

- `cargo test --workspace --release`: 全て成功(pcv-convertのライブラリテストは
  M4-9の追加分を含め41件、import_e57/import_pcd/import_plyもM4-9の直接COPC化に
  伴い更新された形で成功)
- `cargo test -p pcv-convert --test streaming_conversion native_output_hash_matches_recorded_value`:
  **成功**(M4-9はLAS/LAZ経路[`crate::streaming`]には触れていないため、この
  回帰テストへの影響は無いことを確認した)
- `post_process_stage_bench`を3回再実行(beer.laz)した。内訳:

  | 実行 | [1]octree分割 | [2]ノード圧縮 | 合計 |
  |---|---|---|---|
  | A | 28.062秒(32.2%) | 57.521秒(65.9%) | 87.256秒 |
  | B | 29.389秒(33.0%) | 57.905秒(65.1%) | 88.926秒 |
  | C | 27.197秒(33.5%) | 52.553秒(64.7%) | 81.273秒 |

  **正直に書く**: この3回は、本タスクの実装直後に測った値(octree分割12.7〜18.6秒・
  ノード圧縮15.3〜33.0秒)より全体的に2〜3倍遅い。`vendor/copc-writer`の
  コードは`fix(M4-8)`コミット(`import/`の型変更のみ、`lod.rs`・`writer.rs`は
  無変更)以外rebase後に変えていないため、**実装自体の性能が落ちたのではなく、
  計測時点のマシン負荷が高かった可能性が高い**(このセッション中、並行して
  別エージェントがM4-9の作業をしていたため、CPU負荷が競合していたと考えられる)。
  3回の内訳同士は比較的近い値(32〜34%/65〜66%)で揃っており、計測の仕組み自体は
  rebase後も正しく動いていることが分かる。**並列化前の基準との直接比較
  (同じ負荷条件での再測定)は行っていない**ため、"約2倍"という当初の結論を
  この3回だけで裏付け直すことはできないが、構造的な正しさ(バイト一致・
  メモリ非比例・キャンセル)は上記の自動テストで確認済みであり、ここは
  揺らいでいない。
- `cargo test --manifest-path vendor/copc-writer/Cargo.toml --release --features parallel-lod`:
  22件全て成功(再確認)

コミット: `perf(M4-8)`・`feat(M4-8)`・`chore(M4-8)`・`docs(M4-8)`(今回の実装)に続けて、
`fix(M4-8): M4-9のimportモジュールのCancelCheck型をSync対応に揃える`を追加した。

## M4-8 追記: 実機不具合「変換に失敗しました: unreachable」の調査と修正(2026-10-07、Opus調査・Sonnet実装)

### 症状

所有者の実機(Web版、PCのChrome)で、LAZ・PCDの変換が失敗していた。画面には
「変換に失敗しました: unreachable」。当初コーディネーターは「数千万点規模の
入力でメモリ不足(wasm32の4GiB上限)」と見立てていたが、所有者のブラウザ
console出力で真因が判明した。

```
panicked at /rustc/.../library/std/sys/time/unsupported.rs:35:9:
time not implemented on this platform
```

### 原因(コーディネーターがコードで確認、本タスクで追認)

`wasm32-unknown-unknown`には時刻の概念が無く、`std::time::Instant::now()`・
`std::time::SystemTime::now()`はこのターゲットでは**必ずpanicする**(コンパイルは
通る。呼ばれた瞬間にのみ落ちる)。本番の変換経路(`write_copc_from_spill_with_fs`、
pcv-wasmが呼ぶ)は、2箇所でこれを無条件に呼んでいた。

1. **`vendor/copc-writer/src/writer.rs`の`write_copc_inner`**。後処理
   (octree構築・ノード圧縮・ヘッダー/hierarchy書き出し)の4箇所で
   `Instant::now()`を呼んでいた(497・504・630・648行目、M4-8でこの計測が
   入った際のもの)。この関数のドキュメントコメントには「`stage_timings`が
   `None`(本番の経路)のときはInstant::now()の呼び出しさえ発生しない」と
   書かれていたが、**これは誤りだった。** 実際に`None`で分岐していたのは
   `.elapsed()`を呼んで加算するかどうかだけで、`Instant::now()`自体は常に
   呼ばれていた。
2. **`vendor/copc-writer/src/metadata.rs`の`current_utc_date()`**
   (LASヘッダーの作成日のデフォルト、`SystemTime::now()`を呼ぶ)。
   入力のLAS/LAZヘッダーに作成日が無い場合、またPCD入力(座標系と同じく
   作成日の概念を持たない。`crates/pcv-wasm/src/pcd_import.rs`の
   `WasmPcdConverter::finish`は`CopcWriteMetadata::default()`をそのまま使う
   ため常に該当)に必ず経由する。

結果として、**M4-8(2026-10-03、後処理の計測を入れた回)以降、Web版の変換は
ファイルサイズに関係なく、1番目(`Instant::now()`)で確実に失敗していた。**
`vendor/copc-writer`はルートワークスペースのexclude対象で(`Cargo.toml`の
コメント参照)、`cargo clippy --workspace`・`cargo test --workspace`は
`[patch.crates-io]`経由でコンパイルするだけで、lintもテストも実行しない。
`crates/pcv-wasm`向けのCI(`pages.yml`)もpcv-wasm自身のコードしか厳格に
lintしておらず、依存先であるcopc-writerの中身までは見ていない。さらに
`cargo build --target wasm32-unknown-unknown`は(呼ばれなければpanicしない
ため)成功する。つまり**ビルドが通ってCIが緑でも気づけず、実際に実行して
初めて踏む不具合**だった。

(メモリに比例する設計上の問題(M4-7の並列展開Workerが担当範囲全体を
メモリに貯める件)自体は実在するが、「変換に失敗しました: unreachable」の
直接の原因ではなかった。この件は本タスクシートの別の節で引き続き扱う。)

### 直し方

- **`web-time`クレート**(`web-time = "1"`、`vendor/copc-writer/Cargo.toml`)を
  依存に足し、`writer.rs`・`metadata.rs`の`use`を`web_time::{Instant,
  SystemTime, UNIX_EPOCH}`に替えた。呼び出し側のロジック(計測区間の測り方・
  日付の計算)は一切変えていない。`web-time`はネイティブターゲットでは
  `std::time::{Instant, SystemTime}`への単純な再エクスポートになり、
  wasm32では`Date`/`performance.now()`を使う実装に自動的に切り替わる
  (クレート自身の売りがこれ)。
  - **検討した別案**: pcv-wasm側(JSの`Date`)から作成日・計測の有無を
    呼び出し元から渡す案。LAS/LAZ版(`convert.rs`)・PCD版(`pcd_import.rs`)の
    2つの呼び出し元それぞれに新しい引数を配線する必要があり、`web-time`への
    置き換え(importを変えるだけ)の方が変更が小さく、かつ両方の経路を
    一度に直せると判断した。
- **再発防止**: `vendor/copc-writer/clippy.toml`・`crates/pcv-core/clippy.toml`・
  `crates/pcv-wasm/clippy.toml`を新設し、`disallowed-methods`で
  `std::time::Instant::now`/`std::time::SystemTime::now`の直接呼び出しを
  禁止した。
  - `crates/pcv-core/examples/open_bench.rs`・`parallel_bench.rs`は
    ネイティブ専用の計測ツールとして正当に`Instant::now()`を使っている
    (wasm32ビルド`cargo build -p pcv-core --target wasm32-unknown-unknown`
    には`--examples`を渡しておらず含まれない)ため、ファイル単位で
    `#![allow(clippy::disallowed_methods)]`を付けて除外した。
  - **重要な制約(実機で確認): ネイティブターゲットではこのlintを有効に
    していない。** `web_time::Instant`はネイティブでは`std::time::Instant`
    への単純な型の再エクスポートなので、`web_time::Instant::now()`と書いても
    clippyのdisallowed_methodsは解決後の実体のパス(`std::time::Instant::now`)
    で一致を取るため、**正しくweb_time経由で呼んでいるコードまで誤って
    弾いてしまう**。`vendor/copc-writer/src/writer.rs`の呼び出しを一時的に
    `std::time::Instant::now()`へ書き換えてから戻すテストで、ネイティブの
    `cargo clippy -- -D clippy::disallowed_methods`がこの行だけでなく
    **他の(web_time経由で正しく書かれた)呼び出しまで全部エラーにする**
    ことを確認した。そのため、この検査はwasm32ターゲット限定にした
    (ネイティブでは元々panicしないため実害は無い)。
- **CI**:
  - `.github/workflows/ci.yml`の`rust`ジョブに、`vendor/copc-writer`の
    `cargo fmt --check`・`cargo test`を追加した(今までCIの対象外だった)。
    disallowed_methodsの検査はネイティブでは入れていない(上記の理由)。
  - `.github/workflows/pages.yml`に、`vendor/copc-writer`を対象にした
    `cargo clippy --no-default-features --target wasm32-unknown-unknown --lib
    -- -D clippy::disallowed_methods`を追加した。`--all-targets`にすると
    dev-dependencyの`criterion`がrayon前提でwasm32と非互換のためビルド自体が
    失敗する(実機で確認)ので`--lib`のみにした。`-D warnings`ではなく
    `-D clippy::disallowed_methods`だけを厳格化したのは、
    `--no-default-features`ビルドに元からある(この修正とは無関係な)
    dead-code警告群を今回のタスクのブロッカーにしないため。
  - `crates/pcv-wasm`・`crates/pcv-core`の既存のclippyステップ(`-D warnings`、
    それぞれ`pages.yml`・`ci.yml`に既にある)は変更していないが、新設した
    `clippy.toml`がそれぞれの対象クレート自身のコードにも効くようになった
    (二重の再発防止)。

### 確認したこと(コマンドと結果)

- `cargo fmt --all -- --check` / `cargo fmt --manifest-path
  vendor/copc-writer/Cargo.toml -- --check` / `cargo fmt --manifest-path
  crates/pcv-wasm/Cargo.toml -- --check`: 成功
- `cargo clippy --workspace --all-targets -- -D warnings`: 成功
- `cargo clippy --manifest-path vendor/copc-writer/Cargo.toml
  --no-default-features --target wasm32-unknown-unknown --lib --
  -D clippy::disallowed_methods`: 成功
- `cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target
  wasm32-unknown-unknown --all-targets -- -D warnings`: 成功
- **disallowed_methodsが実際に落ちることを確認**(「確かめていないことを
  確認したと書かない」の実践): `writer.rs`の`Instant::now()`を一時的に
  `std::time::Instant::now()`に書き換え、上記wasm32のclippyコマンドを
  再実行して`error: use of a disallowed method`で落ちることを確認してから
  元に戻した。`crates/pcv-core`にも一時的にダミーの`Instant::now()`呼び出しを
  追加し、`cargo clippy -p pcv-core -- -D clippy::disallowed_methods`で
  同様に落ちることを確認してから削除した。
- `cargo test --workspace`: 122件成功、0件失敗(pcv-convertのユニットテスト
  41件+統合テスト8ファイル分27件、pcv-core 39件、pcv-tauri 15件。
  内訳はコマンド出力参照)
- `cargo test --manifest-path vendor/copc-writer/Cargo.toml`: 20件成功
  (ユニットテスト19件+`scratch_read_is_bounded`)。`metadata::tests::
  write_metadata_defaults_are_wkt_conformant`(creation_yearが現在年以上に
  なることを確認するテスト)が`web_time`経由でも変わらず成功することを
  確認した
- `cargo test --manifest-path crates/pcv-wasm/Cargo.toml`: 29件成功
  (ユニットテスト24件+結合テスト4ファイル分5件)
- `npm run build:wasm`: 成功。生成物(`src/wasm/pcv-wasm/pcv_wasm.js`・
  `pcv_wasm_bg.wasm`等)を今回のコミットに含めた
- `npm run typecheck` / `npm run lint` / `npm run test`(285件成功) /
  `npm run build`: 成功
- `grep -rl "@tauri-apps/api" src/`: `src/datasource/tauri.ts`のみ(規約2)

### 確認していないこと(所有者に見てもらう必要がある)

- **実機での動作確認はできない(ブラウザが無い環境での作業のため)。**
  所有者に、以前失敗したファイル(LAZまたはPCD)をWeb版で変換してもらい、
  1. 変換が完了すること(「変換に失敗しました」が出ないこと)。
  2. 仮に別の原因でまだ失敗する場合は、ブラウザのconsoleに
     `time not implemented`のpanicが**出ないこと**(出なければ今回の修正は
     効いている。別のエラーが出た場合は新しい不具合として報告してほしい)。
  の2点を確認してほしい。
- `post_process_stage_bench`(実データでの後処理計測ハーネス)は、ビルドが
  通ることと既存のユニットテストの通過は確認したが、実データでの実行
  (秒数の実測)は行っていない。M4-8時点の計測ロジック自体は変えていないため
  動作(測る値)は変わらないはずだが、「実行して確認した」とは書かない。

## M4-10: ノードごとのLAZ圧縮を並列化する(2026-10-03〜04、Opus計画・Sonnet実装)

### 背景・所有者の決定

M4-8で、後処理のもう一つの大きな部分(ノードごとのLAZ圧縮)についても、
`copc-writer`に元からあった並列実装(`parallel-compress`フィーチャ、upstream由来)を
試した。しかし、有効にすると出力がバイト単位で変わり、当時の「バイト単位で一致
しなければ止まる」という約束に従って採用しなかった(M4-8節参照)。

**所有者が2026-10-03、この条件を「点の集合が一致すること」へ緩めることを承認した。**
本タスクでは、(1)出力が変わる理由を確かめ、点の内容が変わらないことを確認し、
(2)デスクトップ・Androidで`parallel-compress`を有効にし、(3)回帰テストを置き換え、
(4)メモリ・キャンセルを確認し、(5)前後の実測を行った。詳細な調査・設計・テストの
内容は`vendor/copc-writer/PATCH.md`の「M4-10 追記」節にまとめた(ここでは要点と
実測のみを記す)。

### 1. 出力が変わる理由(要点)

逐次実装は1本の`LasZipCompressor`をノード境界ごとに`finish_current_chunk()`で
区切るのに対し、並列実装(upstream由来、中身は変更していない)はノードごとに
**新しい独立した圧縮器**を作って`rayon`で並列圧縮する。この違いにより、

- 圧縮バイト列そのもの(`laz`クレート内部のエントロピー符号化の文脈が異なる)
- チャンクの区切り(圧縮後のバイト長が変わるため、ファイル中の並びも変わる)
- hierarchyのオフセット(上記の結果、各ノードの`offset`/`byte_size`が変わる)

が変わる。一方、各ノードに割り当てる点の集合(LOD構築)・点を生バイト列へ
エンコードする処理はどちらの実装でも完全に同じコードパスを通るため、**点の内容
(座標・強度・分類・色)は変わらないはず**という予想を立て、新しい自動テスト
(`crates/pcv-convert/tests/streaming_conversion.rs`の
`parallel_compress_point_set_matches_sequential`)で実際に確かめた。同じ合成入力を
逐次・並列で変換し、`pcv-core`で開いて全ノードの点を集め、(1)ノード構成(キーごとの
点数)、(2)点数・全点の(座標・強度・分類・色)の多重集合、の両方が一致することを
確認し、**両方とも一致した**(点が欠ける・重複する・座標が変わるといった問題は
無かった)。

### 2. 採用したこと

- `vendor/copc-writer`: `compress_nodes`を`compress_nodes_sequential`(常に
  コンパイル)・`compress_nodes_parallel`(`parallel-compress`フィーチャ有効時のみ、
  中身は無変更)に分け、新しい`CopcWriterParams::parallel_node_compression`
  (実行時フラグ)で選べるようにした。これにより、逐次のバイト一致テストと並列の
  点集合一致テストを同じビルド・同じ`cargo test`呼び出しで両立できる。
- `crates/pcv-convert/Cargo.toml`: `copc-writer`に`parallel-compress`フィーチャを
  追加(デスクトップ・Android)。`crates/pcv-wasm`は別ワークスペースで無効のまま
  (wasmはスレッド不可)。

### 3. 回帰テストの置き換え

- `native_output_hash_matches_recorded_value`(既存、残す): 
  `CopcWriterParams::with_parallel_node_compression(false)`で逐次経路を明示的に
  強制するよう変更。期待ハッシュ値は無変更。
- `parallel_compress_point_set_matches_sequential`(新規): 上記1節参照。
- `vendor/copc-writer/tests/parallel_compress_batch_bounded.rs`(新規): 並列圧縮の
  バッチサイズ(同時に圧縮するノード数)が点数10倍でも変わらないことを確認。
- `vendor/copc-writer/tests/parallel_compress_cancel.rs`(新規): 並列圧縮化後も
  キャンセルが働くことを確認。

### 4. メモリ・キャンセル

`parallel_compress_batch_bounded.rs`で、並列圧縮のバッチサイズ
(`2 * rayon::current_num_threads()`)が点数(100,000→1,000,000、10倍)に依存しない
ことを確認した。キャンセルは`parallel_compress_cancel.rs`で、圧縮フェーズの終盤
(ベースライン実行の総`cancel.check()`呼び出し回数を測ったうえで、残り10回以内に
トリガーする決定的な方法)でもErr(Cancelled)で止まることを確認した。

### 5. 実測: 並列化の前後比較(デスクトップ、beer.laz)

開発機: Core i5-14600K(14コア/20論理スレッド)、RAM 31.8GB、Windows 11
(M4-7・M4-8と同じ機体)。計測対象: `C:\rust\point-cloud-viewer\data\beer.laz`
(66,848,096点、448.7MiB。絶対パスから読み、出力はコミットしていない)。

`cargo run -p pcv-convert --release --example post_process_stage_bench --
<beer.laz>`(並列、既定)と同`-- <beer.laz> --sequential-compress`(逐次、
強制)をそれぞれ3回実行した(`parallel-lod`は両方とも有効。並列化したのは
ノードごとのLAZ圧縮のみ)。1回目の計測(デスクトップビルド中の別コマンドと
並行して実行してしまい、CPU負荷が競合していたため載せない)を除いた、
クリーンな状態での3回ずつ:

**逐次(`--sequential-compress`)**:

| 実行 | [1]octree分割 | [2]ノード圧縮 | 合計 |
|---|---|---|---|
| 1回目 | 12.275秒(47.3%) | 13.348秒(51.4%) | 25.977秒 |
| 2回目 | 18.867秒(45.9%) | 21.869秒(53.2%) | 41.103秒 |
| 3回目 | 13.806秒(34.5%) | 25.680秒(64.2%) | 39.996秒 |

中央値: octree分割13.806秒、**ノード圧縮21.869秒**、合計39.996秒。

**並列(既定、`parallel-compress`有効)**:

| 実行 | [1]octree分割 | [2]ノード圧縮 | 合計 |
|---|---|---|---|
| 1回目 | 13.637秒(71.8%) | 4.994秒(26.3%) | 18.994秒 |
| 2回目 | 12.432秒(70.6%) | 4.814秒(27.3%) | 17.604秒 |
| 3回目 | 18.063秒(59.6%) | 11.445秒(37.8%) | 30.303秒 |

中央値: octree分割13.637秒、**ノード圧縮4.994秒**、合計18.994秒。

**ノード圧縮(並列化した部分)**: 逐次の中央値21.869秒→並列の中央値4.994秒。
**中央値で約4.4倍(21.869秒/4.994秒)速くなった。**

**後処理合計**: 逐次の中央値39.996秒→並列の中央値18.994秒。**中央値で約2.1倍
(39.996秒/18.994秒)速くなった。** M4-8と同じく実行ごとの揺れは大きい(逐次の
ノード圧縮だけでも13.3〜25.7秒、並列でも4.8〜11.4秒)が、6回中どの組み合わせで
比較しても並列の方が明確に速く、M4-8の時点で見えていなかった「後処理合計」の
改善が今回は揺れに埋もれず確認できた(M4-8ではoctreeの分割だけを並列化しており、
ノード圧縮側の揺れに改善が隠れていた)。

### 確認したコマンドと結果

`vendor/copc-writer/PATCH.md`の「M4-10 追記」節に記載(fmt/clippy/test/wasm build/
npm run build:wasm・typecheck・lint・test・buildのいずれも成功)。

### 新規・変更したファイル

`vendor/copc-writer/PATCH.md`の「M4-10 追記」節に記載。

## M4-12: 変換完了後の段階別内訳をWeb/デスクトップの両方の画面に出す(2026-10-08、Sonnet)

**このTaskSheetへの記録がこの時点まで漏れていた。** 機能自体はコミット
`606a37d`（Rust側の段階ごとの所要時間計測の基盤）・`3d5cda1`（デスクトップ版の
変換完了イベントに乗せる）・`8cb0416`（Web版(pcv-wasm)の計測）・`f35d3a7`
（`conversion-breakdown.ts`で整形テキストに組み立てる）・`7d8e111`
（`useCopcViewer.ts`/`LayerPanel.tsx`への結線、「内訳をコピー」ボタン）で
既に実装済みだった。概要:

- `useCopcViewer.ts`がTauri/Web両方の変換完了イベント
  （`onConversionDone`/`onConvertDone`）から`stageTimings`（段階ごとの
  所要時間のDTO）を受け取り、`conversion-breakdown.ts`の
  `formatConversionBreakdown()`で整形したテキストを`conversionBreakdownText`
  として保持する。
- `LayerPanel.tsx`が「内訳をコピー」ボタン付きの表示パネルとして出す
  （変換の進捗パネルの続き）。
- `web.ts`/`copc.worker.ts`/`web-protocol.ts`/`tauri.ts`は`stageTimings`を
  DTOのまま橋渡しするだけで、整形は`conversion-breakdown.ts`側に閉じている。

### 追記（2026-10-08）: 不具合「変換の内訳が出てこない」の調査と修正

**所有者の報告**: 変換が終わっても「変換の内訳」が画面に出ない。Web版では
変換結果のダウンロードのリンクも出ない（消えている）。

#### 原因

`useCopcViewer.ts`の中で、変換完了は次の順で処理していた。

1. `onConvertDone`（Web、`WebSource`からのイベント）/ `onConversionDone`
   （デスクトップ、Tauriのイベント）のハンドラが
   `setConversionBreakdownText(...)`（Web版では`setDownloadReady(...)`も）を
   呼び、内訳・ダウンロードリンクを状態にセットする。
2. 続けて、変換結果（既にCOPC）を開くために
   `void openFileRef.current(...)`（=`openFile`）を呼ぶ。
3. **`openFile`は冒頭で問答無用に`setConversionBreakdownText(null)`・
   `setDownloadReady(null)`を呼んでいた**（利用者が新しいファイルを開くときに
   前回の内訳・ダウンロードリンクを消すための処理）。

このため、1でセットした直後に3で消えてしまい、**変換完了から続けて開く限り、
内訳・ダウンロードリンクは画面に一度も出なかった**（タイミング的に消える前に
React のレンダーが挟まることは無いため、常にこの順で消える）。

#### 直し方

内訳・ダウンロードリンクを消すのは、**利用者が自分で新しいファイルを開いた
ときだけ**にする。`openFile`に第2引数`isConversionContinuation`
（変換完了から続けて開く呼び出しかどうか。既定`false`）を足し、`true`の
ときだけ消さないようにした。

```ts
const openFile = useCallback(async (pathOrFile: string | File, isConversionContinuation = false) => {
  ...
  if (shouldClearConversionResultOnOpen(isConversionContinuation)) {
    setDownloadReady(null);
    setConversionBreakdownText(null);
  }
  ...
```

変換完了ハンドラ側の2箇所（Web版`onConvertDone`内・デスクトップ版
`onConversionDone`内）の`openFileRef.current(...)`呼び出しに`true`を渡すように
変更した。利用者が自分でファイルを開く経路（`LayerPanel.tsx`の4箇所・
`SettingsModal.tsx`の1箇所）は`openFile`の第2引数を渡さないため、既定の
`false`（=消す）のままになる。

**消す判断の置き場所**: 呼び出し側（UIの各ボタン）に分散させる案と、
`openFile`自身に判断を残す案の2つがあったが、後者を選んだ。「いつ消すか」が
`openFile`一箇所にまとまっていれば、所有者がこの関数を読むだけで
全体の挙動（いつ消え、いつ残るか）を追えるため（`CLAUDE.md`「所有者が実装を
追えること」）。前者（呼び出し側で消す）だと、5箇所のUIコードそれぞれが
「ここで消す/消さない」を知っている必要があり、見落としが起きやすい。

#### 新規テスト

`openFile`自体は`PointCloudRenderer`/`DataSource`を起動する大きな関数で
（カスタムフックをReact Testing Library無しでテストする基盤がこのプロジェクトに
無い）、フックごとテストするのは難しい。そのため、「消すかどうか」の判断
部分だけを純粋関数`shouldClearConversionResultOnOpen(isConversionContinuation)`
として切り出し（`useTheme.ts`の`resolveTheme`と同じ切り出し方）、
`src/state/useCopcViewer.test.ts`（新規ファイル）で2件のテストを書いた。

- `isConversionContinuation=true`（変換完了から続けて開く）→
  `false`（消さない）を返す
- `isConversionContinuation=false`（既定、利用者が自分で開く）→
  `true`（消す）を返す

この純粋関数のテストでは「変換完了から続けて開く呼び出しに実際に`true`が
渡っているか」（`openFileRef.current(key, true)`/
`openFileRef.current(outputPath, true)`の呼び出し自体）は検証できない。
その結線が正しいことは、コード上で2箇所の呼び出しを目視確認した
（下記「所有者が自分で確認する手順」で実機確認も依頼する）。

#### 触ったファイル

- `src/state/useCopcViewer.ts`: `shouldClearConversionResultOnOpen()`
  （新規、純粋関数）の追加、`openFile`に`isConversionContinuation`引数を追加、
  Web版・デスクトップ版の変換完了ハンドラ内の`openFileRef.current(...)`
  呼び出しに`true`を追加、`openFileRef`の型を2引数に拡張
- `src/state/useCopcViewer.test.ts`（新規）: `shouldClearConversionResultOnOpen`の
  2テスト

#### 検証

```bash
npm run typecheck   # 通った
npm run lint        # 通った
npm test            # 317件すべてpass(中央優先度のタスクと合わせて既存313件+4件)
npm run build       # 通った
```

#### 所有者が自分で確認する手順

**GUIでの目視確認はこの環境ではできなかった。** 以下を確認してほしい:

1. デスクトップ版で生のLAS/LAZを開き、変換が終わった直後に「変換の内訳」が
   LayerPanelに表示されることを確認する（今までは出なかったはず）
2. Web版で同様に変換し、「変換の内訳」とダウンロードのリンクの両方が
   表示されることを確認する
3. 変換完了後に表示された内訳・ダウンロードリンクが、**そのあと別の
   ファイルを開くと消える**ことを確認する（利用者が新しいファイルを開いた
   ときだけ消える、という修正の意図どおりか）
4. Web版でダウンロードリンクから実際にファイルをダウンロードし、開けることを
   確認する（`clearDownload`/再変換などで壊れていないか）

## M4-13: 「ノードの圧縮」が遅い件の調査 — コーディネーターの仮説は反証、実際の原因は別の無バッファ読みだった(2026-10-09、Sonnet)

### 所有者の計測(問題提起)

Web版で5,766,330点のLAS(09LD2626.las相当、187MiB)を変換したときの内訳
(Chrome 152、20コア):

| 段階 | 秒 | 割合 |
|---|---|---|
| 入力の読み込みと展開 | 0.139 | 0.9% |
| 一時ファイルへの書き込み | 0.541 | 3.5% |
| octreeの分割(LOD) | 1.180 | 7.6% |
| **ノードの圧縮** | **13.647** | **87.8%** |
| 書き出し | 0.033 | 0.2% |
| 合計 | 15.541 | |
| (参考)OPFSの読み書き合計 | 10.400 | |

### コーディネーターの仮説

「`compress_nodes_sequential`→`encode_node_points`がLOD順に点を読むと、元の
spillファイル上ではランダムアクセスになり、`vendor/copc-writer`の
`SpillReader::record_into`(=`ScratchReader::read_at`)がOPFSの64KiBブロック
キャッシュ(`crates/pcv-wasm/src/opfs.rs`)をほぼ毎回外し、点数ぶんの
`FileSystemSyncAccessHandle.read`が発生しているのではないか」というもの。
対策として、ノード内の点をspill上の昇順にソートしてから読む(COPCは
ノード内の点順を問わない)ことが提案されていた。

### Step 1: 計測を追加する

`crates/pcv-wasm/src/opfs.rs`に、`OpfsReadStats`/`OpfsReadCounters`
(`ScratchReader::read_at`の呼び出し回数・ブロックキャッシュのヒット/ミス・
OPFSから実際に読んだバイト数・読み時間)を追加した。`OpfsIoTimer`
(M4-12で追加済み、OPFSへの全JS呼び出しの累積時間)と同じ`Rc<Cell<..>>`共有の
考え方。`crates/pcv-wasm/src/dto.rs`・`src-tauri/src/conversion.rs`の
`ConversionStageBreakdownDto`に5つの`Option`フィールド
(`opfs_read_at_calls`・`opfs_cache_hits`・`opfs_cache_misses`・
`opfs_bytes_read_from_opfs`・`opfs_read_secs`)として追加し、
`src/datasource/conversion-breakdown.ts`の「変換の内訳」テキストに
既存の「(参考)OPFSの読み書き合計」と同じパターンで行を足した
(コミット: instrumentation、先に1本)。

### BEFORE計測(実データ、実ブラウザ)

**環境(正直に書く)**: 所有者の実機ではなく、このエージェントが作業している
Windowsサンドボックス上のヘッドレスChromium(`channel: "chromium"`、
`playwright`パッケージを直接使ったアドホックなスクリプト。
`e2e/web-conversion.spec.ts`と同じ起動設定だが、CIのPlaywrightテストとしては
組み込んでいない使い捨てスクリプト)。データは
`C:\rust\point-cloud-viewer\data\tokyo-shibuya\09LD2626.las`
(**所有者の計測と同一ファイル**。ヘッダーの点数が5,766,330点で一致することを
確認した)。

**フルサイズ(5,766,330点)はヘッドレスブラウザで10分(タイムアウト設定)経っても
終わらなかった。** 完了を待たずに計測を諦め、点数を減らしたサンプルで検証した
(理由は下記「環境についての注意」)。LASは固定長レコードなので、ヘッダーの
点数フィールドを書き換えてバイト列を先頭から切り詰めるだけで有効な部分集合に
なる(`tmp_measure/truncate-las.mjs`、一時スクリプト、コミットしていない)。

**50万点サンプル**(`09LD2626.las`の先頭50万点、16.2MiB):

```
入力の読み込みと展開: 0.014秒 (0.0%)
一時ファイルへの書き込み: 0.102秒 (0.1%)
octreeの分割(LOD): 0.173秒 (0.1%)
ノードの圧縮: 155.409秒 (99.8%)
書き出し: 0.004秒 (0.0%)
合計: 155.701秒
(参考)OPFSの読み書き合計: 154.094秒
(参考)OPFS範囲読み(read_at): 呼び出し1,115,786回, キャッシュヒット1,114,443回,
  ミス1,987回 (ヒット率99.8%), OPFSから実際に読んだバイト数: 124.2 MiB
(参考)OPFS範囲読みの実I/O時間: 0.651秒
```

**200万点サンプル**(64.9MiB、最初の計測ラウンド。下記「追加の計測」の
恒久カウンタ追加前のビルドで取得):

```
ノードの圧縮: 547.885秒 (99.0%)
(参考)OPFSの読み書き合計: 546.293秒
(参考)OPFS範囲読み(read_at): 呼び出し6,921,348回, キャッシュヒット6,900,933回,
  ミス23,871回 (ヒット率99.7%), OPFSから実際に読んだバイト数: 1.46 GiB
(参考)OPFS範囲読みの実I/O時間: 8.950秒
```

### 結果: 仮説は反証された

`read_at`(spillのランダムアクセス読み)のブロックキャッシュのヒット率は
**99.7〜99.8%**で、実際のOPFS I/O時間は合計の**1%未満**(50万点で0.651秒/
155.7秒、200万点で8.950秒/553.4秒)。コーディネーターが疑った「LOD順の
ランダムアクセスでキャッシュがほぼ毎回外れる」という現象は**起きていない**。

(理由の推測、未検証: `partition_index_run`がoctree分割の各レベルで元の
spill順を保ったまま子へ振り分けており〈`lod.rs`のコメント参照〉、特に
**葉ノード**は1つの連続したrunをそのまま使うため、ノード内の点は
spill上でもおおむね近接している。内部ノード(複数オクタントを束ねた
粗いLOD)だけが複数の連続runを交互に読むため非連続になりうるが、全体に
占める割合が小さく、64ブロック×64KiB=4MiBのキャッシュで十分吸収できていた
と考えられる。)

### では実際は何に時間を使っているか — 追加の計測で特定

`opfs_io_secs`(OPFSへの全JS呼び出しの累積、`OpfsIoTimer`)と
`opfs_read_secs`(`read_at`のキャッシュミス時の実I/O時間)の差が大きすぎる
(50万点で154.094秒 vs 0.651秒、ギャップ153.4秒)。`OpfsIoTimer`は書き込み・
flush・truncate・get_size・**`open_at`が返す逐次読み出し
(`OpfsSeqReader::read`)もすべて合算しているため、まずこのギャップを
一時的な(コミットしない)`thread_local`カウンタで`OpfsSeqReader::read`
だけに絞って計測した: **呼び出し500,020回・時間118.614秒**(50万点サンプル、
ノード圧縮120.4秒のほぼ全て)。

ソースを確認すると原因は明確だった。`vendor/copc-writer/src/writer.rs`の
`encode_node_points`:

```rust
let mut index_reader = order.open_at(node.start)?;
for point_index in 0..node.count {
    ...
    let source_index = index_reader.read_u32::<LittleEndian>()...; // 4バイトずつ
    ...
}
```

`order.open_at(..)`が返す`Box<dyn Read + Send>`は、OPFS実装
(`OpfsSeqReader`)では**キャッシュも`BufReader`も無い生のストリーム**で、
`read()`1回がそのままOPFSへの`FileSystemSyncAccessHandle.read()`発行1回になる
(`crates/pcv-wasm/src/opfs.rs`)。このループは1点につき`read_u32`(4バイト)を
1回呼ぶため、**無バッファのOPFS `read()`が点数ぶん発生する**。これは
コーディネーターが疑った「spillのランダムアクセス(`read_at`)」とは別の、
「LODのorderファイルの逐次読み(`open_at`)にバッファが無い」という問題。

対照的に、`lod.rs`の`open_index_run`(octree分割段階が同じ`open_at`を使う
箇所)は`BufReader::with_capacity(INDEX_IO_BUFFER_BYTES=1MiB, ...)`で包んで
おり、`lod_index_build_secs`は50万点で0.173秒(0.1%)・200万点で4.818秒(0.9%)と
小さい。**`encode_node_points`の`order.open_at(node.start)`だけ
`BufReader`で包まれていない**、という1箇所の書き漏れが支配的な原因と見られる
(ソース上は確認したが、`BufReader`を足して直す変更自体はこのタスクの
スコープ外なので未実施・未検証。下記「今回やらなかったこと」参照)。

この発見を恒久的なカウンタとして残した: `OpfsSeqReadStats`/
`OpfsSeqReadCounters`(`opfs.rs`、`OpfsReadStats`と同じ`Rc<Cell<..>>`共有)、
DTOに`opfs_seq_read_calls`/`opfs_seq_read_secs`を追加、内訳テキストに
「(参考)OPFS逐次読み(open_at)」の行を追加した。恒久カウンタを組み込んだ
最終ビルドで同じ50万点サンプルを再計測し、シェルの`console.log`に頼っていた
一時計測と同じ値がUIの内訳パネルに出ることを確認した:

```
(参考)OPFS逐次読み(open_at): 呼び出し500,020回, 実I/O時間: 153.314秒
```

(呼び出し500,020回 ≈ 点数500,000+LOD orderファイル自体の読み出しに伴う
少数の余分な呼び出し。1点につきほぼ1回という仮説と一致する。)

### 環境についての注意(正直に)

このサンドボックス上の数値(50万点で155秒、200万点で547秒)は、**所有者の
実機の数値と桁が大きく違う**(所有者: 576万点で13.6秒 ≈ 1点あたり2.4μs。
このサンドボックス: 50万点で120秒 ≈ 1点あたり240μs、約100倍)。呼び出し回数
(構造的な事実、CPU速度に依存しない)は環境によらず同じはずだが、1回あたりの
時間はこのサンドボックスのヘッドレスChromium・仮想化・他のエージェント
セッションとの同居による負荷などで大きく水増しされている可能性が高い
(**未検証**: 実際に何が遅いのかは切り分けていない)。

ただし、この水増しは「仮説が反証された」という結論(`read_at`のヒット率が
99.7〜99.8%という**比率**)には影響しない。比率や呼び出し回数は負荷に
依存しない構造的な値であり、CPU/IOが遅い環境でも「どこに時間が集中して
いるか」という相対的な内訳は変わらないはずである(推定)。

**所有者の実機でこの新しいカウンタ(`opfs_seq_read_calls`/
`opfs_seq_read_secs`)付きのビルドを実際に走らせた値は未確認**。下記
「所有者が自分で確認する手順」で依頼する。

### 検討した代替案(仮説が反証されたため、いずれも見送り)

コーディネーターが提案していた3案は、いずれも「`read_at`(spillのランダム
アクセス)」を対象にしたものだったが、実測により`read_at`はボトルネックでは
ないと分かったため、以下の理由でどれも実施しなかった:

| 案 | 見送った理由 |
|---|---|
| ブロックキャッシュを大きくする | `read_at`のヒット率は既に99.7〜99.8%で、キャッシュを増やしても伸びしろがほぼ無い。実際のボトルネック(`open_at`の無バッファ読み)には効かない |
| LOD段階でspillをノード順に並べ替える(permute) | 同上。`read_at`側は既に十分速いため、並べ替えても「ノードの圧縮」のほぼ全てを占める`open_at`側の時間は変わらない |
| wasmスレッド(`SharedArrayBuffer`) | GitHub PagesがCOOP/COEPヘッダーを設定できないため`crossOriginIsolated`にならず使えない(`ADR-0012`で既出の制約)。仮にスレッド化できても、無バッファの`open_at`読みという根本原因(1回のJS呼び出しのオーバーヘッドが点数ぶん発生する構造)は並列化しても解消しない |

### 今回やらなかったこと(今回のタスクの範囲について)

**コーディネーターの指示「仮説が反証されたら、Step 1で止めて実際の原因を
報告し、修正は実施しない」に従い、アルゴリズムやコードの修正は一切
行っていない。** 計測(カウンタの追加)だけがこのタスクの成果物。

発見した「`encode_node_points`の`order.open_at(node.start)`を
`BufReader`で包んでいない」という問題は、修正自体は(`lod.rs`の
`open_index_run`と同じパターンを当てはめるだけなので)小さく見えるが、

- `vendor/copc-writer`のノード圧縮という、デスクトップ・Web両方が通る
  ホットパスの変更になる
- バイト同一性・点の集合一致などの回帰確認、ネイティブでの前後比較、
  メモリ上限の確認(本タスクが要求していたのと同種の検証)が改めて要る

ため、**別タスクとして切り出して実施することを推奨する**(このタスクの
指示の範囲を超えるため、今回はソースを読んで原因を特定するところまでに
留めた)。

### 触ったファイル

- `crates/pcv-wasm/src/opfs.rs`: `OpfsReadStats`/`OpfsReadCounters`
  (`read_at`の計測)、`OpfsSeqReadStats`/`OpfsSeqReadCounters`
  (`open_at`の計測)を追加
- `crates/pcv-wasm/src/dto.rs`: `ConversionStageBreakdownDto`に
  `opfs_read_at_calls`・`opfs_cache_hits`・`opfs_cache_misses`・
  `opfs_bytes_read_from_opfs`・`opfs_read_secs`・`opfs_seq_read_calls`・
  `opfs_seq_read_secs`(すべて`Option`)を追加
- `crates/pcv-wasm/src/convert.rs`・`crates/pcv-wasm/src/pcd_import.rs`:
  `finish()`で`OpfsScratchFs::read_stats()`/`seq_read_stats()`を呼びDTOへ渡す
- `src-tauri/src/conversion.rs`: 対応するデスクトップ側DTOに同名フィールドを
  追加(常に`None`、既存の`opfs_io_secs`と同じ理由)
- `src/datasource/conversion-dto.ts`: DTO型とcamelCase変換に新フィールドを追加
- `src/datasource/conversion-breakdown.ts`: 内訳テキストに
  「(参考)OPFS範囲読み(read_at)」「(参考)OPFS範囲読みの実I/O時間」
  「(参考)OPFS逐次読み(open_at)」の行を追加
- `src/datasource/conversion-breakdown.test.ts`: 上記の表示条件のテストを追加
- `src/wasm/pcv-wasm/*`(生成物): `npm run build:wasm`で再生成
  (`.wasm`バイナリのみ差分、`.js`/`.d.ts`はAPI変更が無いため無差分)

### 検証

```bash
cargo test --manifest-path crates/pcv-wasm/Cargo.toml --lib
  # 28 passed(新規: opfs_seq_read_counters_accumulate_across_clones)
cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
  # 成功
cargo test --manifest-path vendor/copc-writer/Cargo.toml
  # 21 passed(無変更、既存のまま。このタスクではvendor/copc-writerに触れていない)
cargo test -p pcv-convert
  # 全件pass(無変更)
cargo check --workspace
  # 成功(src-tauri含む)
npm run typecheck   # 通った
npm run lint        # 通った
npm test            # 319 passed(既存318 + 新規1)
```

**デスクトップ経路(参考値、`crates/pcv-convert/examples/post_process_stage_bench.rs`、
09LD2626.las、576万点、ネイティブ、修正なしなので前後比較ではなく現状値)**:

```
並列圧縮(既定): 後処理合計2.093秒(ノード圧縮1.261秒)
逐次圧縮(--sequential-compress、Web版と同じ逐次経路): 後処理合計5.787秒(ノード圧縮4.927秒)
```

ネイティブはmmap経由でOS任せのページキャッシュを使うため(`ADR-0006`)、
`encode_node_points`の`order.open_at`もメモリ上の読み出しに過ぎず、Web版の
ようなJS境界越えのコストが無い。このため同じ「無バッファ」構造でもネイティブ
では問題にならない(デスクトップ版が今まで気づかれなかった理由)。

### 所有者が自分で確認する手順(未確認事項)

1. **このブランチの最新コードで`npm run build:wasm && npm run build`し、
   実機(所有者のChrome)で`09LD2626.las`(または同等の数百万点規模のLAS)を
   変換し、「変換の内訳」パネルの「(参考)OPFS逐次読み(open_at)」の行の
   数値を確認してほしい。** `ノードの圧縮`の秒数とほぼ一致するはずで、
   一致すれば今回の診断(実機でも同じ要因が支配的)が裏付けられる
2. 「(参考)OPFS範囲読み(read_at)」のヒット率が実機でも99%台かどうか
   (このサンドボックスと違う挙動(例: 実機の方がキャッシュ効率が悪い)が
   無いか)
3. 変換した点群が色付きで表示されること(`hasColor: true`はこのサンドボックスの
   ヘッドレスChromiumで確認済み。スクリーンショットで建物らしき構造物が
   淡色で描画されていることを目視確認した。点自体の色の見分けは
   スクリーンショットの解像度では判別しづらかったため、実機での目視確認を
   依頼する)
4. CIの`frontend`/`rust`ジョブが緑であること(`gh run view <run-id>`)

### 追記(2026-10-09、Sonnet): 修正を実装した

コーディネーターが上記の診断(`encode_node_points`の`order.open_at`が無バッファ)
を確認し、修正を別タスクとして指示した。`vendor/copc-writer`のノード圧縮という
デスクトップ・Web共通のホットパスの変更になるため、「仮説が反証されたら修正
しない」という最初の指示とは別に、今回明示的に承認を得てから実施している。

#### 修正内容

`vendor/copc-writer/src/writer.rs`の`encode_node_points`(行832付近)で、
`order.open_at(node.start)?`が返すストリームを`BufReader`で包んだ:

```rust
let index_buffer_bytes = node
    .count
    .saturating_mul(crate::lod::INDEX_RECORD_BYTES as usize)
    .min(crate::lod::INDEX_IO_BUFFER_BYTES);
let mut index_reader =
    BufReader::with_capacity(index_buffer_bytes, order.open_at(node.start)?);
```

バッファ容量は「ノード自身のorderデータ量(`node.count * INDEX_RECORD_BYTES`
=4バイト)」と「`lod.rs`の`INDEX_IO_BUFFER_BYTES`(1MiB、`open_index_run`が
既に使っている実績ある値)」の小さい方。既定の`max_points_per_node`
(10万点)なら1ノードの最大データ量は約390KiBなので、ほとんどのノードで
**1回のバッファ充填がノード全体をちょうど賄う**(無駄な先読みがほぼ無い)。
読む順序・読む値は一切変えていない(バッファリングの有無だけの違い)ため、
出力はバイト同一になるはず(下記「等価性の確認」で実測して裏付けた)。

#### 他の`open_at`呼び出し箇所をすべて洗い出した(指示どおりgrepで確認)

```
vendor/copc-writer/src/lod.rs:302   copy_scratch_reader内(並列LOD構築)
vendor/copc-writer/src/lod.rs:555   open_index_run内(LOD構築の逐次読み出し)
vendor/copc-writer/src/lod.rs:786   #[cfg(test)]のread_lod_indexヘルパー
vendor/copc-writer/src/scratch.rs   ScratchReaderトレイト定義・
                                     SharedBytesReader/NativeScratchReaderの実装
vendor/copc-writer/src/writer.rs:832 encode_node_points内 ← 今回修正した箇所
```

- **`lod.rs:302`(`copy_scratch_reader`)**: 並列LOD構築(`parallel-lod`機能、
  Web版では無効)が、各ブランチのローカルorderファイルをグローバルなorder
  ファイルへ連結するときに使う。`std::io::copy(&mut stream, out)`を呼んで
  おり、`std::io::copy`は内部で約8KiBの固定バッファを使って読み書きする
  (Rust標準ライブラリの実装)。**1点ずつではなく、ファイル全体を一括で
  コピーする**用途なので、無バッファの点ごと呼び出し問題には当たらない。
  修正不要と判断した。
- **`lod.rs:555`(`open_index_run`)**: 既に`BufReader::with_capacity(
  INDEX_IO_BUFFER_BYTES, reader)`で包まれている(このタスクの最初の調査で
  確認済みの箇所、M4-13本文参照)。修正不要。
- **`lod.rs:786`(`read_lod_index`)**: `#[cfg(test)] mod tests`内のテスト
  専用ヘルパー(`MemoryScratchFs`/`NativeScratchFs`経由でしか呼ばれず、
  OPFSを一切通らない)。本番経路ではないため、無バッファでも実害が無い。
  修正しなかった(一貫性のためにバッファで包む案も検討したが、テストの
  可読性を保つため、本番に影響しない箇所まで変える必要は無いと判断した)。
- **`scratch.rs`**: `open_at`のトレイト定義と、ネイティブ実装
  (`SharedBytesReader`・`NativeScratchReader`、どちらもmmap/`Arc<[u8]>`上の
  メモリアクセスで、JS境界のコストが無い)。OPFS実装(`OpfsSeqReader`、
  `crates/pcv-wasm/src/opfs.rs`)側は別ファイルで、今回は読み出し側
  (`encode_node_points`)にバッファを足すことで対処した(`OpfsSeqReader`
  自体にキャッシュを足す案も検討したが、`encode_node_points`は連続範囲を
  順に読むだけなので、呼び出し側でバッファすれば十分で、`read_at`の
  ブロックキャッシュのような複雑な仕組みは不要と判断した)。

**`compress_nodes_parallel`(coordinatorが挙げた「writer.rs ~786」)について**:
現在のソースでは`encode_node_points`は`compress_nodes_sequential`・
`compress_nodes_parallel`の両方から**同じ1つの関数として共有**されており
(`compress_nodes_parallel`は各バッチ内で`encode_node_points`を普通の`for`
ループで呼んでから、できあがった生バイト列の圧縮だけを`par_iter`で並列化
する設計。本文の「コーディネーターの指示」セクション参照)、`writer.rs`内に
`open_at`の呼び出し箇所は**832行目の1箇所しか無い**ことをgrepで確認した
(`grep -n "open_at" vendor/copc-writer/src/writer.rs`の出力は832行目のみ)。
そのため1箇所を直すだけで逐次・並列の両方の経路が直る。

#### 等価性の確認(ハッシュ比較、実データ)

既存の回帰テスト(修正後も変更無しでpass):

- `cargo test -p pcv-convert`の`native_output_hash_matches_recorded_value`
  (合成1,000点、記録済みFNV-1aハッシュ`0x1835_0A7E_294F_68C3`と一致) → **pass**
  (=修正前後で出力がバイト同一であることの既存の裏付け)
- 同じく`parallel_compress_point_set_matches_sequential`(合成5万点、
  逐次・並列の点集合一致) → **pass**

加えて、**実データ(`09LD2626.las`、576万点)で直接ハッシュを比較した**
(一時スクリプト、コミットしていない。`write_copc_from_spill_with_fs_and_timings`
を直接呼び、FNV-1a 64bitを計算):

| 経路 | 修正前 | 修正後 |
|---|---|---|
| 逐次圧縮 | `73,620,052`バイト, `0x516A43E2EFEEDA63` | `73,620,052`バイト, `0x516A43E2EFEEDA63` |
| 並列圧縮 | `73,620,048`バイト, `0xBA00A6283C7C5438` | `73,620,048`バイト, `0xBA00A6283C7C5438` |

**バイト数・ハッシュとも完全に一致**(修正前は`git checkout -- vendor/copc-writer/src/writer.rs`
でHEAD時点のコードに戻してビルド・変換し、その後修正を復元して同じ入力で
再変換して比較した)。読む順序・値を変えていないという設計どおりの結果。

#### Web、実ブラウザでの計測(BEFORE/AFTER、同じ実データ)

環境は本文と同じ(このサンドボックスのヘッドレスChromium、
`channel: "chromium"`)。BEFORE列は`git checkout --`でHEAD版の
`writer.rs`に戻してwasmを再ビルドして計測、AFTER列は修正版。

| サンプル | 段階 | BEFORE | AFTER |
|---|---|---|---|
| 09LD2626.las 先頭50万点 | 合計 | 155.701秒 | **0.857秒** |
| | ノードの圧縮 | 155.409秒 (99.8%) | 0.502秒 (58.6%) |
| | OPFS逐次読み(open_at)呼び出し回数 | 500,020回 | **29回** |
| | OPFS逐次読み(open_at)実I/O時間 | 153.314秒 | 0.023秒 |
| 09LD2626.las 先頭200万点 | 合計 | 553.361秒 | **8.477秒** |
| | ノードの圧縮 | 547.885秒 (99.0%) | 5.534秒 (65.3%) |
| | OPFS逐次読み(open_at)呼び出し回数 | (計測なし、下記注参照) | **133回** |
| | OPFS逐次読み(open_at)実I/O時間 | (計測なし) | 0.112秒 |
| **09LD2626.las フル(576万点、所有者と同一ファイル)** | 合計 | **10分経っても未完了**(タイムアウト) | **31.939秒** |
| | ノードの圧縮 | (未計測、未完了のため) | 17.327秒 (54.2%) |
| | octreeの分割(LOD) | (未計測) | 13.263秒 (41.5%、今回は相対的に目立つようになった) |
| | OPFS逐次読み(open_at)呼び出し回数 | (未計測) | **340回** |
| | OPFS逐次読み(open_at)実I/O時間 | (未計測) | 0.373秒 |
| | OPFS範囲読み(read_at)ヒット率 | (未計測) | 99.7%(22,129,902回中ミス76,551回) |

(200万点のBEFORE行の「計測なし」: `OpfsSeqReadStats`を恒久カウンタとして
組み込む前の1回目の計測ラウンドで取った数値だったため。`opfs_io_secs`
〈全OPFS呼び出しの合計〉は546.293秒で、`opfs_read_secs`〈read_atの実I/O〉
8.950秒との差〈537.343秒〉がほぼ全てopen_at側だったことは分かっている。
恒久カウンタ導入後に50万点で確認した構造〈open_atがほぼ全て〉から、200万点
でも同じ構造だったとほぼ断定できるが、**この行だけ実測した`opfs_seq_read_*`
の値そのものは無い**。正直に明記する。)

576万点のフルファイルは、修正前はこのサンドボックスで10分(タイムアウト
設定)経っても変換が終わらなかった(前回BEFORE計測の報告どおり)。
**修正後は31.939秒で完了し**、スクリーンショットで実際に点群が描画される
ことを確認した(`drawn: 3,750,295 pts / 60 nodes`、`hasColor: true`。
4秒待ってから撮ったスクリーンショットでは、グレー〜白っぽい建物らしき
構造物が見えた。点そのものの色の見分けは解像度の都合で判別しづらく、
実機での確認を依頼する点は変わらない)。

修正後、相対的に「octreeの分割(LOD)」(13.263秒)が「ノードの圧縮」
(17.327秒)に迫るほど目立つようになった。これは`read_at`経由の`xyz_at`
呼び出し(22,129,902回、ヒット率99.7%、実I/O時間23.048秒)がこのサンドボックス
環境では1回あたり比較的重い(ネイティブの参考値では0.091秒/576万回
=1回あたり約16ナノ秒なのに対し、このサンドボックスでは23.048秒/
22,129,902回≈1回あたり約1.04マイクロ秒、ネイティブの数十倍)ためで、
`read_at`自体はキャッシュヒット率が高く「壊れている」わけではない
(本文の「結果: 仮説は反証された」のとおり)。`xyz_at`がLOD構築の各階層で
点1つにつき複数回呼ばれる構造(本文参照)である以上、絶対的な改善には
wasmスレッド化などアーキテクチャ側の変更が要るが、**今回のタスクの
範囲外**(「ノードの圧縮」という当初の問題は解消した)。

#### Web、autzen.pcd(320MB、10,653,336点)

コーディネーターから「動画撮影時、600秒経っても変換が終わらなかった」と
報告されていたファイル。修正後に実際に試した:

```
入力の読み込みと展開: 4.221秒 (12.6%)
一時ファイルへの書き込み: 2.995秒 (8.9%)
octreeの分割(LOD): 14.700秒 (43.8%)
ノードの圧縮: 11.674秒 (34.7%)
書き出し: 0.004秒 (0.0%)
合計: 33.595秒
(参考)OPFSの読み書き合計: 17.836秒
(参考)OPFS範囲読み(read_at): 呼び出し49,629,727回, ヒット率99.9%
(参考)OPFS範囲読みの実I/O時間: 13.273秒
(参考)OPFS逐次読み(open_at): 呼び出し794回, 実I/O時間: 0.860秒
```

**33.6秒で完了した**(修正前は600秒経っても終わらなかった)。スクリーン
ショットで、Autzenスタジアムの点群が**はっきり色付きで**(緑・青・黄土色の
地形)描画されることを確認した(`drawn: 5,208,951 pts / 93 nodes`、
`hasColor: true`)。PCDインポート経路(`crates/pcv-wasm/src/pcd_import.rs`の
`WasmPcdConverter`)も同じ`vendor/copc-writer`の`encode_node_points`を
通るため、今回の修正がそのまま効いた。

#### デスクトップ、ネイティブ(参考値、`post_process_stage_bench.rs`、09LD2626.las)

| 経路 | BEFORE(修正前) | AFTER(修正後、2回計測) |
|---|---|---|
| 並列圧縮(既定) 合計 | 2.093秒 | 1.166秒 / 0.970秒 |
| 並列圧縮 ノード圧縮のみ | 1.261秒 | 0.510秒 / 0.503秒 |
| 逐次圧縮(--sequential-compress) 合計 | 5.787秒 | 3.518秒 / 2.258秒 |
| 逐次圧縮 ノード圧縮のみ | 4.927秒 | 2.234秒 / 1.628秒 |

**デスクトップは遅くなっていない(むしろ速くなっている)。**
ネイティブはmmapなので`open_at`も元々メモリ上の参照に過ぎず
(`crates/pcv-wasm/src/opfs.rs`のようなJS境界コストが無い)、無バッファ
でも致命的ではなかったが、`read_u32`を4バイトずつ呼ぶたびに発生していた
Rustの関数呼び出し・トレイトディスパッチのオーバーヘッドが`BufReader`で
まとめて読むことにより減ったとみられる(**未検証の推測**。プロファイラ等
での確認はしていない)。2回の計測で多少ばらつきがある(他プロセスの負荷の
影響、このマシン上で他のエージェントセッションも動いている可能性がある)
が、いずれも修正前より明確に速く、遅くなった形跡は無い。

#### メモリ上限

追加したバッファ(`index_buffer_bytes`)は「ノード自身のorderデータ量」と
「`INDEX_IO_BUFFER_BYTES`(1MiB)」の小さい方なので、**常に1MiB以下**。
`encode_node_points`は`compress_nodes_sequential`・`compress_nodes_parallel`
のどちらでも、普通の`for`ループで1ノードずつ逐次呼ばれる(並列化されるのは
圧縮済みバイト列への変換〈`compress_standalone_chunk`〉だけで、
`encode_node_points`自体が複数スレッドから同時に呼ばれることは無い。
ソースコードを読んで確認済み)。したがって**同時に存在するこのバッファは
常に1個**で、追加メモリのピークは

```
1MiB(バッファ上限) × 1(同時読み出し数) = 1MiB
```

点数・ノード数に関わらず一定(規約「メモリが点数に比例しないこと」を
満たす)。

#### 検証(修正後、再実行)

```bash
cargo test --manifest-path vendor/copc-writer/Cargo.toml
  # 21 passed
cargo test -p pcv-convert
  # 全件pass(native_output_hash_matches_recorded_value・
  # parallel_compress_point_set_matches_sequentialを含む)
cargo test --manifest-path crates/pcv-wasm/Cargo.toml --lib
  # 28 passed
cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
  # 成功
cargo check --workspace
  # 成功
npm test        # 319 passed
npm run typecheck  # 通った
npm run lint       # 通った
```

#### 触ったファイル(この追記ぶん)

- `vendor/copc-writer/src/writer.rs`: `encode_node_points`の
  `order.open_at(node.start)`を`BufReader`で包んだ(上記の修正内容)
- `src/wasm/pcv-wasm/*`(生成物): `npm run build:wasm`で再生成
  (`.wasm`バイナリのみ差分)

#### 所有者が自分で確認する手順(追記ぶん)

1. 実機(所有者のChrome)で`09LD2626.las`を変換し、「ノードの圧縮」が
   数秒程度(このサンドボックスでは17.3秒、実機はおそらくもっと速い)に
   収まることを確認する(修正前は13.6秒〈87.8%〉だったので、改善幅は
   このサンドボックスほど劇的ではないかもしれないが、「OPFS逐次読み
   (open_at)」の呼び出し回数が数百回程度(点数に依存しない)になっている
   ことが重要な確認点)
2. `C:\rust\point-cloud-viewer\data\autzen.pcd`(320MB)を実機で変換し、
   動画撮影時に経験した「600秒経っても終わらない」状態が解消しているか
   確認する
3. 変換した点群(09LD2626.las・autzen.pcd)が色付きで表示されることを
   目視確認する(autzen.pcdはこのサンドボックスの画面でも明確に色付きだった)
4. CIの`rust`/`frontend`ジョブが緑であること



## M4-14: 複数のLAS/LAZを選ぶと1つのCOPCにマージして開く(2026-10-10、Sonnet)

### 何をしたか

ファイル選択で LAS/LAZ を複数(2件以上)選ぶと、1つのCOPCへ変換して開くようにした
(デスクトップ・Android・Web)。元は開発者向けCLI(`TOOL-merge-las-to-copc.md`)専用だった
`crates/pcv-convert/src/merge.rs` をアプリから呼ぶ。1件だけの選択は今までと同じ経路
(`openFiles`が既存の`openFile`へ委譲、Rust側も`start_las_conversion`へ委譲)。
LAS/LAZ以外(PLY/PCD/E57)が混じると、変換前にファイル名を挙げた日本語エラー。

### なぜこの設計か(採らなかった案)

- **新しいoctree/writerは書かない**: `merge.rs`の`MultiFileLasPoints`(複数ファイルを
  1本のイテレータにする。同時に開くのは1ファイル)をそのまま使う。メモリが点数・
  ファイル数に比例しない性質も同じ。
- **事前に1本のLASへ結合する案は不採用**: 巨大な一時ファイルが増えるだけ(TOOL文書と同じ判断)。
- **検証はヘッダーだけ**: デスクトップは`summarize_headers`(point format・CRS)、Webは
  `inspectLasHeaderSummary`(wasm、`layout_key`/`crs_label`の文字列比較)。CRSは
  `pcv_core::crs::detect_crs_from_las_header`の結果が違えば拒否。両方「不明」は一致扱い。
  point formatが違うファイルは`StreamingLayout`の不一致で拒否(`copc-writer`が1回の書き出しで
  1つのレイアウトしか扱えないため)。scale/offsetの違いは許可(`LasPointRecord`が
  実世界座標f64を運ぶため。下記テストで確認)。
- **キャッシュキーは選択順に依存しない**: (名前,サイズ,更新日時)をソートして1つのハッシュに
  畳み込む(各ファイルのハッシュをXORする案は、同じファイルを2回選ぶと打ち消すので不採用)。
  デスクトップは`cache::MultiSourceFingerprint`+サイドカー、Webは`opfs.cacheKeyForMulti`+
  OPFSの索引(`MultiCacheMeta`)。
- **表示名/出力名**: 「<先頭ファイル名(拡張子なし)> ほか<N-1>ファイル」。デスクトップはこれを
  そのままキャッシュ配下のファイル名にし(`output_path::multi_output_file_name`。複数
  ディレクトリに散らばる入力では「元ファイルの隣」が定まらないため、常にアプリの
  キャッシュディレクトリ)、Webは`suggestedFileName`に使う。名前が衝突しても、サイドカー/索引の
  指紋が違えば再変換されるだけで正しさは保たれる。
- **Web**: 先頭ファイルで`WasmConverter`を作り、`setDeclaredTotals`で全入力の合計点数・サイズに
  上書きし、`openNextFile`で読み込み元だけ次のファイルへ入れ替える(spillは1本のまま)。
  LAZの並列展開(M4-7のpull型・背圧)はファイルごとに今までどおり動く(ファイル間は逐次)。
  OPFSスクラッチ・Web Locks・容量見積もり(全入力の点数の合計)も単一ファイル版と同じ流れ。
  進捗は全入力の合計点数に対する1本。
- **Android**: マージ本体は`std::fs`/`las::Reader::from_path`のパス前提で`content://`は読めない。
  `content://`が混じったら明確なエラーで止める。**Androidの複数選択は未対応**
  (`File`ベースへの書き換えが必要)。

### 触ったファイル

- Rust: `crates/pcv-convert/src/{merge,cache,output_path,streaming}.rs`、
  `crates/pcv-convert/examples/merge_paths_bench.rs`(新規、計測用)、
  `src-tauri/src/{conversion,lib}.rs`(`start_multi_las_conversion`)、
  `crates/pcv-wasm/src/{convert,dto,pcd_import}.rs`(`openNextFile`/`setDeclaredTotals`/
  `inspectLasHeaderSummary`、`input_file_count`)、生成物`src/wasm/pcv-wasm/*`
- TS: `src/datasource/{opfs,tauri,web,web-protocol,copc.worker,conversion-dto,conversion-breakdown}.ts`、
  `src/state/useCopcViewer.ts`(`openFiles`)、`src/ui/shell/LayerPanel.tsx`(`multiple`・
  `pickLocalFiles`のみ。`data-testid`は不変)
- テスト: `scripts/make-test-las.ts`(offsetX/Y/Z)、`e2e/web-multi-conversion.spec.ts`、各`*.test.ts`

### 確認したこと(実行したコマンドの結果)

- Rustテスト: `merging_with_different_scale_and_offset_keeps_real_world_coordinates`
  (scale0.001/offset0 と scale0.01/offset100000 の入力で実世界座標が一致。tile-bの値は
  自身のscale(0.01)で表せる123.46を使った。123.456だと入力ファイルへ書く時点で丸まる)、
  `merging_rejects_mismatched_crs`、`merging_rejects_mismatched_layouts`、
  `merging_three_small_files_yields_correct_count_bounds_and_points`(点数・bounds)、
  `merge_paths_and_timings_reports_progress_and_correct_metadata`、キャッシュ/出力名の順序非依存。
  `cargo test -p pcv-convert --lib`: 60件成功。pcv-wasm(ネイティブ)31件成功
  (`check_layout_and_crs_match_*`を含む)。
- `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
  pcv-wasmのwasm32 clippy、`npm run typecheck`・`lint`、`npx vitest run`(329件)成功。
- **Web E2E(実Chromium)**: `npx playwright test`で2件成功(新規: offsetの異なる合成LAS3つ
  合計1500点を一緒に選び、内訳に「入力ファイル数: 3」、エラー・panic無し、点数=1500)。
- **Web実データ(ヘッド付き(headed)のChromium、`data/tokyo-shibuya/`)**:
  - 09LD2626〜2628の3タイル: 変換+表示まで約171秒(別の回160秒・208秒など回ごとに差あり)、
    点数21,791,996(デスクトップのTOOL文書の3タイルと一致)、入力ファイル数3、合計706.6MiB、
    エラー無し。内訳: LOD78.2秒・ノード圧縮83.9秒(OPFS読み書き合計134秒)。
    ズームしたスクリーンショットを目視した: 色付きの街区が3タイルにまたがって途切れず表示され、
    継ぎ目の隙間は見えなかった(厳密な継ぎ目検証ではなく、あくまで目視)。
    2タイル(12,463,699点)97秒、09LD2627〜2629の3タイル(24,276,716点)208秒も成功。
  - **4タイル(09LD2626〜2629、30,043,046点)はWebで失敗した**(下記「未解決」)。
- **デスクトップ変換経路(Tauri GUI抜き、`merge_paths_and_timings`を直接呼ぶexample)**:
  同じ4タイル、30,043,046点、15.21秒、ピークプライベートメモリ308.3MiB
  (`PrivateMemorySize64`を500msごとにポーリング)、出力約405MB。進捗の最後の値=点数。

### 未解決・未確認

- **Web: 約30M点で`range start index 4294967288 out of range for slice of length 1048576`
  のpanic→「unreachable」で失敗する。マルチファイル固有ではない**: 4タイルを連結した単一の
  LAS(30,043,046点、一時ファイル、削除済み)を既存の単一ファイル経路で開いても同じpanicが出た。
  24.3M点までは成功。原因箇所は未特定(1MiBバッファ=`copc-writer`の`INDEX_IO_BUFFER_BYTES`
  周辺か、M4-13のBufReader修正の影響かは**未検証**)。別タスクで調査が必要。
  このため受け入れ条件「Webで4タイル」は満たせず、3タイルで代替した。
- 内訳の「形式」: Web複数ファイルは「las/laz(複数ファイル)」。
- **デスクトップ・AndroidのGUIは未確認**。Androidの複数選択は未対応(上記)。
- 並行して進むUI再構築との衝突は、UI側の変更を`multiple`と`pickLocalFiles`に限って避けた。

### 所有者の確認手順

1. デスクトップ: `npm run tauri dev`→「ファイルを選ぶ…」で`data\tokyo-shibuya\09LD2626〜2629.las`を
   複数選択→進捗バーが全体の点数に対して進み、「09LD2626 ほか3ファイル」が開く。内訳に入力ファイル数4。
   もう一度同じ選択(順序を変えてもよい)で即座に開く(キャッシュ)。
2. 点フォーマットやCRSの違うファイルを混ぜるとファイル名つきのエラーがバナーに出る。
   PLY等を混ぜると「複数ファイルの選択はLAS/LAZのみ」。
3. Web: 同様に複数選択。3タイルまでは通る。4タイル以上は上記panicの調査待ち。
