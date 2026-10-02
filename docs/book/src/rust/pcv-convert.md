# pcv-convert: LAS/LAZ から COPC への変換、他形式の取り込み

`crates/pcv-convert` は生の LAS/LAZ を COPC へ変換する処理と、E57/PLY/PCD を
LAS 経由で取り込む処理を持ちます。`pcv-core` とは別クレートに分けてあり、
`pcv-core` が [規約1](../conventions.md) の対象（wasm32 でビルドできる）であり続けるため、
変換の重い処理（out-of-core の一時ファイル、`copc-writer` への依存）はこちらに
閉じ込められています。

[`src/lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/lib.rs) のモジュール構成が、このクレートの歴史をそのまま表しています。

```
## M4-1（スパイク。本番経路には使わない）
- point:   入力LAS/LAZの読み込みと、メモリ上で持つ点の表現
- octree:  素朴なoctree分割
- writer:  COPCファイルの組み立て
- import:  M4-4。E57/PLY/PCD → LAS のインポータ(独立した経路)

## M4-3（本番の変換経路。copc-writerを使う）
- streaming:    copc-writerを呼ぶ本体
- write_metadata: 元のLASヘッダーからCopcWriteMetadataを組み立てる
- crs_override: 元ヘッダーのCRSからWKT文字列を解決する
- copc_detect:  拡張子ではなくヘッダーでCOPCかどうかを判定する
- cache:        同じファイルを二度変換しない
- output_path:  変換結果の置き場所を決める
- disk_space:   変換前の空き容量チェック
```

## なぜ2つの実装があるのか

[M4-1](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M4-import-and-conversion.md) は「自前実装すべきか、既存のツールを使うべきかを実測で決める」ための
スパイクでした。`point.rs`/`octree.rs`/`writer.rs` はこのスパイクの素朴な実装
（全点をメモリに読み込み、ストライド抽出で間引きながら8分木に分割する）です。
**本番の変換経路には使われていません**が、計測の記録として、また「素朴にやると
どうなるか」の参照として残されています。

実測の結果、素朴な実装はピークメモリが点数にほぼ比例する（約62バイト/点）ため、
所有者の実データ（`sofi.copc.laz`、3.64億点）では約22GBになると見積もられ、
採用されませんでした。代わりに [ADR-0003](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0003-copc-crate.md) で選定した `copc-core`/`copc-reader`
の姉妹クレートである `copc-writer`（out-of-core 実装）を使うことが
[ADR-0006](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) で決まりました。実測の詳細と判断の根拠は ADR-0006 を参照してください。

## `streaming.rs`: 本番の変換経路

[`src/streaming.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/streaming.rs) が実際に使われる変換の本体です。当初は `copc-writer` の
一括関数（パスを渡すだけの高水準 API）を使う設計でしたが、**Android でも変換する**
という方針変更を受けて、低水準 API `write_streaming_with_cancel` を使う形に
変わりました。理由は、Android のファイル選択が返す `content://` URI は
パス文字列ではなく `std::fs::File`（ファイルディスクリプタ）としてしか得られず、
パスを要求する一括関数には渡せないためです。低水準 API は `R: Read + Seek` から
作った点のイテレータを受け取るため、デスクトップのパスも Android の
`content://` も最終的に同じ `std::fs::File` として扱い、**1本の経路に統一**しています。

副産物として、点のイテレータを自前で回すため、読み込んだ点数を数えて
**進捗として報告できる**ようになりました（`copc-writer` 自身は進捗コールバックを
持っていません）。読み込み完了後（octree 構築・チャンク圧縮・書き出し）は
`write_streaming_with_cancel` の呼び出し内部で一括して行われるため、外から
フックできず、進捗は「段階名」だけになります。

キャンセルは `copc_core::CancelCheck` トレイトで最初から対応されており、
別プロセスは起動せず、同じプロセス内の別スレッドで `Arc<AtomicBool>` を
共有する `AtomicCancel` で止めます（Android はアプリごとにサンドボックスされて
おり、自分自身を別プロセスで起動するのが一般的でないため、この方式が
デスクトップ・Android 共通で成立します）。

### 周辺のモジュール

- [`write_metadata.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/write_metadata.rs) — `CopcWriteMetadata` の組み立て。低水準 API への切り替えに伴い、
  元ファイルの任意の VLR/EVLR のパススルーは行われなくなりました（本アプリが
  使う属性は xyz・強度・分類・RGB の4つだけなので実害無しと判断されています）
- [`crs_override.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/crs_override.rs) — CRS（WKT）の解決。`copc-writer` はソースに WKT の VLR が無い
  （GeoTIFF キーだけの）入力を `crs_wkt_override` 無しでは変換自体を拒否するため、
  `pcv-core::crs`（平面直角座標系19系・UTM）が対応する系なら検証済みのパラメータ
  から WKT を組み立てます。対応外の系は CRS が失われることを許容します
- [`copc_detect.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/copc_detect.rs) — 拡張子ではなく、COPC info VLR の有無でヘッダーから判定します
- [`cache.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/cache.rs) — 変換結果の隣に指紋（サイズ・更新日時）のサイドカーを置き、同じファイルを
  二度変換しないようにします
- [`output_path.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/output_path.rs) — `<元ファイル名>.copc.laz` を元ファイルの隣に、書けなければ
  アプリのキャッシュディレクトリに置きます
- [`disk_space.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/disk_space.rs) — ADR-0006 の実測（入力の約11倍の一時ディスクを使う）を根拠に、
  変換前に空き容量を確認します（Windows は `GetDiskFreeSpaceExW`、Unix 系/Android は `statvfs`）

## `import/`: E57・PLY・PCD の取り込み

[`src/import/`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import) は [ADR-0008](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md) が対応すると決めた3形式の取り込みです。
`copc-writer` が入力に取れるのは LAS/LAZ だけなので、**E57/PLY/PCD はいったん
プレーンな LAS に書き出し、既存の LAS/LAZ → COPC 経路にそのまま乗せる**設計です。

| 形式 | 使用クレート | 備考 |
|---|---|---|
| [E57](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/e57.rs) | `e57` 0.11.13 | 姿勢適用・強度/色の正規化を標準で行う |
| [PLY](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/ply.rs) | 自前実装 | 候補の `ply-rs` は保守が止まっており依存も多いため見送り、自前実装にした |
| [PCD](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/pcd.rs) | `pcd-rs` 0.13.0 | binary_compressed（LZF 圧縮）にも対応 |

[`scale.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/scale.rs) は、座標の値域から LAS の scale/offset（mm 以下の精度を狙う）を
選ぶ純粋関数です。[`las_out.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/las_out.rs) が共通の点群表現からプレーンな LAS を書き出します。

E57/PLY/PCD は CRS の概念を持たない、または値域メタデータを持たないことが多いため、
色・強度の値域の扱いは形式ごとに異なります。詳細は各ファイル冒頭のコメントと
[ADR-0008 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md#追記2026-09-25-e57--ply--pcd--lasの実装m4-4) を参照してください。

**このインポータはアプリへの配線（UI からファイルを選んで取り込む導線）を
持っていません。** 「E57/PLY/PCD → LAS の変換」の実装と検証までが範囲で、
アプリへの配線は別タスクとして残っています。

## まず読むファイル

- [`crates/pcv-convert/src/streaming.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/streaming.rs) — 本番の変換経路
- [`crates/pcv-convert/src/import/mod.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/mod.rs) — E57/PLY/PCD 取り込みの入口
- [`TaskSheets/ADR-0006-conversion-strategy.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) — なぜ `copc-writer` を選んだか、実測値
