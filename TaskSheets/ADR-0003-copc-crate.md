# ADR-0003: COPC読込クレートの選定

- 状態: 採択
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
