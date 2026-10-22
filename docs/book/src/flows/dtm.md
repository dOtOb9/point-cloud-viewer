# DTM（地表の分類と地形のモデル）

この章は「処理の流れ（入口つき）」の1つです。DTM ツール（G1-T15）は、選んだ点群のレイヤーの地表を CSF（布シミュレーション）で分類し、

- 地表を分類 2 にした **新しいレイヤー**（COPC。[ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md) の「選んだレイヤーから新しいレイヤーを作る」）
- 地表の点から作った TIN（三角形の網）を格子に読んだ **GeoTIFF**、TIN そのままの **LandXML**（設定で片方か両方）

を作ります。計画は `TaskSheets/G1-raster-and-dtm.md`、実装の記録は `TaskSheets/G1-T15-dtm.md` です。

**この章の 4 節（メモリの表）は、いまの設計の問題を見るためのものです。** 範囲全体の TIN をメモリに持つ作りで、上限も推定の値です（5 節）。

## 1. 何をするか

| 段階 | 中身 | 読む点 |
|---|---|---|
| 読み1 | 全ノードの全点を布に落とす（各粒子の真下の最も低い点を覚える。`Cloth::add_point_for_ihv`） | 全点を1回 |
| 布のシミュレーション | 布を上から落とし、点に当たったところで止める（標準 500 回、急勾配 1,500 回）。点は読まない | なし |
| 読み2 | 全点を「布から近い＝地表」かで分類し、新しいレイヤーへ流す。同時に、地表の点のうち DTM の各セルの中心に最も近い1点を覚える（代表点） | 全点をもう1回 |
| TIN | 代表点（地表のあるセルごとに1点）で Delaunay の三角形の網を作る（クレート `spade`）。建物の下のように地表の無い所は三角形が跨ぐ | なし |
| 書き出し | GeoTIFF: 各セルの中心の高さを TIN から読む。LandXML: TIN の頂点と三角形を書く | なし |

分類の決まり（所有者の回答 Q7）: CSF が地表と判定 → 2。元が 2 なのに地表でない → 1（未分類）。それ以外は元の分類のまま（建物は建物のまま）。

## 2. 入口

| 操作 | 最初に呼ばれるもの |
|---|---|
| ツールバーの「DTM」 | `src/ui/toolbar/buttons/DtmButton.tsx` → `src/ui/shell/AppShell.tsx` が `DtmDialog` を出す |
| ダイアログの「作る」 | `src/ui/tools/DtmDialog.tsx` の `confirm` → `dtmRequestFor`（`src/app/dtm.ts`）→ **`makeDtm(viewer.toolContext, layer.id, request)`**（`src/app/point-cloud-tools.ts`） |
| レイヤー情報の「保存」（デスクトップ） | `src/ui/layers/DtmInfoSection.tsx` → `saveDtmFile`（`src/app/point-cloud-tools.ts`） |

Rust の本体は **`crates/pcv-core/src/dtm.rs`** の `DtmJob`（デスクトップと Web で同じ）。それを呼ぶ外側が2つあります。

| | ファイル | 関数 |
|---|---|---|
| デスクトップ・Android | `crates/pcv-convert/src/dtm.rs` | `dtm_path_desktop` → `dtm_path` → `dtm_inner` |
| Web | `crates/pcv-wasm/src/dtm.rs` | `WasmDtm::new` / `advance` / `finish` / `geotiff` / `landxml`（Worker の `runDtm` が呼ぶ） |

## 3. 流れ

### 3-A. 画面から Rust まで

1. `DtmDialog.tsx` — 布の解像度などの CSF の値とセルの大きさを **表示単位（m / ft）** で持つ。`confirm` が `dtmRequestFor` を呼ぶ。
2. `src/app/dtm.ts` `dtmRequestFor` — 表示単位 → m → **ファイルの単位** に換算する（CSF の換算は `src/app/csf-params.ts` の `csfParamsInFileUnits`。水平は布の間隔、鉛直はしきい値など）。出力形式は設定（`DtmOutputSetting`）から。
3. `src/app/point-cloud-tools.ts` `makeDtm` — 他のツールと同じ `runTool`（[点群ツールの章](./point-cloud-tools.md)の 3-A）に、`source` が `WebSource` なら `source.dtmCopc`、そうでなければ `src/datasource/tauri.ts` の `dtmCopc` を渡す。
   成功したら新しいレイヤーを分類の色で出し、`ctx.setLayerDtm` で格子と TIN の数・ファイルをレイヤーに持たせる（`ViewerLayer.dtm`。`DtmInfoSection.tsx` が表示）。

