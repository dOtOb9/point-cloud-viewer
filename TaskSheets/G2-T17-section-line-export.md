# G2-T17: 断面線の書き出し（G2-7a CSV・G2-7b DXF）

- 日付: 2026-10-22
- 計画: `TaskSheets/G1-raster-and-dtm.md` 8.4 節の G2-7、8.5 節の Q17（形式は全部対応。分け方は a CSV → b DXF → c SIMA → d J-LandXML）
- 今回は **a と b だけ**。c（SIMA）と d（J-LandXML の横断）は仕様書を読んでいないので対象外
- 前提の記録: `G2-T9-section-line.md`（断面線の計算）、`G2-T13-section-line-edit.md`（なぞって編集）

## 1. 利用者から見た形

- 断面図のパネル（`src/ui/section/SectionPanel.tsx`）の上の段に、断面線があるときだけ「CSV」「DXF」の2つのボタンを出す
  （既存の「元に戻す」などと同じ灰色の文字ボタン）。断面線が無い（未計算・失敗）ときは出さない
- 書き出すのは **いま表示している線**（`section.line.history.present`）。なぞって直した線ならその形
- デスクトップ: 保存ダイアログで場所を選び、そこに書く。Web: ブラウザのダウンロード
- ファイル名の候補: `<断面レイヤーの名前>-断面線.csv` / `.dxf`（ファイル名に使えない文字は置き換える）
- 失敗はエラーログに本文のまま（ADR-0011）。保存ダイアログを閉じたときは何もしない

## 2. 中身

### 2.1 座標（最初に確かめること）

断面線は `SectionGroundLine.points`（`f32` の `(s, z)` の並び、ファイルの単位）。`s` と `z` の定義は
`crates/pcv-core/src/profile.rs` の `SectionAxes`（`s` = A から A→B 方向への水平距離、`z` = `up` 方向の高さ）にある。

- **`z` が「A からの相対の高さ」か「絶対の標高」かをコードで確かめる**（`p - origin` の形なので相対の可能性がある）。
  書き出す `z` は **パネルの GL の表示（右クリック）と同じ値** にする。違えば直さず、どちらにしたかと理由を記録に書く
- X, Y は `SectionInfo.a`・`b`・`up` から、`profile.rs` と同じ作り方の `along`（A→B から `up` 成分を除いた単位ベクトル）で
  `A + s * along` として **f64 で** 計算する（`f32` の `s` を足すのは良いが、A は f64 のまま。平面直角座標は数万 m あるので f32 にしない）。
  計算は TS の純粋な関数にし、`src/state/tool-math.ts` の `sectionBox` と食い違わないこと（同じ `along` を使う。可能なら既存の関数を使う）
- 単位は **ファイルの単位のまま**（座標を CRS と合わせるため）。表示単位（m / ft）に換算しない

### 2.2 G2-7a CSV

- UTF-8（BOM なし）、改行 `\r\n`（Excel で開く人が多い）。1行目は見出し `s,z,X,Y`（所有者の指定の順）
- 数値は小数3桁（`toFixed(3)`）。ファイルの単位が m なら mm まで
- 1行 = 線の1点。点の順は線の順（A→B）

### 2.3 G2-7b DXF

- **ASCII の DXF R12（AC1009）**。読めるソフトがいちばん多いため。`HEADER`（`$ACADVER` = `AC1009`）と `ENTITIES` だけでよい
- 線は `POLYLINE`（`66` = 1、2D）＋ `VERTEX` の並び＋ `SEQEND`。`LWPOLYLINE` は R12 に無いので使わない
- 図面の座標は **横断図として**: X = `s`、Y = `z`（2D の折れ線）。画層名は `SECTION_LINE`
- 数値は小数3桁

### 2.4 場所（ADR-0021 に従う）

| 何を | どこに |
|---|---|
| CSV と DXF の文字列を作る純粋な関数、X・Y の計算 | `src/app/section-export.ts`（新規。React を import しない） |
| 手順「形式を選ぶ → 保存先を聞く（デスクトップ）→ 書く / ダウンロード（Web）」 | 同じファイルの普通の関数 `exportSectionLine(ctx, layerId, format)` |
| デスクトップで文字列をファイルに書く | Tauri のコマンドを1つ足す（例: `save_text_file(destination, text)`）。呼ぶのは `src/datasource/tauri.ts` だけ（規約2）。保存ダイアログは既存の `saveFileDialog` の使い方に揃える |
| Web のダウンロード | `Blob` + `<a download>`。`src/app/raster-window.ts` の `startDownload` と同じ形。共通にするなら小さい関数を1つ動かすだけにする |
| ボタン | `SectionPanel.tsx`。`exportSectionLine` を直接呼ぶ（F12 で飛べるように） |

