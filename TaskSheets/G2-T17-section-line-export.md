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
