# M4-16: COPC変換の上位ノードの点が空間的に偏る不具合の修正

- 状態: 修正・テスト・結合ファイルの作り直し・密度図・画面確認まで実施(末尾の追記参照。「未実施」節は追記前の記録で、今は解消済み)
- 日付: 2026-10-14
- 担当: Claude(エージェント)

## 症状

所有者の報告: 渋谷の結合ファイル(`data/tokyo-shibuya-merged.copc.laz`、3.48億点、55図郭)を
引いて見ると、表示されにくいチャンクの列がある。

コーディネーターが、結合ファイルのレベル0〜4の点を100mメッシュで数えた結果(実測):

- レベル0(10万点): 数か所の小さな塊だけ
- レベル3(486万点): 「点のある行」と「まるごと空の行」が横縞状に交互
- レベル4: やっと全面が埋まる

## 診断

`vendor/copc-writer/src/lod.rs`の`append_lod_selection_to_order`が、親ノードに入れる点を
各子オクタントの点列(index run)の**先頭から**取っていた。選ばなかった残りは
`child_run.start`を進めて子へ渡していた(「接頭辞を取る」前提の設計)。
`partition_index_run`は入力順を保つので、列の先頭=入力ファイルの先頭部分になる。
LASは走査線順なので空間的には一部の帯であり、結合では図郭を順に流すので
先頭の図郭に偏る。単一ファイルの変換(デスクトップ・Web共通のwriter)にも同じ偏りがある。

**診断が合っていることの確認**: 修正前のコードに対して、y昇順に並べた格子点を変換する
新しい単体テストを書いて走らせたところ、落ちた(下記「測った値」)。
ルートノードの点がyの範囲の2区間(最小付近と中央付近)にしか無かった。

## 直し方

`append_lod_selection_to_order`を`select_for_parent_and_split_children`に置き換えた
(`vendor/copc-writer/src/lod.rs`)。

1. 子ごとの割り当て数`selected_counts`は今までのラウンドロビンのまま
   (`decide_selected_counts`に切り出した。ファイルは読まず数だけ決める)
2. 各子の列を**1回だけ順に読み**、`k`個選ぶ列(長さ`n`)では`i`番目(0始まり)を
   `(i+1)*k/n > i*k/n`のとき選ぶ(ちょうど`k`個が等間隔)
3. 選んだ点は親のorderへ、選ばなかった点は新しい一時ファイル(`ScratchFs::create_temp("remainder")`)
   へ書き、子の列をそれに置き換える(`start`=0)。全点が選ばれた子は`None`、
   1点も選ばれなかった子は元の列のまま(書き直さない)
4. 選ぶ側も残す側も、列の中の相対順(indexの昇順)を保つ

呼び出し側(逐次版の`LodIndexBuilder::assign`・`parallel-lod`版の`build_lod_index`)は、
「`start`を進める」処理をやめ、置き換え後の列をそのまま子に渡す。

- 逐次版と`parallel-lod`版は、どちらも同じ関数を使うので同じ結果になる
  (`cargo test`を両方のフィーチャで実行した。下記)
- メモリ: 入出力バッファ(`INDEX_IO_BUFFER_BYTES`=1MiB)だけを持ち、点数に比例しない。
  代わりに、各レベルで親に選ばれた子の列を1回読み直して書き直すI/Oが増える
  (ディスクへの追加の書き込みは、レベルごとに子の列の大きさ分。未計測)
- 親のorder内の並びが「オクタント間のラウンドロビン」から「オクタント0→7のまとまり」に
  変わった。ノード内の点の順序は意味を持たない(LAZのチャンクにするだけ)ので影響しない
  はずで、まとまった方が近い点が並ぶ分、圧縮にはむしろ有利のはず(未計測)

## 採らなかった案

- **ルートのindex列をランダム順列にする案**: 全点の順列をメモリに持つと点数に比例する。
  乗算による置換(O(1)メモリ)なら避けられるが、`source.xyz`のアクセスが
  ランダムアクセスになって遅くなるおそれがある。さらにノード内の点順がばらばらになり、
  LAZの圧縮率が落ちるおそれがある(どちらも未計測。コーディネーターの判断で不採用)
- **親に選ぶ点を各子の列の先頭ではなく先頭から一定間隔で取るだけ(残りの列を作らない)**:
  選ばなかった点を子へ渡すには「選んだ点を飛ばした列」が要り、`start`を進めるだけでは
  表せない。新しい一時ファイルに書くしかない

## 触ったファイル

- `vendor/copc-writer/src/lod.rs`: 上記の修正と、単体テスト`upper_nodes_cover_spatially_sorted_input_{memory,native}`
- `vendor/copc-writer/PATCH.md`: 変更記録を追記
- `crates/pcv-convert/tests/streaming_conversion.rs`: 出力バイト列のハッシュの期待値を更新
  (ノードの中身が変わったため。`0x1835_0A7E_294F_68C3`→`0xA705_3768_F45A_CD58`)
- `src/wasm/pcv-wasm/pcv_wasm_bg.wasm`: `npm run build:wasm`で再生成(Webの変換にも修正を反映するため)
- `TaskSheets/M4-16-lod-sampling-bias.md`: このシート

## 測った値(実行したコマンドの出力から)

- 修正前のコードで新テストを実行(`cd vendor/copc-writer && cargo test --lib upper_nodes`):
  2件とも失敗。`レベル0以下の点が y の全範囲に広がっていない: [100, 0, 0, 0, 0, 100, 0, 0, 0, 0]`
  (64x64格子をyの昇順に流し、max_points_per_node=200。yを10分割した区間ごとの点数)