### 3-B. Rust の本体（`crates/pcv-core/src/dtm.rs`）

1. **`DtmJob::new`**（301 行付近）— 点は読まない。
   1. `GridSpec::from_bounds` でヘッダーの範囲から DTM の格子を作る。**セル数が上限を超えたらここで断る**（`DtmError::TooLarge`。示す「収まる大きさ」は `smallest_fitting` が本物の検査を通して探す）。
   2. `Cloth::new`（`crates/pcv-core/src/csf.rs`）で布を作る。**粒子数が上限を超えたらここで断る**。
   3. hierarchy から点のあるノードの一覧を作る。
   4. 代表点の格子 `best`（1セル 16 B の `BestCell`）を確保する。
2. **`advance`**（451 行付近）— 呼ぶたびに小さな仕事を1つ。`Phase` が `Ihv`（読み1）→ `Simulate` → `Classify`（読み2）→ `Done` と進む。
   - 読みの段階は `read_nodes` が、ノードを丸ごと読みながら約 20 万点（`POINTS_PER_ADVANCE`）に届くまで進む。
   - 読み2では、分類した点を `out` に貯める。呼んだ側が `take_records` で毎回取り出す（貯まるのは1回分だけ）。地表の点は `keep_if_ground` で `best` の該当セルと比べ、中心に近ければ置き換える。
   - シミュレーションは1回 10 ステップ（`STEPS_PER_ADVANCE`）。
3. **`finish`**（568 行付近）— `best` から地表のあるセルの代表点を `Vec<GroundVertex>`（1点 24 B）に移し、`best` を捨て、**`DelaunayTriangulation::bulk_load` に全部渡して範囲全体の TIN を1つ作る**（596 行）。布は `self` を分解したときに捨てられる。
4. **`DtmSurface`** — TIN を持つ。
   - `write_geotiff`: `grid_values` が全セルの高さを `Vec<f32>` に作ってから書く（1セル 4 B）。
   - `write_landxml`: `dtm/landxml.rs` が頂点と三角形を1つずつ書く（文字列を全部は作らない）。ただし渡す `Write` がメモリなら全部メモリに載る（3-D）。

### 3-C. デスクトップ（`crates/pcv-convert/src/dtm.rs`）

1. Tauri のコマンド `dtm_copc`（`src-tauri/src/conversion.rs`）— 出力のパス（一時フォルダの `<名前>-dtm.copc.laz`・`.tif`・`.xml`）を決め、`run_tool`（別スレッド・`catch_unwind`・キャンセル）で `dtm_path_desktop` を呼ぶ。
2. `dtm_path_desktop` — 上限を選ぶ（デスクトップの値。Android は Web の値）。
3. `dtm_inner`
   1. ヘッダーを読み、`DtmJob::new`（ここで上限の検査）。
   2. `DtmRecords`（`Iterator`）を copc-writer の `write_streaming_with_cancel_and_timings` に渡す。writer が最初の点を引いたときに読み1とシミュレーションが走り、そのあと読み2の点がノードごとに流れる。点は writer の spill（ディスク）へ行く。
   3. writer の仕上げ（八分木・圧縮。渋谷で約 2.5 分）。**このあいだも `job`（布と `best`）は生きている。** 進捗はこの間 90〜95% のまま動かない。
   4. `job.finish()` で TIN、続いて GeoTIFF と LandXML をファイルへ書く（`BufWriter`）。
4. 失敗・キャンセルでは3つの出力を全部消す（`dtm_path`）。

### 3-D. Web（`crates/pcv-wasm/src/dtm.rs` と `src/datasource/copc.worker.ts`）

1. `src/datasource/web.ts` `WebSource.dtmCopc` → Worker に `dtmStart`。
2. Worker の `runDtm` — OPFS の一時ファイルと出力を用意し、`new WasmDtm(...)`（ここで `DtmJob::new`。Web の上限。LandXML を作るときはセルの上限が小さい）。
3. `job.advance()` を繰り返し、その間にイベントループへ戻ってキャンセルを受ける。分類した点は `SpillWriter`（OPFS）へ。
4. `job.finish()` — **先に TIN を作り**（地表が無ければ COPC を書く前に失敗させるため）、そのあと COPC の仕上げ（`write_copc_from_spill_with_fs_and_timings`）。つまり **TIN と COPC の仕上げのメモリが重なる**。この間キャンセルは効かない。
5. `job.geotiff()`・`job.landxml()` — どちらも **`Vec<u8>` に全部作って** JS へ返す。LandXML は渋谷で約 2 GB になる大きさで、wasm のメモリ（最大 4 GiB）に収まらない。
6. Worker は2つを転送で本体へ送り、`web.ts` が `Blob` のダウンロード URL にする。

