# ADR-0003: COPC読込クレートの選定

- 状態: 採択（**追記あり: 末尾の「copc-reader 0.9.0 は大規模 COPC を開けない」を必ず読むこと**）
- 日付: 2026-09-22
- 前提: [ADR-0001](./ADR-0001-architecture.md)、[M1-point-rendering.md](./M1-point-rendering.md) の M1-1

## 決定

`pcv-core` のCOPCリーダーには **`copc-core` 0.9.0 + `copc-reader` 0.9.0**（同じ
`roteiro-gis/copc-rust` リポジトリの姉妹クレート）を採用する。`copc-rs` 0.5.0 は
採用しない。

## 背景

規約1（ARCHITECTURE.md）は「`pcv-core` が `wasm32-unknown-unknown` でビルドできること」。
これが崩れるとWeb版のバックエンドが成立しない。候補は2つで、**実際に両方をビルドして
確かめた**（推測で決めない、というタスクの指示に従った）。

### 検証1: `copc-rs` 0.5.0 — ネイティブですらビルドが通らない

`copc-rs = "0.5.0"` を単独で依存に追加し、`cargo build`（wasm以前にまずネイティブ）を
試したところ、**wasmターゲット以前の時点で失敗した**。

```
error[E0308]: `?` operator has incompatible types
   --> copc-rs-0.5.0\src\writer.rs:359:52
    |
359 |             compressor: CopcCompressor::new(write, header.laz_vlr()?)?,
    |                                                    ^^^^^^^^^^^^^^^^^ expected `LazVlr`, found `laz::laszip::vlr::LazVlr`
note: there are multiple different versions of crate `laz` in the dependency graph
```

原因は依存グラフの分裂: `copc-rs` 自身は `laz = "0.9.2"`（`^0.9.2` → 0.9.x系列）を
直接要求する一方、`las = "0.9.2"`（同じく `^0.9.2` → 実際に解決されるのは最新の
`las 0.9.11`）が今日時点では **`laz = "^0.12.0"` を要求する**よう更新されていた。
結果、依存グラフに `laz 0.9.3` と `laz 0.12.2` が両方入り、`copc-rs` 自身のコード
（`writer.rs`）が両バージョンの `LazVlr` 型を混同してコンパイルエラーになる。

`las` を明示的に `=0.9.2`（`copc-rs` 公開当時と揃うバージョン）に固定しても解決しない:
今度は `las 0.9.2` の `Header::laz_vlr()` が `Option` を返す一方、`copc-rs` のコードは
`Result` を返す前提で `?` を使っており、別のコンパイルエラーになる。

```
error[E0277]: the `?` operator can only be used on `Result`s, not `Option`s
   --> copc-rs-0.5.0\src\writer.rs:359:68
```

つまり `copc-rs` 0.5.0 は、公開時点の `las`/`laz` の組み合わせに対してのみ噛み合う
コードになっており、**現在crates.ioから素直に依存解決すると（wasmであるかネイティブ
であるかを問わず）ビルドが通らない**。これはwasm固有の問題より根が深く、アップストリーム
側で `Cargo.lock` を伴わない配布・依存範囲の指定に起因する事実上の破損状態と判断した。
`writer` 機能（M1-1のテストデータ生成に使える）を評価する以前の話として、この時点で
候補から外した。

### 検証2: `copc-core` + `copc-reader` 0.9.0 — ネイティブ・wasm32とも成功

同様に単独プロジェクトを作り、`copc-core = "0.9.0"` と `copc-reader = "0.9.0"`
（デフォルトフィーチャのみ。`http`/`parallel` は有効化しない）を依存に追加した。

```
$ cargo build
   ...
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.21s

$ cargo build --target wasm32-unknown-unknown
   ...
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 15.55s
```

