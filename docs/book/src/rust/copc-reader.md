# vendor/copc-reader: 直した点

[`vendor/copc-reader`](https://github.com/dOtOb9/point-cloud-viewer/tree/main/vendor/copc-reader) は、crates.io の `copc-reader` 0.9.0
（[`roteiro-gis/copc-rust`](https://github.com/roteiro-gis/copc-rust)、MIT OR Apache-2.0）をそのまま複製し、
2箇所に修正・追加を当てたものです。ルートの `Cargo.toml` の `[patch.crates-io]`
で、依存解決がこのローカルコピーを使うように差し替えられています。

経緯の全文は [`vendor/copc-reader/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-reader/PATCH.md) にあります。ここでは要点だけ書きます。

## 修正1: 複数ページの hierarchy を拒否していたガードを直した

COPC の hierarchy は `copc` EVLR の中に格納され、**複数のページに分割されうる**
仕様です。上流の `CopcFile::from_reader` は「root hierarchy のオフセットが
EVLR データの先頭と一致すること」を要求していましたが、これは hierarchy が
1ページに収まる場合にしか成り立ちません。

公開データの `sofi.copc.laz`（3億6,438万点、hierarchy 約5ページ）はこの前提を
満たさず、上流のコードでは次のエラーで**開けませんでした**。

```
COPC root hierarchy offset 2029609895 does not match EVLR data offset 2029271687
```

複数ページを辿る走査処理そのもの（`read_hierarchy_page_at`、`insert_hierarchy_pages`）
は上流にすでに正しく実装されていました。誤っていたのはその手前にある前提チェック
だけだったので、「root ページが EVLR の範囲内に収まっているか」という正しい条件に
直すだけで解決しました。

この不具合は、M1 の検証を小規模な合成データ（最大20万点、hierarchy 1ページ）だけで
行っていたために最後まで見つかりませんでした。実データでしか見つからない不具合の
典型例です（[落とし穴と教訓](../pitfalls.md)参照）。経緯は
[ADR-0003 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0003-copc-crate.md) にあります。

## 修正2: `read_node` を追加した

上流の公開 API は `points(LodSelection, BoundsSelection)` という「レベル+bbox」の
空間クエリしか提供していませんでした。1ノードだけを読みたい `pcv-core` は、
これを「そのノードのレベル全体を対象に bbox で絞り込む」という形で転用するしか
なく、**1ノードの読み出しに単スレッドで88ms**かかっていました（深いレベルほど
bbox が交差するノードが増え、無駄に伸長して捨てる点が増えるため）。

COPC の hierarchy エントリは、ノード1つぶんの点データが**ファイルのどこから
どこまで連続した LAZ チャンクか**を `offset`/`byte_size` として直接持っています。
追加した `read_node(key: VoxelKey) -> Result<Vec<Point>>` はこの位置へ直接
`seek` し、そのチャンクだけを伸長します。空間クエリも bbox による絞り込みも
事後のフィルタも行いません。結果、1ノードあたりの読み出しコストは**約10分の1
（8.7ms）**になりました。

この修正は副産物として、「隣接ノードの点が1点だけ混入する」という別の不具合
（境界面の bbox 判定が両端 inclusive だったことによるもの）も一緒に解消しました。
`pcv-core` 側が持っていた対症療法のフィルタ（`point_belongs_to_key`）は不要になり、
削除されています。詳細な実測は [ADR-0007 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) を参照してください。

## いつ消せるか

`PATCH.md` に明記されている通り、上流が同等の修正・API を公開したら、
このベンダリングは外せます。ただし外す前に必ず `sofi.copc.laz` が開けることを
実データで確認する必要があります。合成データだけでは、この種の不具合は
再現しません。

## まず読むファイル

- [`vendor/copc-reader/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-reader/PATCH.md) — 何を・なぜ直したかの全文
- [`TaskSheets/ADR-0003-copc-crate.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0003-copc-crate.md) — クレート選定とこの不具合の発覚経緯
