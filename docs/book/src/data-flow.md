# データの流れ

## COPC とは何か

[COPC](https://copc.io/)（Cloud Optimized Point Cloud）は、LAZ（圧縮 LAS）の内部に
octree を埋め込んだファイル形式です。ふつうの LAZ として読むこともできますが、
`copc` という EVLR（拡張可変長レコード）に、点群を空間分割した**ノードの位置情報**
（hierarchy）を持っています。

このアプリが COPC を内部形式に選んだ理由は [ADR-0001](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0001-architecture.md) にあります。要点だけ書くと、

- HTTP Range リクエストによる部分取得を前提に設計されている → サーバーロジック無しで Web 版が成立する
- ファイルの中に octree が**すでに入っている** → 開く処理は「hierarchy を読む」だけで済み、
  実行時に octree を構築する必要がない

実際、`sofi.copc.laz`（3億6,438万点、2.03 GB）は **13 MB のメモリ・32 ms** で開けることを
実測しています（[M1 タスクシート](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M1-point-rendering.md)の「構成の妥当性」節）。開く時間とメモリ使用量がファイルサイズに
ほぼ比例しないことが、この構成の存在理由そのものです。

コストが消えたわけではなく、**生の LAS/LAZ を COPC に変換する側に移動しています**。
変換については [pcv-convert の章](./rust/pcv-convert.md)を参照してください。

## hierarchy とノード

COPC の hierarchy は、点群を空間分割した「ノード」の一覧です。ノードは
`(level, x, y, z)` の4つの整数で識別します（`level` は octree の深さ、`x`/`y`/`z`
はそのレベルでの位置）。`pcv-core` では `NodeKey` 構造体がこれを表し、
`"{level}-{x}-{y}-{z}"`（例: `0-0-0-0`）という文字列に変換できます。

```rust
// crates/pcv-core/src/copc.rs
pub struct NodeKey {
    pub level: i32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
}
```

この文字列1本が、`pcv://` の URL に乗る唯一のセグメントです。`convertFileSrc`
（Tauri のカスタムプロトコル用ヘルパー）がパス全体を1セグメントとして
`encodeURIComponent` するため、複数セグメントのパス（`/node/<key>` のような形）は
使えないという制約があり、それに合わせてこの1文字列形式を選びました
（[M1 タスクシート](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M1-point-rendering.md) M1-2 の「M0 で判明している落とし穴」）。

hierarchy 全体は `Hierarchy` 型（`BTreeMap<NodeKey, HierarchyNode>`）として保持され、
各ノードは点数と空間的な境界（`bounds_min`/`bounds_max`）を持ちます。この境界は
レンダラが画面空間誤差を計算する際の入力になります（[renderer の章](./frontend/renderer.md)）。

## ノードのバイナリ形式

Rust からレンダラへノードの点データを渡す唯一の重いインターフェースです。
ヘッダ32バイト + 点ごと20バイトの固定長レイアウトで、**GPU の頂点バッファに
そのまま流し込める形**にしてあります（[`crates/pcv-core/src/node_format.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/node_format.rs)）。

```text
[ヘッダ 32 bytes]
  u32   magic        "PCVN"
  u32   version      1
  u32   point_count
  u32   stride       20
  f32   origin_x     ノードローカル座標の原点（世界座標をf32に丸めた値）
  f32   origin_y
  f32   origin_z
  u32   flags        どの属性が有効か（色・強度・分類）

[点配列 point_count × 20 bytes]
  f32 x3   position       ノード原点からの相対座標
  u8  x4   color RGBA
  u16      intensity
  u8       classification
  u8       _padding
```

**なぜノードローカル相対座標にするのか**: COPC の座標は f64 の世界座標で、実測データは
UTM 系などで `X = 500000.123` のような大きな値を取ります。これを素朴に f32 に落とすと
仮数部が足りず、mm〜cm 単位の精度が消えて点群がグリッド状にガタつきます。そこで
ノードごとに原点を持たせ、点はその原点からの相対座標を f32 で持ちます。原点はシェーダの
uniform として渡され、ビュー行列側で吸収されます。WebGPU に f64 が無いため、絶対座標を
GPU に渡すことは一度もありません。

この形式は `magic` と `version` を持つため、将来メッシュ用の形式
（`"PCVM"`）を足すことができます（[ROADMAP.md](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ROADMAP.md) の DTM/TIN 構想）。

フロント側のパーサは [`src/datasource/node-format.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/node-format.ts) にあり、
`magic`/`version`/バイト長を検証してから読み返します。**形式を変えるときは
`node_format.rs` と `node-format.ts` を同じコミットで直す必要があります。**

## `pcv://` プロトコル（Tauri）

デスクトップ・Android では、ノードのバイナリは `pcv://` というカスタムプロトコルで
配信されます。`invoke`（Tauri の通常の IPC）ではなくこちらを使う理由は
[規約4](./conventions.md#規約4-大きいデータは-pcv-カスタムプロトコルで運ぶ) を参照してください。

```
フロント: fetch(convertFileSrc("0-0-0-0", "pcv"))
   ↓
src-tauri: register_asynchronous_uri_scheme_protocol のハンドラ
   ↓
tauri::async_runtime::spawn_blocking でブロッキングスレッドへ
   ↓
CopcPool（独立したCopcFileを複数本保持）から1本借りる
   ↓
file.read_node(key) でそのノードのLAZチャンクだけを伸長
   ↓
NodeBuffer(上記バイナリ形式) をレスポンスボディとして返す
```

当初は `register_uri_scheme_protocol`（**同期版**）を使っており、ノード読み出し
（ディスク I/O + LAZ 伸長）が Rust のメインスレッドで直列化していました。
非同期ハンドラへの切り替えと、`CopcFile` を複数本プールする `CopcPool` の導入を
セットで行うことで、並行数8で改修前の4〜10倍のスループットを実測しています。
詳細は [ADR-0007](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) を参照してください（この ADR はもう1つ、
「1ノードの読み方自体が遅かった」という、並行化より効いた教訓も記録しています）。

## Web Worker 経路（Web）

Web 版には `pcv://` も `invoke` もありません。[ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md) の設計により、
COPC の読み込みはすべて専用の Web Worker（[`src/datasource/copc.worker.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/copc.worker.ts)）の中で行われます。

```
メインスレッド                         Worker
useCopcViewer.ts                      copc.worker.ts
  │  postMessage(open/readNode)          │
  ├──────────────────────────────────────▶
  │                                      pcv-wasm (WasmCopcFile) が
  │                                      FileRangeReader / HttpRangeReader
  │                                      経由でRead+Seekを実行
  │  postMessage(結果, ArrayBuffer)       │
  ◀──────────────────────────────────────┤
```

`FileReaderSync`（ローカルファイルの範囲読み）と、同期モードの `XMLHttpRequest`
（URL の HTTP Range 読み）はどちらも Web Worker 専用の API です。`pcv-core` の
`CopcFile<R>` は `Read + Seek` という同期トレイトの上に組んであるため、この同期 I/O が
使える Worker の中でなければ動かせません。`pcv-core` 自体は `R` が何であるかを知らず
（規約1）、`crates/pcv-wasm` がこの2種類の `Read + Seek` 実装を提供します。

URL を開く場合は、サーバーが CORS と HTTP Range の両方に対応している必要があります。
対応していなければ、黙って全体取得にフォールバックするのではなく、最初の Range
プローブの時点でエラーにします（「ファイルサイズに関わらず開く時間とメモリが
一定」という COPC アーキテクチャの主張を、Web 版だけが裏切らないようにするためです）。

## まず読むファイル

- [`crates/pcv-core/src/copc.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/copc.rs) — `NodeKey`・`Hierarchy`・`CopcFile`
- [`crates/pcv-core/src/node_format.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-core/src/node_format.rs) — ノードのバイナリ形式
- [`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) — `pcv://` の並行化と、本当のボトルネック