## 4. 何がどの段階でメモリに載るか

渋谷（`tokyo-shibuya-merged-v2.copc.laz`、3,200 m × 2,400 m、3.48 億点）、布 1.0 m・セル 0.5 m での量です。
「量」は式からの **推定**。実測の内訳は `TaskSheets/BENCH-dtm-memory.md`（測定中。結果が出たらこの表に実測の列を足す）。

| 構造 | 何に比例するか | 1単位 | 渋谷の量（推定） | 生きている段階 |
|---|---|---|---|---|
| 布（`Cloth`: `h`・`prev`・`ihv`・`ihv_dist`・`movable`） | 面積 ÷ 布の解像度² | 17 B/粒子（＋ シミュレーション中の一時配列） | 768 万粒子 → 約 131 MB（布 0.5 m なら 3,072 万粒子 → 約 522 MB） | `new` 〜 `finish`（デスクトップは COPC の仕上げの間も） |
| 代表点の格子 `best` | 面積 ÷ セル² | 16 B/セル | 3,072 万セル → 約 492 MB | `new` 〜 `finish` の途中 |
| 読んでいるノード・`out` | 1回の `advance` の点数 | 点のレコード | 数十万点分（小さい） | 読みの段階 |
| 代表点の `Vec<GroundVertex>` | 地表のあるセルの数 | 24 B/点 | 1,365 万点 → 約 328 MB | `finish` の中（TIN を作る間） |
| **範囲全体の TIN**（spade） | 地表のあるセルの数 | 推定 約 100 B/頂点（測っていない） | 1,365 万頂点 → 約 1.3〜1.5 GB（推定） | `finish` 〜 書き出しの終わり |
| GeoTIFF の値 `grid_values` | 面積 ÷ セル² | 4 B/セル | 約 123 MB | `write_geotiff` の中 |
| LandXML（Web だけメモリ） | TIN の頂点＋三角形 | 約 70〜80 B/頂点（ファイルの大きさから） | 約 2 GB（デスクトップの出力が 1,984,076,620 バイト） | Web の `landxml()` の中と、JS に渡した後 |
| COPC の書き出し（copc-writer） | 部分木の大きさ（ADR-0019） | — | 測っていない | デスクトップ: 読み2〜仕上げ。Web: `finish` の中（TIN と重なる） |

**点数に比例するものは無い**（点は流すだけ）。ただし **TIN と LandXML は「面積 ÷ セル²」に比例し、範囲全体を一度に持つ**。これが大きい範囲で上限に当たる原因です。

## 5. いまの上限と、その問題

上限は `crates/pcv-core/src/dtm.rs` の先頭の定数です。

| | 布の粒子数 | セル数 |
|---|---|---|
| デスクトップ | 4,000 万 | 4,000 万 |
| Web・Android | 1,600 万 | 800 万（LandXML ありは 200 万） |

- 上限は「布の粒子数」と「セル数」で一律に断っているが、実際にメモリを食うのは主に TIN（と Web の LandXML）で、断る理由と食う物が対応していない
- Web と Android の値は **推定**（測っていない）。デスクトップの値も、渋谷の 2 条件（ピーク 2,401 MiB・3,089 MiB）からの直線の延長
- 直す方向（所有者と相談中）: 代表点をディスクに書き出し、帯（タイル＋余白）ごとに TIN を作って GeoTIFF と LandXML へ順に書き足す。Web の LandXML もファイル（OPFS）へ直接書く。こうすると範囲全体でメモリに持つのは布だけになり、上限は実測の内訳から決め直せる

## 6. 関連

- 計画: `TaskSheets/G1-raster-and-dtm.md`（9 節が DTM）
- 実装と測定: `TaskSheets/G1-T15-dtm.md`（3 節 上限、5 節 測定）
- 布（CSF）: `crates/pcv-core/src/csf.rs`、`TaskSheets/G1-T3-csf-core.md`
- 同じ作り（局所の CSF ＋ TIN）を断面の線の周りだけでやるのが断面線: `crates/pcv-core/src/section_line.rs`、`TaskSheets/G2-T9-section-line.md`
- GeoTIFF の書き方: `crates/pcv-core/src/raster/`、`TaskSheets/G1-T2-raster-grid-geotiff.md`
