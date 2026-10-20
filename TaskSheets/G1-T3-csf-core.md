# G1-5 (T3): CSF の中核（`crates/pcv-core/src/csf.rs`）

- 日付: 2026-10-21
- 計画: `TaskSheets/G1-raster-and-dtm.md` 2.2 節、9.3 節、12 節（Q3・Q7・Q20）
- 範囲: 純粋な Rust のみ。ファイルの読み込み・UI・Tauri・wasm バインディングは含まない

## 1. 実装したもの

`Cloth`（布）と `CsfParams`（パラメータ）。点は一切保持しない（流し読み）。呼び出しの順序:

1. `Cloth::new(extent, params, max_particles)` — 粒子数が上限を超えたら日本語の文言で断る
   （「解像度を粗くするか、先に範囲を切り出してください」）
2. 1回目の流し読み: `add_point_for_ihv(x, y, z)` を全点に → `finish_ihv()`
3. `step(max_iterations)` を繰り返す（Worker がバッチごとにキャンセルできる）。`finished` になるまで
4. 2回目の流し読み: `is_ground(x, y, z)`。ラスタ化には `height_at(x, y)`

### アルゴリズム（論文 Zhang et al. 2016, Remote Sensing 8(6):501 の節との対応）

| 処理 | 場所 | 論文の節 |
|---|---|---|
| 高さの反転 `z' = -z` | `add_point_for_ihv` | 2.1 |
| 粒子は鉛直にだけ動く。格子は範囲＋余白 2 粒子（`floor(幅/解像度) + 4`）| `Cloth::new` | 2.1（布の格子） |
| IHV: 各粒子に XY で最も近い点の反転した高さ（点は一番近い粒子にだけ配る）| `add_point_for_ihv` | 2.3 |
| 点の無い粒子の埋め（右→左→下→上→幅優先）| `finish_ihv` | 参照実装（論文は IHV の求め方だけ） |
| 重力による Verlet 変位 | `one_step` | 2.2 式 (1)(2) |
| 内部の拘束（隣との高さの引き合い）、`rigidness` | `satisfy_constraints` | 2.2 式 (3) |
| 衝突: IHV 以下に来たら IHV に置いて動けなくする | `one_step` | 2.3 |
| 収束判定 | `step` | 2.3 |
| 斜面の後処理 | `slope_post_process` | 2.4 |
| 布までの距離で分類（双線形補間） | `height_at`・`is_ground` | 2.5 |

### パラメータの意味

| 名前 | 意味 | 標準 | 急勾配 |
|---|---|---|---|
| `cloth_resolution` | 粒子の間隔（m） | 0.5 | 0.5 |
| `rigidness` | 布の硬さ（大きいほど硬い） | 3 | 1 |
| `time_step` | Verlet の時間刻み（1 ステップの落下量は time_step² に比例） | 0.65 | 0.65 |
| `class_threshold_upper` | 布より上にこの距離まで地表 | 0.1 | 0.1 |
| `class_threshold_lower` | 布より下にこの距離まで地表 | 1.0 | 1.0 |
| `iterations` | 最大ステップ数 | 500 | 1500 |
| `slope_smooth` | 斜面の後処理 | オン | オン |
| `hdiff` | 後処理で、隣の動けない粒子との IHV の差がこれ未満なら寄せる | 0.3 | 0.3 |
| `convergence_threshold`（追加） | 1 ステップの最大の高さの変化がこれ未満なら止める | 0.005 | 0.005 |

`convergence_threshold` は計画の表に無い追加。参照実装は `class_threshold / 100` を使っており、
上下を分けたので基準が曖昧になるため独立のパラメータにした。0.005 は 0.5 / 100 の値。

## 2. 論文・参照実装との照合

参照実装（jianboqi/CSF の master、`src/CSF.cpp`・`Particle.h`・`Particle.cpp`・`Cloth.cpp`・`Rasterization.cpp`・`c2cdist.cpp`）の
ソースを**2026-10-21 に読んで照合した**（コーディネーターが取得した `Particle.h` の表も使った）。
最初の版は定数を記憶と説明文から書いていたため、次の点を直した（`fix` コミット）。

