# pcv-convert: LAS/LAZ から COPC への変換、他形式の取り込み、結合・抽出

`crates/pcv-convert` は、生の LAS/LAZ を COPC へ変換する処理、E57/PLY/PCD の取り込み、
複数ファイルの結合、COPC から条件に合う点だけを取り出す処理を持ちます。
`pcv-core` とは別クレートに分けてあり、`pcv-core` が [規約1](../conventions.md) の対象
（wasm32 でビルドできる）であり続けるため、変換の重い処理（out-of-core の一時ファイル、
`copc-writer` への依存）はこちらに閉じ込められています。デスクトップ・Android 用で、Web 版は使いません
（Web 版は [pcv-wasm](./pcv-wasm.md) が同じ `vendor/copc-writer` を直接呼びます）。

流れとして読みたいときは、先に [変換の中身](../flows/conversion.md)・
[点の選択・断面・結合](../flows/point-cloud-tools.md)の章を見てください。この章はクレートの地図です。

[`src/lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/lib.rs) のモジュール構成が、このクレートの歴史をそのまま表しています。

```
## M4-1（スパイク。本番経路には使わない）
- point:   入力LAS/LAZの読み込みと、メモリ上で持つ点の表現
- octree:  素朴なoctree分割
- writer:  COPCファイルの組み立て

## M4-3 以降（本番の変換経路。copc-writerを使う）
- streaming:      LAS/LAZ 1ファイルの変換の本体(convert_and_timings)
- merge:          複数ファイルの結合(M4-14。アプリからも呼ぶ。L2-C でCRS無しを通す寛容モード)
- extract:        COPCから条件に合う点だけを新しいCOPCにする(L2-C。点の選択・断面)
- import:         E57/PLY/PCDの取り込み(M4-9。中間のLASは作らない)
  M4-17 で、形式が混ざった複数ファイルの結合(import/merge.rs)も加わった
- stage_timings:  段階ごとの所要時間(M4-12)
- write_metadata: 元のLASヘッダーからCopcWriteMetadataを組み立てる
- crs_override:   元ヘッダーのCRSからWKT文字列を解決する
- copc_detect:    拡張子ではなくヘッダーでCOPCかどうかを判定する
- cache:          同じファイルを二度変換しない(単一ファイル・複数ファイルの指紋)
- output_path:    変換結果の置き場所を決める
- disk_space:     変換前の空き容量チェック
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

[`src/streaming.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/streaming.rs) が実際に使われる変換の本体です。入口は `convert_and_timings`
（パスから開く版は `convert_path_and_timings`）です。当初は `copc-writer` の
一括関数（パスを渡すだけの高水準 API）を使う設計でしたが、**Android でも変換する**
という方針変更を受けて、低水準 API `write_streaming_with_cancel_and_timings` を使う形に
変わりました。理由は、Android のファイル選択が返す `content://` URI は
パス文字列ではなく `std::fs::File`（ファイルディスクリプタ）としてしか得られず、
パスを要求する一括関数には渡せないためです。低水準 API は点のイテレータを受け取るため、
デスクトップのパスも Android の `content://` も最終的に同じ `std::fs::File` として扱い、
**1本の経路に統一**しています。

LAZ の展開は `las` クレートの `laz-parallel` フィーチャ（`rayon`）で並列にしてあります（M4-7）。
1回の `fill_points` が複数の LAZ チャンクをまたがないと並列化の余地が無いため、`READ_BATCH_SIZE` を
64Ki 点から 1Mi 点に増やしました（`beer.laz`、20論理コアでの実測: 64Ki で 1.69倍、1Mi で 5.33倍。
`streaming.rs` 冒頭の表）。ノードの圧縮と LOD の分割は `vendor/copc-writer` 側で、
`parallel-compress` フィーチャのスレッドで動きます（`Cargo.toml` で有効化。
[vendor/copc-writer の章](./copc-writer.md)）。Web 版は `rayon` が使えないので、独立した
Web Worker に範囲を分担させます（[pcv-wasm の章](./pcv-wasm.md)）。

副産物として、点のイテレータを自前で回すため、読み込んだ点数を数えて
**進捗として報告できる**ようになりました（`copc-writer` 自身は進捗コールバックを
持っていません）。読み込み完了後（LOD の分割・チャンク圧縮・書き出し）は
`write_streaming_with_cancel_and_timings` の呼び出し内部で一括して行われるため、外から
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
  二度変換しないようにします。複数ファイル用の指紋（`multi_fingerprint_of_paths`）もあります
- [`output_path.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/output_path.rs) — `<元ファイル名>.copc.laz` を元ファイルの隣に、書けなければ
  アプリのキャッシュディレクトリに置きます
- [`disk_space.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/disk_space.rs) — ADR-0006 の実測（入力の約11倍の一時ディスクを使う）を根拠に、
  変換前に空き容量を確認します（Windows は `GetDiskFreeSpaceExW`、Unix 系/Android は `statvfs`）。
  この係数は ADR-0019 の前の方式での実測で、新方式では再計測していません（安全側の見積もりとして残っています）
- [`stage_timings.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/stage_timings.rs) — `copc-writer` の2つの計測構造体（読み込み側・後処理側）を
  画面に出す「変換の内訳」用の1つにまとめます

## `merge.rs`: 複数ファイルの結合

[`src/merge.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/merge.rs) は、元は開発者向けの CLI（`examples/merge_las_to_copc.rs`）専用でしたが、
M4-14 でアプリ（`src-tauri` の `start_multi_las_conversion`）からも呼ぶようになりました。新しい octree や writer は書かず、
「複数ファイルを順に読んで1本のイテレータにする」（`MultiFileLasPoints`）だけで、単一ファイルと同じ
`write_streaming_with_cancel_and_timings` に渡します。

- `summarize_headers_lenient` — アプリの既定。全ファイルのヘッダーだけを読み、点のレイアウトの一致を確認する。
  CRS が無いファイルは通して警告にする（`HeaderSummary::crs_warnings`）。CRS を持つファイル同士の食い違いは `MergeError::CrsMismatch`
- `summarize_headers` / `summarize_headers_with_options` — 厳格なモード（CLI の既定と `--assume-missing-crs-is-first`）
- CRS の比較には `pcv_core::crs::CrsId` を使う（`Crs` 列挙型は対応外の CRS を「不明」にしてしまい、
  「CRS が無い」と区別できないため。[pcv-core の章](./pcv-core.md)）
- `merge_paths_and_timings` — アプリが呼ぶ入口。COPC も `las::Reader` が LAZ として読めるので、そのまま結合できる

## `extract.rs`: 条件に合う点だけを新しい COPC にする

[`src/extract.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/extract.rs) の `extract_path_and_timings` が、`pcv_core::extract::ExtractPoints`
（条件と交わるノードだけを読むイテレータ）を `write_streaming_with_cancel_and_timings` に渡します。
0点なら出力を作らず `ExtractError::EmptySelection` です。読み側は1ノードぶんしか抱えないので、
メモリは点数に比例しません（テスト `buffer_is_bounded_by_largest_node`）。

## `raster.rs`: COPC をラスタ化する(G1)

[`src/raster.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/raster.rs) の `rasterize_path_and_timings` は、
元の COPC の**全点を1回だけ**流し読みして(`ExtractPoints::all`。1ノードずつ)格子に足し、GeoTIFF と「1セル1点」の表示用 COPC の2つを書きます。
格子の大きさはヘッダーの範囲とセルの大きさで決まり、上限(`src-tauri` の `RASTER_MAX_CELLS_DESKTOP`)を超えると**点を1つも読む前に**断ります。
途中で失敗・キャンセルしたら GeoTIFF も消します。色(RGB)のラスタは、レイヤーが色を持つときだけ作れます。

## `import/`: E57・PLY・PCD の取り込み

[`src/import/`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import) は [ADR-0008](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md) が対応すると決めた3形式の取り込みです。
M4-4 の最初の設計は「いったんプレーンな LAS に書き出す」でしたが、全点をメモリに貯めること、中間 LAS の余計な I/O が
問題で、**M4-9 で作り直しました。各形式を「1点読むたびに spill へ書く」`PointSource`（`import/point.rs`）にして、
中間 LAS は作りません**（`las_out.rs` は削除済み）。

入口は `import/mod.rs` の `convert_to_copc_and_timings`（形式は `detect_format` が拡張子から判定）で、
`import/convert.rs` の `run_import` が点を `SpillWriter` に流し、あとは LAS/LAZ と同じ `copc-writer` の経路です。
`src-tauri/src/conversion.rs` の `run_conversion_thread` から呼ばれています（アプリに配線済みです）。

| 形式 | 使用クレート | 備考 |
|---|---|---|
| [E57](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/e57.rs) | `e57` 0.11.13 | 姿勢適用・強度/色の正規化を標準で行う |
| [PLY](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/ply.rs) | 自前実装 | 候補の `ply-rs` は保守が止まっており依存も多いため見送り、自前実装にした |
| [PCD](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/pcd.rs) | `pcd-rs` 0.13.0 | binary_compressed（LZF 圧縮）にも対応 |

[`scale.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/scale.rs) は、座標の値域から LAS の scale/offset（mm 以下の精度を狙う）を
選ぶ純粋関数です。CRS は推測せず「不明」のままです。色・強度の値域の扱いは形式ごとに異なり、
各ファイル冒頭のコメントと
[ADR-0008 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md#追記2026-09-25-e57--ply--pcd--lasの実装m4-4) にあります。

### 複数ファイルの結合(M4-17): 形式が混ざっていても1つの COPC にする

`import/merge.rs` の `convert_paths_to_copc_and_timings` は、PLY・PCD・E57 を1つでも含む選択（LAS/LAZ との混在も可）を
1つの COPC にします。**全部 LAS/LAZ の選択は今までどおり `merge.rs` が受け持ちます**（分類・GPS 時刻・リターン番号を残せるため。
この経路は x, y, z, 色, 強度しか持てません）。どちらの経路を使うかは `src-tauri` の `merge_by_format` が拡張子で決めます。

流れは3段です。

1. ヘッダーの確認。全ファイルを1回ずつ開き、色の有無・申告点数（進捗の分母になる合計）・LAS/LAZ の CRS だけを読む
2. CRS の確認。LAS/LAZ の CRS が互いに食い違ったら、1点も書く前にファイル名つきのエラーにする
   （CRS が不明のファイルは「一致」とみなす。`merge.rs` と同じ）。PLY/PCD/E57 は CRS を持たない
3. `MergedSource`（`PointSource` の実装）が、ファイルをパスの昇順に1つずつ開いて点を `run_import` に渡す。
   `run_import` は単一ファイルの取り込みと同じで、`SpillWriter` へ流してから scale/offset を選ぶ

色は「どれか1つでも色があれば出力に色あり。色の無いファイルの点は灰色 `[32768, 32768, 32768]`」です。
灰色はファイルごとに `MergedSource` が入れるので、各形式の読み込み側（`ply.rs` など）は変わっていません。
LAS/LAZ を点のストリームとして読む `import/las.rs`（`LasSource`）が加わりました。

警告は戻り値の `PointMergeSummary::warnings` で返り、画面のエラーログに出ます。

- LAS/LAZ と他の形式を混ぜたとき: 「LAS/LAZ と他の形式を結合したため、LAS/LAZ の分類・GPS時刻・リターン番号などの属性は出力に含まれません」
- 出力に CRS があり、PLY/PCD/E57 も混ざるとき: 「PLY/PCD/E57 の点は LAS/LAZ と同じ座標系として結合しました」

メモリは点数に比例しません。同時に開くファイルは1つだけで、`MergedSource` が持つのはファイルの一覧だけです。
テスト `tests/import_merge_memory_is_bounded.rs` が、アロケーターでピークのヒープ量を数え、同じ点数の単一ファイルの取り込みと
ほぼ同じ（差が 5MB 未満）であることを確かめます。

Web 版も PCD・PLY・E57 を取り込めます。`crates/pcv-wasm/src/` の `pcd_import.rs`・`ply_import.rs`・`e57_import.rs` に、
それぞれの読み込みを**意図的に複製**しています
（`pcv-wasm` が別ワークスペースで、`pcv-convert` に依存すると `rayon` が wasm32 のビルドに混入するため）。
片方を直したらもう片方も直します。

## まず読むファイル

- [`crates/pcv-convert/src/streaming.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/streaming.rs) — 本番の変換経路（LAS/LAZ 1ファイル）
- [`crates/pcv-convert/src/merge.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/merge.rs)・[`extract.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/extract.rs) — 結合と抽出
- [`crates/pcv-convert/src/import/mod.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-convert/src/import/mod.rs) — E57/PLY/PCD 取り込みの入口
- [`TaskSheets/ADR-0006-conversion-strategy.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) — なぜ `copc-writer` を選んだか、実測値