両方とも警告なしで成功した。`copc-reader` は `CopcFile::from_reader<R: Read + Seek>`
（ジェネリック）と `CopcFile::open<P: AsRef<Path>>`（`std::fs::File` を内部で使う便利関数）
の両方を提供しており、`std::fs` を直接要求しない読み方ができる（M1-point-rendering.md
が「望ましい」としている設計）。`std::fs::File` 自体もwasm32-unknown-unknownの
libstdスタブとして型は存在し、コンパイルは通る（実行時にファイルを開く経路は
Web版では別途HTTP Rangeに差し替える前提で、M1時点ではネイティブ経路のみ実装する）。

この2クレートを実際に `pcv-core` に組み込み、`cargo test -p pcv-core` と
`cargo build -p pcv-core --target wasm32-unknown-unknown` の両方で確認した
（結果はM1-point-rendering.mdのM1-1受け入れ条件を参照）。

### 副次的な問題と対処: octreeノード境界の点の帰属

`copc-reader` の `CopcReader::points(LodSelection::Level(l), BoundsSelection::Within(bbox))`
は、LOD向けの汎用クエリとしては便利だが、`Bounds::intersects` / `contains_xyz` が
両端inclusiveなため、**立方体の面がちょうど接している隣のノードの点まで拾ってしまう**
ことを実装中に発見した（1ノードだけ読み出すテストで、申告点数と実際の点数が
1点だけ食い違うことがあった）。単純に境界をepsilon縮める対処は、今度は逆に
自分自身の境界上にある正当な点を取りこぼす（COPCのcenter/halfsizeはデータ範囲
ぴったりに作られることが多く、境界上に点が乗ることは珍しくない）。

対処として、`crates/pcv-core/src/copc.rs` の `point_belongs_to_key` で
`copc-writer`（`lod.rs` の `child_octant`: 「各軸が現在の立方体の中心以上なら
上位octant」という再帰的な中央分割）と同じ規則を自分で再現し、bboxクエリで
広めに取った候補点を正確に1ノード分だけへ絞り込んでいる。これはクレート選定の
判断そのものには影響しないが、「汎用クエリAPIを1ノード取得に転用する際の落とし穴」
として次に読む人のために残す。

## 帰結

**得たもの**
- `pcv-core` が `wasm32-unknown-unknown` でビルドできる状態を実測で確認できた
  （規約1を満たす）
- `Read + Seek` ジェネリックな読み方ができ、Web版でHTTP Rangeソースに差し替える
  余地を残せる
- `las`/`laz` は最新の安定バージョン（`las 0.10`, `laz 0.12`）に揃っており、
  `copc-rs` のような依存グラフ分裂が今のところ無い

**払うもの**
- `copc-core`/`copc-reader`/`copc-writer` は比較的新しく小規模なクレート
  （`roteiro-gis/copc-rust`、2026年公開）で、`copc-rs`（`pka/copc-rs`、2022年〜）ほど
  実績が積まれていない。将来同様の依存グラフ分裂が起きるリスクはゼロではない
- writer機能（`copc-writer`）は実行時依存には含めず、テスト専用の `dev-dependencies`
  にとどめた。将来「アプリ内でCOPCを書き出す」機能が要るときは改めて評価が要る
- 1ノード取得のための境界点判定を自前実装する必要があった（上記の副次的な問題）。
  `copc-reader` の公開APIが「LODレベル+bbox」という粗い粒度のクエリしか
  提供していないための代償で、クレートを差し替えても同種の対処は要りうる

## 却下した案

| 案 | 却下理由 |
|---|---|
| `copc-rs` 0.5.0 | 現在の`las`/`laz`の依存解決では**ネイティブですらビルドが通らない**（本文の検証1参照）。writer機能でテストデータをコード生成できる利点は魅力的だったが、そもそも本体がビルドできなければ意味がない |
| `copc-rs` + `las`/`laz` のバージョンをpatchで固定して自前修正 | アップストリームのバグを`pcv-core`側でフォークして抱え込むことになり、「実装を追えること」を優先する方針（ADR-0001）に反する。素直にビルドが通る`copc-core`があるならそちらを使う |
| `copc-core`/`copc-reader` の `http`/`parallel` フィーチャを有効化 | `http`は`ureq`（TLS込み）、`parallel`は`rayon`（スレッド）を引き込み、wasm側の前提を複雑にする。M1時点ではネイティブのファイル読込だけで足りるため見送った。Web版のRange読込はM2以降で別途検討する |