| 項目 | 最初の版 | 参照実装に合わせた版 |
|---|---|---|
| `rigidness` の強さ | 私が選んだ値の表 | `singleMove1`・`doubleMove1`（`rigidness` で直接引く 15 個の表。15 以上は 1 / 0.5） |
| 拘束の隣 | 上下左右の 4 つ | 16 個（距離 1 の 8 つ＋距離 2 の 8 つ）。リストの順序も参照実装の作り方（x が外側、y が内側のループ、距離 1 を先に）から導いた固定の表 |
| 重力の変位 | 1 ステップ `0.2·dt²` | `0.2·dt⁴`（加速度に `dt²` を掛け、Verlet でさらに `dt²` を掛ける。`CSF.cpp` の `addForce` と `Particle::timeStep`） |
| 斜面の後処理 | 動ける粒子と IHV の距離を `class_threshold_upper` で判定。全部の動ける粒子が対象 | 下の通り |
| IHV | 点を 4 隅の粒子に配る | 点を一番近い粒子（`int(d/step + 0.5)`、格子の端に丸める）にだけ配る |
| 点の無い粒子の埋め | 同じ行で最も近い粒子 | 右へ走査して最初に見つかったもの→左→ y が小さい方→ y が大きい方→（全部空なら）16 近傍の幅優先探索。**最も近いものではなく、方向の順で最初に見つかったもの** |
| 布の大きさ | `ceil(幅/解像度) + 1 + 4` | `floor(幅/解像度) + 4` |
| 布の初期の高さ | IHV の最大値 | 反転した全点の最大値 + 0.05 |
| 衝突 | `h <= IHV` | `h < IHV`（等しいときは動けるまま） |

斜面の後処理（`movableFilter`・`findUnmovablePoint`・`handle_slop_connected`）の最終版:

- 動ける粒子を上下左右の連結成分に分け、**51 粒子以上の成分だけ**処理する（`MAX_PARTICLE_FOR_POSTPROCESSIN` = 50）
- 成分の探索は x が外側・y が内側の順、成分内の幅優先は左・右・y-1・y+1 の順（結果が順序に依存するため）
- 種: 動けない隣があり、IHV の差が `hdiff`（参照実装の `smoothThreshold` = 0.3）未満の粒子を IHV に置いて動けなくする
- 広げる: 種から幅優先で、同じ成分の隣のうち IHV の差が `hdiff` 未満のものを IHV に置く
- **コーディネーターの指示と食い違う点**: 指示は「`heightThreshold` = 0.3（`CSF.cpp` が 0.3 を渡す）」だったが、
  `CSF.cpp` の `Cloth cloth(origin_pos, width, height, res, res, 0.3, 9999, rigidness, time_step)` を読むと、
  0.3 は 1 つ目の引数 `smoothThreshold`（IHV の差の判定）で、`heightThreshold` には **9999** が渡される。
  したがって高さの判定は実質ない。ソースのとおり `SLOPE_HEIGHT_THRESHOLD = 9999` を置いた。`hdiff` は `smoothThreshold` に当たる

**参照実装との違いで残るもの**

- 点が同じ距離で並んだとき、参照実装は先に来た点を残す。こちらは反転した高さが高い方を残す（点の順序に結果が依らないようにするため）
- 収束: 参照実装は `maxDiff != 0 かつ maxDiff < 0.005` で止まる。こちらは `maxDiff < しきい値`（0 も含む）で止まる。
  `maxDiff == 0` は動ける粒子がもう動かないことなので、結果は変わらない。しきい値は `convergence_threshold`