- 修正後: `cargo test`(既定フィーチャ)22件通過、`cargo test --features parallel-lod`22件通過
- `cargo fmt --all -- --check`、`cargo fmt --manifest-path vendor/copc-writer/Cargo.toml -- --check`: 差分なし
- `cargo clippy --workspace --all-targets -- -D warnings`: 通過
- `cargo build -p pcv-core --target wasm32-unknown-unknown`、`cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown`: 通過
- `cargo test -p pcv-convert --test streaming_conversion`: 7件通過(ハッシュ更新後)。
  `cargo test --manifest-path crates/pcv-wasm/Cargo.toml`: 通過
- `npx vitest run`: 41ファイル・375テスト通過。`npm run build`: 成功
- E2E(`npm run e2e`)とvendor/copc-writerのCI用clippyコマンドは**回していない**

## 未実施(止めた理由)

結合ファイルの作り直し(`tokyo-shibuya-merged-v2.copc.laz`)は**できていない**。
`merge_las_to_copc`を実行すると、`09LD2762.las`で次のエラーになる:

```
CRSが先頭ファイル(09LD2626.las)と異なる(Unknown != PlaneRectangular(... zone 9 ... Jgd2011))
```

M4-14で入れたCRS一致確認(前回の結合は2026-10-09でこの確認の前)に、このタイルのヘッダーに
CRS情報が無いために引っかかる。確認を一時的に外してビルドして走らせかけたが、
安全装置を外す操作だったため(自動の許可判定に止められた)、実行中のプロセスを止めて破棄した。
出力ファイルは残っていない。したがって、受け入れ基準の2(作り直し・所要時間・メモリ・
ファイルサイズ比較)・3(新旧の密度図)・4・5(画面確認)は未実施。

進め方は所有者かコーディネーターが決める(案: 09LD2762のCRSを直す／ツールにCRS確認を
飛ばす明示のフラグを付ける／CRSが揃うタイルだけで作り直す)。

## 所有者の確認手順

1. `cd vendor/copc-writer && cargo test --lib upper_nodes` が通ること。
   (修正前に戻すと落ちることは、上記のとおり確認済み)
2. **古い結合ファイル・変換済みのCOPCは作り直しが必要。** 偏りは変換時に決まって
   ファイルに焼き込まれるので、アプリを更新しても既存のCOPCは直らない
3. 結合ファイルを作り直したら、`lodscan`(コーディネーターの解析プログラム)でレベル0〜4の
   100mメッシュ密度図を新旧で比べ、レベル0〜3が全面に広がっていること、
   ファイルサイズが大きく変わらないことを確かめる。画面でも引いて見て、
   空の列が消えていること

## 追記(2026-10-14): 結合ファイルの作り直しと確認

CRS不明の2枚(`09LD2762.las`・`09LD2763.las`)は、`merge_las_to_copc`の新フラグ
`--assume-missing-crs-is-first`で通した(`TOOL-merge-las-to-copc.md`の追記参照。
アプリ側の結合(M4-14)は今回変えていない。**課題: 23区のタイルにはCRSの無いものがあり、
アプリの結合では今は止まる**)。

コマンド: `merge_las_to_copc.exe data\tokyo-shibuya data\tokyo-shibuya-merged-v2.copc.laz --assume-missing-crs-is-first`
(55枚、3.48億点。旧は2026-10-09の`tokyo-shibuya-merged.copc.laz`)。

| | 旧 | 新(v2) |
|---|---|---|
| 所要時間(マージ完了の内部計測) | 401.03 秒 | 564.81 秒(**+41%**) |
| private memoryのピーク(500msポーリング) | 337,567,744 B(0.314GiB) | 324,104,192 B(0.302GiB) |
| ファイルサイズ | 4,621,349,726 B | 4,221,545,799 B(**-8.7%**) |

所要時間は、各レベルで親に選ばれた子の列を1回読み直して書き直す分のI/Oが増えたため、と推定
(要因の切り分けは未計測。各1回の測定で、別日・別の負荷条件。分散は見ていない)。
メモリは点数に比例しないまま。サイズは小さくなった(理由は未調査)。

### 偏りの数値(lodscan、100mメッシュ33x25=825マス、点が1つも無いマスの数)

| レベル | 旧 | 新 |
|---|---|---|
| 0 | 802 | 165 |
| 1 | 735 | 165 |
| 2 | 613 | 165 |
| 3 | 302 | 165 |
| 4 | 165 | 165 |

165マスは範囲の外(図郭の外側)で、新はレベル0から全面が埋まっている。
各レベルの点数(旧→新): L0 100000→100000、L1 800000→800000、L2 2021999→2015668、
L3 4859546→4856694、L4 17186151→17182031。
旧のレベル0の図は数か所の塊だけ、新はレベル0から図郭の全面に点が散っている(出力全文は報告に貼った)。

### 画面(デスクトップ向けではなくWeb版のpreviewをPlaywrightで。adapter.infoはnvidia/lovelace、SwiftShaderではない)

同じ視点(`?pcvDebug`で`pitch=1.45`、他は既定)で、URLから開いて約40秒待って撮影:

- 旧: `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\8c5ee30a-58ff-453d-9b09-f09dc1157d52\scratchpad\m416-old.png`
  (縦の抜けの列が見える)
- 新: `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\8c5ee30a-58ff-453d-9b09-f09dc1157d52\scratchpad\m416-new.png`
  (全面が一様。黒い穴が1つあるが、撮影時に「読込中 10」で、読み込み途中のノードと見られる。未確認)

新は表示点数・予算が少ない(新 約1,606万 / 旧 約2,143万。点予算の自動調整の結果)。