**規約2の注意**: `src/` の中では、Tauri の API パッケージ名をコメントにも書かない（CI の文字列検索で落ちる）。

## 3. 受け入れ基準

1. 単体テスト（vitest）:
   - CSV: 見出し、行数 = 点数、小数3桁、`\r\n`、X・Y が A・B・`up` と `s` から正しく出ること（A→B が斜め 45° の場合と、`up` が Z の普通の場合）
   - X・Y が平面直角座標の大きさ（例: X = -12345.678, Y = -45678.901）でも mm まで合うこと（f32 に落ちていないこと）
   - DXF: グループコードと値が交互に並び、`SECTION`/`ENDSEC`/`EOF` が揃うこと、`VERTEX` の数 = 点数、座標が `(s, z)`
   - `exportSectionLine`: 線の無いレイヤーは何もしない（またはメッセージ）、保存ダイアログを閉じたら書かない、失敗はエラーログ
2. Rust（Tauri のコマンドを足した場合）: `cargo test`・`cargo clippy --workspace --all-targets -- -D warnings`・`cargo fmt --check` が通る。コマンドの中で `unwrap` しない
3. `npm test`・`npm run lint`・`npm run typecheck` が通る。push 後の CI（invariants を含む）が success。run id を報告する
4. **Web で実際に書き出して中身を見る**: preview サーバー（`PCV_E2E_PORT` で空いているポート）で autzen か渋谷を開き、断面を作り、断面線を計算し、
   CSV と DXF をダウンロードする。ダウンロードしたファイルの先頭数行を報告に貼る。CSV の X・Y が点群の範囲（レイヤー情報の範囲）の中にあることを確かめる。
   ブラウザで確かめられなければ「未確認」と書く
5. `TaskSheets/G2-T17-section-line-export.md` の末尾に「実施の記録」の節を足す（日本語）: やったこと、`z` が相対か絶対か調べた結果、他の案と採らなかった理由、触ったファイル、実行したコマンドと出力、未確認のこと、所有者の確認手順

所有者の確認（エージェントはできない）: CSV を Excel で、DXF を所有者が使う CAD（または土木ソフト）で開けること。

## 4. 作業の決まり

