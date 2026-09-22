# なぜこのクレートが vendor/ にあるのか

これは [`copc-reader` 0.9.0](https://crates.io/crates/copc-reader) の複製に、
**1箇所だけ修正を当てたもの**である。

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