- 参照実装は OpenMP で並列にできる（並列だと in-place の更新順が不定になる）。こちらは単一スレッドで、粒子の番号順
- 範囲の外の点は、参照実装と同じく格子の端に丸める（以前は無視していた）
- 分類: 参照実装は `|d| < class_threshold`（上下同じ）。こちらは所有者の変更で `−lower ≤ d ≤ upper`（Q20）。双線形補間は同じ
- 参照実装は倍精度、こちらは布の高さを `f32`

**照合していないもの**: 参照実装と同じ入力で出力を比べる検証はしていない（参照実装を動かしていない）。ソースを読んで合わせたのみ。
論文との食い違いで結果が変わるものは、上の表のとおり参照実装に合わせた。論文は「`rigidness` を拘束の反復回数」とするが、
参照実装は表で強さを決める（表は「0.3 の移動を `rigidness` 回繰り返した閉じた形」。`Particle.h` のコメントによる）。

**IHV の求め方**: 点は一番近い粒子に高さを提出し、粒子は XY で最も近い点を残す（論文 2.3、参照実装 `RasterTerrian`）。

## 3. メモリ

1粒子あたり、`h`・`prev`・`ihv` が各 4 B、動けるか 1 B で **13 B**。IHV を作る間だけ距離の 4 B を足して 17 B
（`finish_ihv` で捨てる）。斜面の後処理の間だけ、`visited`・`queued`（各 1 B）と成分の添字（成分の大きさ × 8 B）が一時的に要る。
テストで、20万点を流しても `memory_bytes()` が粒子数 × 17 のまま変わらないことを確認した。数字は計算値で、プロセスのメモリを測ったものではない。

## 4. テスト

合成データだけ（テスト内で生成）。`cargo test -p pcv-core csf`。

| テスト | 内容 | しきい値と理由 |
|---|---|---|
| `scene_a_standard` | 60×60 m の平地（0.25 m 間隔）、10×10 m の建物（屋根 8 m、壁、下に地面なし）、植生のばらまき 600 点（1.5〜6 m 上）、地面の下 5 m の外れ値 1 点 | 再現率・適合率とも 0.98 以上（きれいなデータなので、建物の縁と外れ値の周りの分だけ 2% の余裕）。屋根と植生は全点が地表以外、建物から遠い地面は全点が地表 |
| `asymmetric_thresholds` | 布の高さに対し +0.05 は地表、+0.2 は地表以外、−0.9 は地表、−1.5 は地表以外 | 仕様（Q20）そのまま |
| `outlier_damage_is_local` | 外れ値の 6 m 以内とそれ以外で、落ちた地面の点を数える | 外れ値の外で 300 点未満 |
| `steep_preset_on_slopes` | 15 m の斜面（0°/30°/45°）＋平らな台地。各サンプルは地面の点（割合 `frac`）か 3 m 上の林冠の点 | 30°以上・`frac`=0.1 のとき、急勾配の方が再現率が 0.1 より高く、適合率が 0.05 より下がらない |
| `deterministic` | 2回実行して同じ。点の順序を逆にしても同じ | 完全一致 |
| `batches_equal_one_call` | `step(7)` を繰り返した結果と `step(最大)` の結果で布の高さ・動けるかが同じ | 完全一致 |
| `cap_refusal` | 100万個の上限に 1km×1km（400万個）→断る。文言に「解像度」「範囲」を含む | |
| `validation_and_phase_errors` | rigidness 0、解像度が NaN は拒否。`finish_ihv` の前の `step`・点が無い `finish_ihv` はエラー | |
| `memory_is_proportional_to_particles_not_points` | 上の通り | |

しきい値は参照実装に合わせたあと、急勾配の比較だけを書き換えた（最初の版は適合率の差、参照実装に合わせた版は再現率の差。
挙動が変わったため。下の表）。他のしきい値は変えていない。

### 結果（参照実装に合わせた版の、実行した出力）

```
scene A standard: recall 1.0000 precision 0.9971
lost ground points: near outlier 0, elsewhere 0
```

斜面（標準 / 急勾配、再現率と適合率）:

```
ramp 0 deg,  ground fraction 0.1:   standard recall 1.0000 prec 1.0000; steep recall 1.0000 prec 1.0000
ramp 30 deg, ground fraction 0.1:   standard recall 0.6087 prec 1.0000; steep recall 0.7976 prec 1.0000
ramp 45 deg, ground fraction 0.1:   standard recall 0.2833 prec 0.8729; steep recall 0.4865 prec 0.8658
ramp 30 deg, ground fraction 0.3:   standard recall 0.5786 prec 1.0000; steep recall 0.8204 prec 1.0000
ramp 45 deg, ground fraction 0.3:   standard recall 0.1714 prec 1.0000; steep recall 0.4832 prec 1.0000
ramp 30 deg, ground fraction 0.02:  standard recall 0.1786 prec 0.0036; steep recall 0.2262 prec 0.0046
ramp 45 deg, ground fraction 0.02:  standard recall 0.3452 prec 0.2710; steep recall 0.2738 prec 0.0085
ramp 45 deg, ground fraction 0.005: standard recall 0.1571 prec 0.0013; steep recall 0.2000 prec 0.0014
```

最初の版（記憶から書いた定数）では、地面の点が 30% の斜面で標準の方が良く、急勾配は良くなかった。
参照実装に合わせたあとは逆になり、**急勾配プリセットは斜面で再現率が大きく上がる**（30° で 0.58→0.82、45° で 0.17→0.48、
適合率は同じ）。標準の硬い布は斜面で地面を取りこぼす。どちらの版でも、地面の点が 2% 以下になると使い物にならない
（IHV が「XY で最も近い点」なので、近くの点がほとんど林冠だと布は林冠に乗る。Q3・Q7 の IHV の作り方の限界）。
45°でも急勾配の再現率は 0.48 で、満足できる値ではない。実データでの評価は G1-6 以降。

### 実行時間（この機械、合成データ、release）

1000×1000 粒子（0.5 m 間隔、`cargo test -p pcv-core --release csf::tests::timing -- --ignored --nocapture`）。
16 近傍の拘束になったので、最初の版より遅い:

```
timing (convergence threshold 0.005): ihv 11.9348ms, simulation 1.3362146s for 28 iterations (converged true)
timing (convergence threshold 0):     ihv 12.465ms, simulation 18.9999256s for 500 iterations (converged false)
```

1 ステップは約 38 ms（100万粒子。最初の版は約 11 ms）。500 ステップ強制で 19.0 秒。収束まで 28 ステップで終わるのは
このデータが単純なため（実データではもっとかかる見込み。未検証）。単純な比例で渋谷（3,070万粒子）に当てはめると
500 ステップで約 580 秒（推定。キャッシュの効き方が変わるので未検証）。単スレッド、`rayon` なし。wasm での時間は測っていない。
この数字は、ほとんどの粒子が動けなくなったあとも全粒子を走査する実装のもの。動けない同士の組を飛ばす最適化は未実施。

## 5. 未検証

- **実データでの精度**（G1-6 まで未検証）。テストは合成データだけで、実際の航空レーザーや車載の点群は試していない
- 参照実装と同じ入力での出力の比較（参照実装を動かしていない。ソースを読んで合わせただけ）
- 16 近傍の順序は、参照実装のコンストラクタのループから私が導いた固定の表。ソースの読み違いがあれば順序が違う
- wasm での実行時間、数千万粒子でのメモリ使用量（`memory_bytes()` は計算値）
- 急勾配プリセットの効果は実データで未確認

## 6. 触ったファイル

- `crates/pcv-core/src/csf.rs`（新規）
- `crates/pcv-core/src/lib.rs`（`pub mod csf;` の1行）
- `TaskSheets/G1-T3-csf-core.md`（このファイル）

## 7. 所有者が確かめる手順

```
cargo test -p pcv-core csf -- --nocapture
cargo test -p pcv-core --release csf::tests::timing -- --ignored --nocapture
cargo clippy -p pcv-core --all-targets
cargo build -p pcv-core --target wasm32-unknown-unknown
```