---

## 追記（2026-09-22）: `copc-reader` 0.9.0 は大規模 COPC を開けない

**この ADR の決定は、実データでの検証によって覆った。** 採用した `copc-reader` 0.9.0 には、
hierarchy が複数ページに分かれた COPC ファイルを開けないという欠陥がある。
大規模点群では hierarchy は必ず複数ページになるため、**本プロジェクトの目的にとって致命的**である。

### 発覚の経緯

M1 の検証は `copc-writer` で生成した合成データ（最大20万点）で行われており、
公開実データでの確認をしていなかった。受け入れ条件を数億点規模に引き上げ、
公開データ `sofi.copc.laz`（364,384,576 点 / 2.03 GB）で試したところ、
以下のエラーで開けなかった。

```
COPC root hierarchy offset 2029609895 does not match EVLR data offset 2029271687
```

### 原因

COPC 仕様では、hierarchy は `copc` / record_id 1000 の EVLR に格納され、
**複数の hierarchy ページに分割されうる**。COPC info VLR の `root_hier_offset` は
**その EVLR 内にある root ページの位置**を指すのであって、EVLR データの先頭を指すとは限らない。

`copc-reader` 0.9.0 は `root_hier_offset == EVLR データ先頭` を前提にしており、
一致しなければエラーにする。この前提は hierarchy が1ページに収まる場合にのみ成り立つ。

ファイル構造を直接解析して確認した結果:

| | `autzen-classified.copc.laz` | `sofi.copc.laz` |
|---|---|---|
| 点数 | 10,653,336 | 364,384,576 |
| hierarchy エントリ数 | 278 | 13,279 |
| EVLR データ長 | 8,896 バイト | 424,928 バイト |
| root ページのサイズ | 8,896 バイト | 86,720 バイト |
| hierarchy ページ数 | 1 | 約5 |
| root ページの位置 | EVLR 先頭と一致 | EVLR 先頭 +338,208 バイト |
| root ページが EVLR 内に収まるか | YES | **YES（仕様に適合している）** |
| `copc-reader` で開けるか | 開ける | **拒否される** |

sofi の root ページは `2029609895 .. 2029696615` にあり、これは EVLR データ範囲
`2029271687 .. 2029696615` の内側で、かつ末尾にぴったり一致する。**ファイルは正しい。
拒否している側が誤っている。**

### なぜ合成データでは出なかったのか

`copc-writer` で生成した小規模データは hierarchy が1ページに収まるため、
`root_hier_offset == EVLR データ先頭` が偶然成り立つ。**合成データと小規模データだけで
検証していたために、この欠陥は M1 の全工程をすり抜けた。**

これは [TEST-DATA.md](./TEST-DATA.md) に書いた「数億点でしか構成は検証できない」の実例である。

### 対処の方針

hierarchy のページ形式は COPC 仕様で明確に定義されている（1エントリ32バイト。
key = level/x/y/z の i32×4、offset u64、byteSize i32、pointCount i32。
pointCount が -1 のエントリは子ページへの参照）。**自前で走査するのは難しくない。**

検討順:

1. **hierarchy の走査を `pcv-core` で自前実装する。** root ページから始めて子ページ参照を
   たどる。点データの読み出し（チャンクの LAZ 伸長）は引き続き `copc-reader` に任せられるか、
   API を確認する
2. `copc-reader` にパッチを当てて fork する
3. `copc-rs` の再評価（本 ADR で落としたが、落とした理由は依存解決の失敗であり、
   この欠陥とは別の問題。`laz` のバージョン固定で通る可能性がある）

**どの方針でも、`sofi.copc.laz` が開けることを完了条件とする。** 合成データで通っても意味がない。

### 上流への報告

この欠陥は `copc-reader`（roteiro-gis/copc-rust）の上流に報告する価値がある。
ただし第三者のリポジトリへの投稿は外部への働きかけなので、**所有者の承諾を得てから行う。**
