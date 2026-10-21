# G2-4 (T9): 局所の CSF 地表面から作る断面線

- 日付: 2026-10-21
- 計画: `TaskSheets/G1-raster-and-dtm.md` 8.3 節（断面線）、9.2・9.3 節（Q16: TIN の代表点はセル中心に最も近い地表の点、辺の長さの上限なし）、12 節
- 使ったもの: G1-T3 の `Cloth`（CSF）、G2-T8 のパネルと `ViewerLayer.section`、G2-T5 の `ProfileLine` ではなく `profile.rs` の `SectionAxes`

## 作ったもの

| 部分 | 場所 |
|---|---|
| Rust 本体 `SectionLineJob`（小さな手順に分けて進める）、`compute_section_line`（一括の補助）、`SectionLineRequest` | `crates/pcv-core/src/section_line.rs` |
| `SectionAxes` の `along()`・`up()`・`ranges_of_box`（可視性を `pub(crate)` に） | `crates/pcv-core/src/profile.rs` |
| デスクトップ: Tauri コマンド `compute_section_line`、`CopcState::pool_of`・`CopcPool::run_with_file` | `src-tauri/src/conversion.rs`・`copc_state.rs`・`lib.rs` |
| Web: `WasmSectionLine`（`advance` / `isDone` / `finish`） | `crates/pcv-wasm/src/section_line.rs`、再生成した wasm は別コミット |
| 呼び出し口: `computeSectionLine`（tauri.ts・`WebSource`）、Worker の `sectionLineStart`、バッファのデコーダ | `src/datasource/` |
| 手順 `computeSectionLine`、`extractFromLayer` からの呼び出し | `src/app/point-cloud-tools.ts` |
| 状態: `SectionInfo.sourceLayerId / lineRequest / line`、`setLayerSectionLineInList` | `src/state/layers.ts` |
| ダイアログのプリセット選択（標準 / 急勾配）、m → ファイルの単位の換算 `sectionLineRequestFor` | `src/ui/tools/SectionDialog.tsx`、`src/state/tool-math.ts` |
| 進捗の表示（割合）、線の描画 | `ToolProgressDialog.tsx`、`src/renderer/section-2d.ts`（`drawGroundLine`）、`SectionPanel.tsx` |
| 計測用の例 | `crates/pcv-convert/examples/section_line_bench.rs` |

追加した依存: `spade` 2.15.1（ライセンス MIT OR Apache-2.0、`Cargo.lock` で確認）。`robust`・`hashbrown`・`allocator-api2` も入る。

## 決めたこと・他の案

- **Delaunay のクレート**: `spade`。理由は、点の位置の探索と重心座標の補間（`barycentric().interpolate`。凸包の外は `None`）がそのまま使え、頑健な幾何の判定（`robust`）を持つため。
  `delaunator` は三角形の配列だけを返すので、線との交点や点の位置の探索を自分で書く必要があった。純 Rust で、`wasm32-unknown-unknown` のビルド（pcv-core と pcv-wasm の両方）が通ることを確かめた。
- **読み方**: 計画は `ExtractPoints` + `OrientedBox` だが、`CopcFile`（デスクトップのプール・Web の開いたファイルが持つ）に対して `OrientedBox`（`ExtractFilter`）の `may_intersect` でノードを選び、`contains` で点を選ぶ形にした。
  `ExtractPoints` は新しい `CopcReader` を要し、Web では開いたファイルから作り直せないため。選び方（箱の判定）は同じ。
- **布の座標系**: 断面の `(s, t, 高さ)`（`t` は線の左右）。CSF の x, y, z に s, t, 高さを渡す。布の格子が断面に揃う。上方向が Z でなくても動く。高さは `h_base`（箱の最低の高さ）を引いてから f32 の布に渡す。
- **帯**: 左右 20 m（呼び出し側でファイルの単位に換算）、線の両端の外に 20 m の余白。粒子数の上限は 200 万個（`DEFAULT_SECTION_LINE_CELL_CAP`。デスクトップと Web で同じ。**根拠のある値ではなく、5 km の線で約 160 万個になる見積りから置いた**）。超えたら `Cloth::new` の日本語の文言（「解像度を粗くするか、先に範囲を切り出してください」）で断る。
- **凸包と切れ目**: 依頼では「凸包を出たら折れ線に切れ目」だったが、凸包は直線を1つの区間でしか切らないので、途中で切れることは起きない。そのため切れ目の印（NaN）は作らず、線は凸包の中の区間だけ（端が短くなる）。テスト `line_is_cut_where_the_ground_ends`。
- **進捗とキャンセル**: `advance` 1回で、読みの段階は約 20 万点分のノード、シミュレーションは10ステップ。進捗の割合は読み1 = 0〜0.30、シミュレーション = 0.30〜0.60、読み2 = 0.60〜0.95（TIN は残り）。割合の区切りは目安で、時間の比ではない。
  デスクトップは既存のツールの進捗イベント（千分率）とキャンセルの旗（`cancel_las_conversion`）を使う。Web は 30 ms ごとにイベントループへ戻る。
- **断面レイヤーに元の線を別に持つ**: `section.line = { original, current }`（G2-5 の「元に戻す」用）。今は両方同じ。
- **失敗**: エラーログに本文のまま出し、パネルは点だけのまま。キャンセルは「断面線の計算（…）をキャンセルしました」。
- **単位**: 20 m と 0.5 m は `sectionLineRequestFor` でファイルの水平の単位（`horizontal_unit_to_meter`）に換算。単位不明のときは数値をそのままファイルの単位とする（他のツールと同じ）。
  **CSF のしきい値（上 0.1・下 1.0）と `hdiff` はファイルの単位のまま**（フィート単位のファイルでは m 換算で約 0.3 倍の厳しさになる）。G1-T3 から続く未解決の点で、今回は換算していない。

