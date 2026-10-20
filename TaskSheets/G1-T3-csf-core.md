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
| 粒子は鉛直にだけ動く。格子は範囲＋余白 2 粒子 | `Cloth::new` | 2.1（布の格子） |
| IHV: 各粒子に XY で最も近い点の反転した高さ | `add_point_for_ihv` | 2.3 |
| 点の無い粒子の行ごとの埋め | `finish_ihv` | 参照実装（論文は IHV の求め方だけ） |
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

## 2. 論文・参照実装との違い（全部）

**参照実装に従った点（論文には書かれていない、または論文と違う）**

- 点の無い粒子をスキャンラインで埋める（同じ行で最も近い値のある粒子から。行に値が全く無ければ最も近い行から）。
  参照実装のスキャンラインの埋めを説明に基づいて自分で書いた。同じ距離のときは左／上を優先（参照実装の同点の扱いは未確認）
- 布の初期の高さは反転した点の最大値。ただし点を保持しないので `finish_ihv` で IHV の最大値を使う（参照実装は点群の最大高さ）
- 1ステップは「Verlet → 拘束を1回 → 衝突」の順。`rigidness` は論文では拘束の反復回数だが、
  参照実装では1回の拘束の強さを選ぶ値なので、後者に従った
- 分類は双線形補間（参照実装の `c2cdist` と同じ）
- 収束は「最大の変化 < しきい値」（参照実装は `0 < 変化 < しきい値`。変化が 0 のとき、こちらも止める）
- 斜面の後処理は、動けない粒子の隣にあって IHV の差が `hdiff` 未満、かつ布が IHV から `class_threshold_upper` 未満の
  動ける粒子を IHV に置き、そこから幅優先で広げる（参照実装の説明による）。参照実装は大きさが一定以上の動ける粒子の
  まとまりだけを処理するが、こちらは大きさで区別せず全部処理する（定数の値が分からなかったため）。
  布が IHV に近いかの基準には `class_threshold_upper` を使った（参照実装は `class_threshold`。上下に分けたので上を選んだ）
- 点が1点も無い行・布の外の点は無視する

**参照実装を確かめられなかった点（推定）— 結果に影響しうる**

- 重力 `GRAVITY = 0.2`、減衰 `DAMPING = 0.01`: 参照実装の定数を**記憶から**書いた。ソースの該当ファイルの取得では値が得られなかった（未検証）
- 拘束の強さの表: 参照実装は `rigidness` で引く表（14まで）を持つが、**値が読めなかった**。そこで
  動ける粒子が片方だけのとき `[0.3, 0.6, 1.0, 1.0...]`、両方のとき `[0.3, 0.45, 0.5, 0.5...]`（rigidness 1,2,3以上）
  とした。形は参照実装に合わせたつもりだが数値は私の選んだもので、**参照実装と同じ結果にはならない可能性がある**
- 拘束の隣は上下左右の4つ（参照実装は斜めや2つ先も持つらしい。読んだ説明が食い違った）。Gauss-Seidel（その場で更新）で、
  行優先の順に走査するので決定的

**所有者の変更**

- 分類のしきい値を上下で分けた（`−lower ≤ z − 布 ≤ upper`。Q20）。論文・参照実装は上下同じ `|d| < threshold`

**論文と参照実装が食い違う点**: 結果が変わるほどの食い違いは確認していない（ただし上の「確かめられなかった点」が原因で
見逃している可能性がある）。

**IHV の求め方**: 点は自分のセルの4隅の粒子に高さを提出し、粒子は XY で最も近い点を残す。距離が全く同じなら高い方
（反転した高さが大きい方）を残すので、点の順序に結果が依らない（テストで確認）。

## 3. メモリ

1粒子あたり、`h`・`prev`・`ihv` が各 4 B、動けるか 1 B で **13 B**。IHV を作る間だけ距離の 4 B を足して 17 B
（`finish_ihv` で捨てる）。テストで、20万点を流しても `memory_bytes()` が粒子数 × 17 のまま変わらないことを確認した。
計画の「約 12 B」より 1 B 多い（動けるかを bool で持つため）。

## 4. テスト

合成データだけ（テスト内で生成）。`cargo test -p pcv-core csf`。

