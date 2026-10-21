# G0-3: ツールの進捗のウィンドウは、外をクリックしても止めない

`G1-raster-and-dtm.md` 14節の手順 G0-3 の実装記録。G シリーズのタスクシートは日本語で書く（所有者の指示）。

## 何が問題だったか

`ToolProgressDialog`（断面・ラスタ化・断面線などの進捗）は、ダイアログの `onClose`（外のクリック・Esc）に `cancelTool` をつないでいた。
外をクリックしただけで処理が止まっていた。ファイルの変換（`ConversionDialog`）は既に「外のクリック・Esc ではたたむだけ、
ステータスバーの『変換中 …%』で開き直す」形だったので、ツールもそれに揃えた。

## やったこと

- 外のクリック・Esc: たたむだけ（`onCollapse`）。処理は続く
- ステータスバーに「ツール実行中 N%」（割合が無いときは「ツール実行中…」）を、ツールが動いていて、かつウィンドウがたたまれている間だけ出す。押すと開き直す
- 止めるのは「キャンセル」ボタン（`data-testid="tool-cancel"`）だけ
- 新しいツールが始まったら、ウィンドウはまた開く（たたんだままにならない）

## 決めたこと・採らなかった案

- 変換の作りに合わせた: `AppShell` に `toolDialogOpen` の `useState` を1つ置き、「動いていない→動いている」の変化を、
  変換と同じ書き方（前回の値を state に持って描画中に比べる）で見て `true` に戻す。新しい抽象（共通のフック・コンポーネント）は作らない
- 割合は `pointsRead / totalPoints`。ただし書き出しの間は割合が出ない（`totalPoints` が 0）ので、そのときは「ツール実行中…」
- 採らなかった案: ダイアログ自身が閉じた状態を持つ。ステータスバーから開き直せなくなるので、変換と同じく `AppShell` が持つ
- 他のダイアログは変えていない

## 触ったファイル

- `src/ui/tools/ToolProgressDialog.tsx`: `open`・`onCollapse` を受け取る。`onClose` は `onCollapse`、`cancelTool` は「キャンセル」ボタンだけ
- `src/ui/status/StatusBar.tsx`: 「ツール実行中」のボタン（`data-testid="tool-progress-chip"`）
- `src/ui/shell/AppShell.tsx`: `toolDialogOpen` の state と、新しいツールで開き直す処理
- `src/ui/tools/ToolProgressDialog.test.tsx`（新規）: Esc でたたんでも `cancelTool` が呼ばれない／キャンセルボタンは呼ぶ

## 確かめたこと

- `npx vitest run`: 74 ファイル・713 テストが通った。`npx tsc --noEmit`、`npm run lint` はエラー無し
- Web 版（`GITHUB_PAGES_BUILD=true` でビルドして `vite preview`、ヘッドレス Chromium）で `autzen-classified.copc.laz`（10,653,336 点）を開き、
  ラスタ化を実行した。進捗のウィンドウの外をクリックするとウィンドウが消え、ステータスバーに「ツール実行中 2%」が出た。
  それを押すとウィンドウが開き直り、Esc でまたたたんだ。最後まで走り、「ラスタ - autzen-classified.copc.laz」（1,359,442 点）のレイヤーができた
- スクリーンショット（作業用の場所。コミットしていない）: `C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\9abf0cdc-f427-4eff-bf22-b8839bdd7c27\scratchpad\` の
  `2-progress-dialog.png`・`3-collapsed.png`・`4-reopened.png`・`5-finished.png`

## 確かめていないこと

- デスクトップ（Tauri）版・Android 版。断面・断面線など、ラスタ化以外のツール（同じ `ToolProgressDialog` を通るが、実際には押していない）
- 実 GPU（ヘッドレス Chromium のソフトウェア描画のみ）

## 所有者の確認手順

1. 点群を開き、ラスタ化（または断面）を実行する
2. 進捗のウィンドウの外をクリックする。ウィンドウだけが消え、処理は続く。ステータスバーに「ツール実行中 …%」が出る
3. それを押すと進捗のウィンドウが開く。「キャンセル」を押したときだけ処理が止まる
4. 処理が終わるとステータスバーの表示が消え、新しいレイヤーができる。続けて別のツールを実行すると、ウィンドウは開いた状態で始まる