- `CLAUDE.md` に従う（コードのコメントは英語、TaskSheets・コミットは日本語、コミットの1行目は絵文字＋種類）
- **コミットは G2-7a（CSV と、共通の保存の経路）と G2-7b（DXF）で分ける**
- 始める前に `git fetch origin && git rebase origin/main`、push は `git push origin HEAD:main`、push 前に `git diff origin/main --stat` で自分の差分だけか確かめる
- `git stash` は使わない。`TaskSheets/HANDOFF.md` は触らない
- 10分以上かかりうるコマンド（CI の完了待ちなど）は `run_in_background` で走らせ、結果をファイルから読む
- preview サーバーは自分が立てたものだけを止める（コマンドラインを確かめてから）。全 node/chrome の一括終了は禁止
- 点群データは `C:\rust\point-cloud-viewer\data\` を絶対パスで読む。コミットしない

## 5. 実施の記録（2026-10-23）

### やったこと

- G2-7a（CSV と共通の保存の経路）、G2-7b（DXF R12）の2コミット。パネルの上の段に「CSV」「DXF」のボタン（断面線があるときだけ。`data-testid` は `section-export-csv`・`section-export-dxf`）
- `src/app/section-export.ts`: `sectionLineWorldPoints`（X・Y の計算）、`sectionLineCsv`、`sectionLineDxf`、`safeFileName`、手順 `exportSectionLine(ctx, layerId, format)`
- `src/state/tool-math.ts`: `sectionAlong(a, b, up)` を足し、`sectionBox` もそれを使うようにした（`along` の作り方を1か所にした）
- デスクトップ: Tauri コマンド `save_text_file(destination, text)`（`src-tauri/src/conversion.rs`、`panic` しない `write_text_file` に分けてテスト）。`src/datasource/tauri.ts` に `chooseTextDestination`・`saveTextFile`
- Web: `Blob` + `<a download>`。`startDownload` を `src/app/download.ts` に動かし、GeoTIFF の書き出し（`raster-window.ts`）と共有

### z は相対か絶対か（2.1）

**絶対（`up` 方向の座標そのもの）。** `crates/pcv-core/src/profile.rs` の `SectionAxes::project` は
`(dot(p - origin, along), dot(p, up))` で、`s` だけ A からの距離、`z` は `origin` を引かない `dot(p, up)`。
パネルの GL の表示（右クリック）は `groundLevelAt`（`src/app/section-3d.ts`）が同じ線の `interpolateZ` から出す `reading.z` を
`groundLevelLabel` で整形するだけなので、線の `z` と同じ値。したがって書き出す `z` は線の値のまま（変換なし）で、GL の表示と一致する。
実測でも、Web で書き出した autzen の CSV の z が 429 前後（ファイルの単位は ft。下記）で、レイヤー情報の高さの範囲（123.79〜187.53 m = 406〜615 ft）の中にある。
GL の画面表示との突き合わせ自体は目で比べていない（未確認）。

### 他の案と採らなかった理由

- X・Y を Rust 側で作る案: Tauri と Web の両方に要るため、純粋な TS 関数にした（受け入れ基準の指定どおり）
- 書き出す前に m / ft へ換算する案: 座標を CRS と合わせるため、ファイルの単位のまま（2.1）
- 保存を Rust の既存 `save_tool_file`（一時フォルダ → コピー）に載せる案: 一時ファイルを作る手間が増えるだけなので、文字列を直接書く `save_text_file` を足した

### 触ったファイル

`src/app/section-export.ts`・`section-export.test.ts`・`download.ts`（新規）、`src/app/raster-window.ts`、`src/state/tool-math.ts`、
`src/datasource/tauri.ts`、`src/ui/section/SectionPanel.tsx`、`src-tauri/src/conversion.rs`・`lib.rs`

### 実行したコマンドと結果

- `npx vitest run`: 83 ファイル・818 テスト成功（追加は `section-export.test.ts` の 11 件。X・Y の 45° と大きな座標 -12345.678 / -45678.901、CSV の見出し・小数3桁・CRLF、DXF のグループコードと `VERTEX` 数、`exportSectionLine` の4経路と Web）
- `npm run typecheck`・`npm run lint`: 指摘なし
- `cargo test --workspace`: 失敗なし（`write_text_file_*` の2件を含む）、`cargo clippy --workspace --all-targets -- -D warnings`: 指摘なし、`cargo fmt --check`: 差分なし
- Web で実際に書き出し: `GITHUB_PAGES_BUILD=true` でビルド → `vite preview`（ポート 4391）→ Playwright（Chromium + `--enable-unsafe-webgpu`）で
  `autzen-classified.copc.laz`（10,653,336 点）を開き、断面（2クリック）→ 断面線の計算 → 「CSV」「DXF」を押してダウンロード。
  - CSV: 1986 行（見出し + 1985 点）。先頭 `s,z,X,Y` / `0.000,429.283,637901.959,849647.931` / `1.640,429.288,637901.918,849649.571`。行末は `\r\n`（`od -c` で確認）、BOM なし
  - CSV の X・Y は 637,821〜637,902 と 849,647〜852,902（ft）。レイヤー情報の範囲 x 193,724〜194,768 m・y 258,739〜260,158 m は、ファイルの単位が ft（EPSG:2992）なので ×0.3048 すると 194,4xx m・258,9xx〜259,9xx m で範囲の中
  - DXF: 先頭 `0 SECTION / 2 HEADER / 9 $ACADVER / 1 AC1009 / 0 ENDSEC / 0 SECTION / 2 ENTITIES / 0 POLYLINE / 8 SECTION_LINE / 66 1 ...`、末尾 `0 SEQEND / 8 SECTION_LINE / 0 ENDSEC / 0 EOF`、`VERTEX` は 1985 個（点数と同じ）
- 自分が立てた preview サーバー（ポート 4391）は止めた

### 未確認

- デスクトップ（Tauri）での保存ダイアログと `save_text_file`（Rust のコマンドは単体テストのみ。実機の画面は未確認）
- CSV を Excel で、DXF を CAD・土木ソフトで開くこと（所有者の確認）
- GL の画面表示（右クリック）の値と CSV の z を同じ点で並べて見たこと（コードの上で同じ値になることだけ確認）
- 狭い画面でボタンが増えた分の折り返し

### 所有者の確認手順

1. 断面を作って断面線を計算し、パネルの「CSV」「DXF」を押す（デスクトップは保存先を選ぶ。ダイアログを閉じると何も起きない）
2. CSV を Excel で開く: 見出し `s,z,X,Y`、数値が3桁、X・Y が点群の座標（ファイルの単位）
3. DXF を使っている CAD・土木ソフトで開く: 画層 `SECTION_LINE` に横断の折れ線（横軸 = s、縦軸 = z）
4. パネルで線を右クリックして出る GL と、CSV の同じ s の z が合うこと