| テスト | 内容 | しきい値と理由 |
|---|---|---|
| `scene_a_standard` | 60×60 m の平地（0.25 m 間隔）、10×10 m の建物（屋根 8 m、壁、下に地面なし）、植生のばらまき 600 点（1.5〜6 m 上）、地面の下 5 m の外れ値 1 点 | 再現率・適合率とも 0.98 以上（きれいなデータなので、建物の縁と外れ値の周りの分だけ 2% の余裕）。屋根と植生は全点が地表以外、建物から遠い地面は全点が地表 |
| `asymmetric_thresholds` | 布の高さに対し +0.05 は地表、+0.2 は地表以外、−0.9 は地表、−1.5 は地表以外 | 仕様（Q20）そのまま |
| `outlier_damage_is_local` | 外れ値の 6 m 以内とそれ以外で、落ちた地面の点を数える | 外れ値の外で 300 点未満 |
| `steep_preset_on_slopes` | 15 m の斜面（0°/30°/45°）＋平らな台地。各サンプルは地面の点（割合 `frac`）か 3 m 上の林冠の点 | 下の結果。30°以上・`frac`=0.1 のとき急勾配の方が適合率が +0.03 より高く、再現率が −0.05 より下がらない |
| `deterministic` | 2回実行して同じ。点の順序を逆にしても同じ | 完全一致 |
| `batches_equal_one_call` | `step(7)` を繰り返した結果と `step(最大)` の結果で布の高さ・動けるかが同じ | 完全一致 |
| `cap_refusal` | 100万個の上限に 1km×1km（400万個）→断る。文言に「解像度」「範囲」を含む | |
| `validation_and_phase_errors` | rigidness 0、解像度が NaN は拒否。`finish_ihv` の前の `step`・点が無い `finish_ihv` はエラー | |
| `memory_is_proportional_to_particles_not_points` | 上の通り | |

### 結果（実行した出力）

```
scene A standard: recall 1.0000 precision 0.9986
lost ground points: near outlier 0, elsewhere 0
```

斜面（標準 / 急勾配、再現率と適合率）:

```
ramp 0 deg,  ground fraction 0.1:   standard recall 0.9476 prec 0.7528; steep recall 0.8960 prec 0.8982
ramp 30 deg, ground fraction 0.1:   standard recall 0.5754 prec 0.1425; steep recall 0.5873 prec 0.2875
ramp 45 deg, ground fraction 0.1:   standard recall 0.5056 prec 0.1107; steep recall 0.4976 prec 0.1756
ramp 30 deg, ground fraction 0.02:  standard recall 0.2341 prec 0.0049; steep recall 0.2381 prec 0.0058
ramp 45 deg, ground fraction 0.02:  standard recall 0.2341 prec 0.0049; steep recall 0.2381 prec 0.0054
ramp 45 deg, ground fraction 0.005: standard recall 0.1714 prec 0.0009; steep recall 0.1714 prec 0.0010
```

（`frac`=0.3 のとき: 30° は標準 1.0000/1.0000・急勾配 0.9928/0.9997、45° は標準 0.9948/0.9987・急勾配 0.9851/0.9982。
このテストの 0.3 の設定は途中の実行で、最終のテストには含めていない。）

**急勾配プリセットの評価（正直に）**: 地面の点が多い（30%）斜面では標準の方が良く、急勾配は**良くなかった**。
林冠が多く地面の点が 10% の斜面では、急勾配の方が適合率が約 2 倍高く（0.14→0.29、0.11→0.18）、再現率はほぼ同じ。
地面の点が 2% 以下になると、どちらも使い物にならない（IHV が「XY で最も近い点」なので、近くの点がほとんど林冠だと、
布は林冠に乗る）。これは Q3・Q7 で決めた IHV の作り方の限界で、このコアの不具合ではない。
「急勾配の方が常によい」という主張はこの合成データでは支持されない。実データでの比較は G1-6 以降。

### 実行時間（この機械、合成データ、release）

1000×1000 粒子（0.5 m 間隔、`cargo test -p pcv-core --release csf::tests::timing -- --ignored --nocapture`）:

```
timing (convergence threshold 0.005): ihv 32.1871ms, simulation 262.2282ms for 20 iterations (converged true)
timing (convergence threshold 0):     ihv 22.72ms, simulation 5.4397915s for 500 iterations (converged false)
```

1 粒子ごとの点がある、なめらかな波形の地面。1 ステップは約 11 ms（100万粒子）。収束まで 20 ステップで終わるのは
このデータが単純なため（実データでは多くかかる見込み。未検証）。500 ステップ強制で 5.4 秒。
単純な比例で渋谷（3,070万粒子）に当てはめると 500 ステップで約 170 秒（推定。キャッシュの効き方が変わるので未検証）。
単スレッドで、`rayon` は使っていない。wasm での時間は測っていない。

## 5. 未検証

- **実データでの精度**（G1-6 まで未検証）。テストは合成データだけで、実際の航空レーザーや車載の点群は試していない
- 重力・減衰・拘束の強さの表の数値が参照実装と一致するか（上の通り記憶・推定）。参照実装の CLI と同じ入力を
  比べる検証はしていない
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