## テスト

`cargo test -p pcv-core`（142 件成功）の中の `section_line` 13 件（合成データ。m 単位）:

| テスト | 内容 |
|---|---|
| `flat_ground_with_a_building_is_bridged` | 平地 z=0、10×10 m・屋根 8 m・下に地面なしの建物を横切る。線は全区間で |z| < 0.05（建物の下も TIN がつなぐ） |
| `slope_is_followed` | z = 0.2x の斜面を 0.05 以内で追う |
| `line_is_cut_where_the_ground_ends` | 地面が x=20〜80 だけなら、線もその範囲だけ |
| `bridges_a_gap_in_the_ground` | 20 m 幅の地面の欠けをつなぐ（辺の長さの上限なし） |
| `works_for_a_line_that_is_not_along_x` | 斜め（45°）の線、y 方向に傾いた地面 |
| `ground_points_are_bounded_by_the_cells_not_by_the_points` | 6 万点以上を流しても残る地表の点はセル数（200）以下 |
| `keeps_the_ground_point_nearest_the_cell_centre` | 同じセルの角の点と中心の点で、中心の点を残す |
| `refuses_a_corridor_over_the_cell_cap` | 上限超えは「解像度」「範囲」を含む文言で断る |
| `cancel_stops_the_job`・`progress_never_goes_back`・`invalid_input_is_an_error`・`no_points_in_the_corridor_is_an_error` | |

TS: `section-line.test.ts`（デコーダ）、`point-cloud-tools.test.ts`（線を保存・進捗が割合・失敗・キャンセル・カットでは計算しない）、`tool-math.test.ts`（単位の換算）、`section-2d.test.ts`（線の描画）。

## 測ったこと（実行したコマンドと出力）

ネイティブ（release、`cargo run --release -p pcv-convert --example section_line_bench -- <file> ax ay az bx by bz standard 20 0.5`、Windows、1回目の実行）:

| ファイル・断面 | セル数 | 読み1 | シミュレーション | 読み2 | TIN | 合計 | 地表の点 |
|---|---|---|---|---|---|---|---|
| `tokyo-shibuya-merged-v2.copc.laz`（3.48 億点）、(-12250,-37800)→(-11750,-37800)、500 m、標準 | 86,400 | 4.22 s | 1.69 s | 8.79 s | 0.033 s | 14.73 s | 50,728 |
| 同、急勾配 | 86,400 | 3.90 s | 1.59 s | 7.70 s | 0.039 s | 13.23 s | 51,832 |

線は 1,001 サンプル。急勾配の線は 20 m 前後〜15 m 前後の範囲で、470 m 付近に 34.8 m の高い所がある（大きな建物か丘かは**見ていない**。画面では確認していない）。読み2が読み1の約2倍かかる理由は**調べていない**。

Web（実ブラウザ、下の画面確認の実行）: autzen-classified.copc.laz（1,065 万点、約 500 m の断面）で、確定から線が出るまで 3.6 s（2回目以降）〜7.9 s（1回目。ファイルがキャッシュに無いとき）。Playwright で進捗ダイアログの題名が出ている時間を測った値。

## 画面（Web ビルド、実 GPU）

`npm run build`、`npx vite preview --port 4417 --strictPort`、画面つき Chromium（フラグ: `--enable-unsafe-webgpu --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`）。
`adapter.info` は `{"vendor":"nvidia","architecture":"lovelace"}`（SwiftShader ではない）。終わったあと自分が起動した preview だけを止めた。
autzen で建物と木を横切る断面（厚み 8 m または 1 m、標準）を作った。スクリーンショット（リポジトリの外、セッションの scratchpad）:
`C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\94185ff5-fa53-4b91-8c39-9a0ed557db69\scratchpad\shots\`
- `a-03-dialog.png`: ダイアログのプリセット選択（標準が既定）
- `b-04-panel.png`: 全体。オレンジの線が地面に沿い、屋根・木の下を通る
- `c-05-zoomed.png`: 建物を拡大。屋根の下に地面の点が無く、線が滑らかにつなぐ
- `d-05-zoomed.png`: 木を拡大。線は木の幹の根元の地面に沿い、樹冠は無視される

見えたこと: 線の色は、ライトテーマの二次色（`--secondary`）の茶に近いオレンジ。エラー表示（`viewer-error`）は無し。

## 確かめていないこと

- デスクトップ（Tauri）のアプリでの実行: コマンドは clippy を通るが、動いているアプリから呼んでいない。
- 急勾配のプリセットの画面での確認、フィート単位の座標（autzen は ft だが、CSF のしきい値は換算していない。上の「単位」）。
- 渋谷の断面の線を画面で見ていない（時間だけ測った）。
- Web のキャンセルの実機での操作（単体テストと、Worker が旗を見る作りだけ）。
- 上限（200 万粒子）を超える帯の画面での表示、スマホ。
- Web で `finish`（TIN）の間はキャンセルが効かない（大きさはセル数で抑えられ、渋谷の例で 0.03 s）。

## 所有者の確認手順

1. `npm run build`、`npx vite preview`、`autzen-classified.copc.laz` を開く。
2. 「断面」で建物と木を横切る2点をクリックし、プリセット（標準 / 急勾配）を選んで「作る」。
3. 断面図のパネルに点が出たあと、進捗ダイアログ（「断面線の計算」、割合）が出て、終わるとオレンジの線が地面に沿って出ること。建物の下を滑らかにつなぐこと。
4. 計算中に「キャンセル」を押すとエラーログに「…をキャンセルしました」が出て、パネルは点だけのままであること。
5. 急勾配の斜面で、標準と急勾配の線を見比べる。
