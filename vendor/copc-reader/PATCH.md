# なぜこのクレートが vendor/ にあるのか

これは [`copc-reader` 0.9.0](https://crates.io/crates/copc-reader) の複製に、
**2箇所修正・追加を当てたもの**である。

- 上流: https://github.com/roteiro-gis/copc-rust
- ライセンス: MIT OR Apache-2.0（本プロジェクトと同じ。改変して再配布できる）
- 取り込み元: crates.io の 0.9.0 パッケージそのまま

## 何を直したか

`src/lib.rs` の `CopcFile::from_reader` にあった、以下の前提チェックを修正した。

```rust
// 修正前（誤り）
if copc_info.root_hier_offset != root_evlr.data_offset {
    return Err(...);
}
```

COPC 仕様では、hierarchy は `copc` / record_id 1000 の EVLR に格納され、
**複数の hierarchy ページに分割されうる**。`root_hier_offset` はその EVLR 内にある
**root ページの位置**を指すのであって、EVLR データの先頭を指すとは限らない。

上流は両者が一致することを要求していたため、hierarchy が複数ページに分かれる
**大規模 COPC ファイルをすべて拒否していた**。

正しい条件は「root ページが EVLR の範囲内に収まっていること」なので、そう直した。
オーバーフロー検査も加えてある。

## なぜこの直し方で十分なのか

**上流の複数ページ走査そのものは正しく実装されている。** 修正した if 文の直後にある
`read_hierarchy_page_at` は `root_hier_offset` を正しく使っており、
`insert_hierarchy_pages` は子ページ参照を `visited_pages` による循環対策付きで辿る。

つまり正しく動くコードの手前に、誤った前提のガードが置かれていただけだった。
ガードを正しい条件に直すだけで動く。

## 実証

| | `autzen-classified.copc.laz` | `sofi.copc.laz` |
|---|---|---|
| 点数 | 10,653,336 | 364,384,576 |
| hierarchy ページ | 1 | 約5 |
| 修正前 | 開ける | **拒否される** |
| 修正後 | 開ける | **開ける（5.8 ms）** |

再現手順とデータの入手は `TaskSheets/TEST-DATA.md`、
経緯は `TaskSheets/ADR-0003-copc-crate.md` の追記を参照。

## いつ消せるか

上流が同じ内容を修正したバージョンを出したら、`vendor/` を削除して
ルートの `Cargo.toml` から `[patch.crates-io]` を外す。

**その際は必ず `sofi.copc.laz` が開けることを確認してから消すこと。**
合成データでは、hierarchy が1ページに収まるためこの欠陥は再現しない。

## 2つめの変更: `CopcReader::read_node` を追加した

`src/points.rs` の `impl<R: Read + Seek + Send> CopcReader<R>` に
`pub fn read_node(&mut self, key: VoxelKey) -> Result<Vec<Point>>` を追加した。

### なぜ追加したか

上流の公開APIは `points(LodSelection, BoundsSelection)` という
「レベル+bboxの空間クエリ」しか提供していない。1ノードだけを読みたい呼び出し側
（`pcv-core`）は、これを「そのノードのlevel全体を対象に、そのノードのbboxで絞る」
という形で転用するしかなかった。

これは遅い。bboxが交差する**そのレベルの全ノードのチャンク**を伸長してから、
自分のノードに属さない点を大半捨てる（深いレベルほど交差ノードが増えるため、
level 0では無駄がなくても、深いlevelでは大半が無駄になる）。実測（`sofi.copc.laz`、
`crates/pcv-core/examples/parallel_bench.rs`）で1ノードあたり単スレッド88msかかっており、
8スレッドで頭打ちになる主因だった。詳細は `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`
の追記を参照。

加えてこの転用には副作用があった: bboxの交差判定は両端inclusiveなので、
立方体の面がちょうど接している隣のノードの点まで拾ってしまう。`pcv-core`側は
これを`point_belongs_to_key`という自前のoctant判定フィルタで対症療法していた
（`ADR-0003`のM1-1バグ、`ADR-0007`のノード読み出しコストの根本原因は同じ
「レベル全体を読んで捨てる」設計だった）。

### 何をしたか

COPCのhierarchy `Entry`は、ノード1つぶんの点データが**ファイルのどこからどこまで
連続したLAZチャンクとして書かれているか**を`offset`/`byte_size`として直接持っている
（COPCライターは1ノード＝1チャンクという規約で書く。チャンクの境界を跨いで別ノードの
点が混じることはない）。

`read_node`はこの`offset`/`byte_size`へ直接`seek`し、そのチャンクだけを
`LayeredPointRecordDecompressor`で伸長する。**空間クエリも、bboxによる絞り込みも、
事後のoctant判定フィルタも一切行わない。** 読んだ点は無条件に全てそのノードに属する
（COPCの構造上そうなるように書かれているため）。

実装は既存の非公開ヘルパーの組み合わせでしかない:
- `read_chunk_bytes`（`entry.offset`へseekして`entry.byte_size`バイト読む。
  `read_columns_inner`が非parallel経路で既に使っていたのと同じ関数）
- `decode_chunk_points`（読んだバイト列を`las::Point`へ伸長する。
  `CopcRangeReader::read_points`が既に使っていたのと同じ関数）

どちらも新規に書いたコードではなく、既存の内部実装を1ノード用の薄いAPIとして
外に出しただけである。

### 効果

`crates/pcv-core/examples/parallel_bench.rs`での修正前後の比較は
`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`の追記を参照。

## いつ消せるか（2つめの変更）

上流が同等の「1エントリだけ直接読む」APIを公開したら、`pcv-core`側をそちらに
差し替えたうえでこのパッチ部分は消せる。1つめの変更（hierarchy offset）とは
独立なので、片方だけ消すこともできる。
