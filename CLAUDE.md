# このリポジトリで作業する Claude へ

点群ビューア（Tauri + React + WebGPU、COPC）。デスクトップ（Windows）・Android・Web（GitHub Pages）の3形態がある。
全体像は設計書 `docs/book/`（公開: https://dotob9.github.io/point-cloud-viewer/book/）、再開時の状態は `TaskSheets/HANDOFF.md`、
決定の理由は `TaskSheets/ADR-*.md` にある。

## 最優先: 所有者が実装を追えること

- 凝った抽象化より、退屈で読めるコードを選ぶ。抽象化を入れるなら理由を書く
- **コード中のコメント（Rust・TypeScript・WGSL・スクリプト）は英語**で書く（所有者の決定 2026-10-15）。
  既存の日本語のコメントは一度に書き換えない。触った関数・その周りのコメントを、触るついでに英語にする（ADR-0015 と同じ「触ったところから」の考え）
- **`TaskSheets/` の文書（タスクシート・ADR・ベンチの記録）は日本語**で書く（所有者の決定 2026-10-22。
  2026-10-15 の「英語で書く」を取り消した）。新しく作るファイルは日本語。既存の英語のファイルに追記する節も日本語でよい
  （既存の英語の本文は一度に訳さない）。`TaskSheets/HANDOFF.md` はコーディネーターが管理する
- 設計書（`docs/book/`）・コミットメッセージ・所有者への報告も**日本語**。英語にするのはコード中のコメントだけ
- 何をしたか、なぜその方法を選んだか、他の案をなぜ採らなかったか、触ったファイル、所有者が自分で確かめる手順を `TaskSheets/` に記録する
- 1コミット1関心事。逐次コミットして push する

## 正直さ

- **測っていないこと・確かめていないことを「実測した」「確認した」と書かない。** 推測や設計上の見込みは「未検証」「推定」と明記する
- 数値は、実際に実行したコマンドの出力から書く
- 画面・実機（GPU、スマホ、ブラウザ）で確かめられないことは「未確認」と書き、所有者の確認手順を残す
- **テストと CI が緑でも、動くとは限らない。** このプロジェクトでは、緑のまま画面が真っ黒・全ノード読み込み失敗・Web の変換が必ず失敗、が何度も起きている

## 規約（CI の `invariants` ジョブが検査する。詳細は `TaskSheets/ARCHITECTURE.md`）

1. `crates/pcv-core` は Tauri に依存せず、`wasm32-unknown-unknown` でビルドできる
2. Tauri の API パッケージ（`@tauri-apps/` で始まる npm パッケージ）を import してよいのは `src/datasource/tauri.ts` だけ。
   **検査は `src/` 配下の文字列検索なので、コメントにそのパッケージ名を書いただけでも落ちる**（過去に2回落ちた）
3. `src/renderer/` は React を import しない
5. `src/app/` は React も `src/state/use*` も import しない（番号は `ARCHITECTURE.md` に合わせている。4 は CI の検査対象外）

## React は表示だけ（`TaskSheets/ADR-0021-thin-react.md`、所有者の決定 2026-10-18）

- React（`src/ui/` の部品）は、状態を表示し、操作されたら `src/app/` の関数を呼ぶだけにする
- 手順のある処理（ファイルを開く・変換・レイヤー・ツール・計測・表示の設定）は、`src/app/` の**普通の関数**に書く。
  `useCallback`・依存配列・ref・`this` を使わず、上から順に読める形にする。読む物・変える物は全部引数（コンテキスト）で受け取る
- **状態は React に置く**（`src/state/` の小さなフックの `useState`）。関数はコンテキストで渡された setter でだけ状態を変える。関数の中に状態を隠し持たない
- **クラスは、長く生きる資源を持つものだけ**（WebGPU の `PointCloudRenderer`、Worker の `WebSource`）。手順や画面の状態をクラスにしない（所有者の決定 2026-10-18。副作用を見えるようにするため）
- `src/ui/` は `src/app/` の関数を直接呼ぶ（`openFiles(viewer.fileOpenContext, items)`）。F12 で本体に飛べるようにするため
- **新しいロジックをフックに足さない。** 既存のフックは、1関心ごとずつ `src/app/` へ移す（R12・R13 から）

## エラー処理（`TaskSheets/ADR-0015-error-handling-incremental.md`）

**触ったコードとその周りに当てはめる。** 全体を一度に直す作業はしない。

- 触った関数では `unwrap`・`expect`・`panic!` など panic しうる書き方を `Result` に直す（テストは対象外）
- wasm で使われるクレート（`crates/pcv-core`・`crates/pcv-wasm`・`vendor/copc-writer` など）では、
  ブラウザで panic する標準ライブラリの機能（`std::time::Instant::now`・`SystemTime::now` など）を使わない
- Rust を呼ぶ入口（`pcv://`、Tauri のコマンド、Web の Worker）で panic を受け止め、エラーとして画面に流す
- エラーは黙って捨てず、既存のエラー表示（ADR-0011 のバナーとログ）に本文のまま出す

## 機能の向き（`TaskSheets/ADR-0018-layer-centric-operations.md`）

点群に対する機能は「**選んだレイヤーから、新しいレイヤーを作る**」形に揃える。元のレイヤーは書き換えない。
着色・EDL などの表示の設定は対象外。

## メモリ

- 変換・読み込みでは、**メモリが点数に比例しないこと**を守る（数億点を扱う。M4-1・M4-6・M4-7・M4-9 で同じ問題を何度も直している）
- 新しく大きなデータを扱う処理を書いたら、抱える量に上限があることをテストで確かめる

## E2E テストが使う ID は残すこと

`playwright.config.ts`・`e2e/web-conversion.spec.ts`（[ADR-0016](./TaskSheets/ADR-0016-e2e-web-conversion.md)）が、
Web版の変換の流れを実ブラウザで確かめるのに次の`data-testid`を使っている。
UIを作り直すときも、同じ役割の要素にこれらの`data-testid`を付け直すこと
（クラス名やDOM構造を変えるだけなら問題ない）。削る場合は、E2E側も必ず一緒に直す。

| `data-testid` | 場所（現在） | 役割 |
|---|---|---|
| `open-button` | `src/ui/toolbar/buttons/OpenFileButton.tsx` | 開くボタン。E2E はこれを押して `filechooser` でファイルを渡す |
| `conversion-breakdown` | `src/ui/layers/ConversionBreakdownPanel.tsx` | 変換完了後の「変換の内訳」パネル。表示を待つ |
| `download-link` | `src/ui/layers/LayerInfoSection.tsx` | 変換したCOPCのダウンロードリンク（`<a>`） |
| `viewer-error` | `src/ui/layers/LayerInfoSection.tsx` | エラーメッセージの`<p>`。無いことを確かめる |

## 守ること

- 秘密鍵・キーストア・パスワード、点群データ（`*.laz`・`*.copc.laz`・`*.pcd`・`/data`）は**コミットしない**
- タグ・Release は、所有者かコーディネーターに頼まれたときだけ作る
- `TaskSheets/HANDOFF.md` はコーディネーターが更新する。エージェントは触らない
- 外部のリポジトリ（上流のクレートなど）への提案・Issue・PR はしない

## エージェントとしての作業の手順

- git worktree で作業する。始める前に `git fetch origin && git rebase origin/main`。push は `git push origin HEAD:main`。
  push の前に `git diff origin/main --stat` で自分の差分だけか確かめる
- **`git stash` は使わない**（他のセッションと共有されている）。退避は一時コミットで
- 10分以上かかりうるコマンド（大きなビルド、数億点の変換、CI の完了待ち）は `run_in_background` で走らせる。返らないと中断される
- 時間を測る計測は、プロセスを **P コアに固定して**走らせる（`ProcessorAffinity = 0xFFF`。この PC の i5-14600K の値）。
  そのままだと Windows が E コアに回し、同じ処理が3〜4倍遅くなる（`TaskSheets/BENCH-measurement-cores.md`）
- E2E/画面確認で preview サーバーを立てるときは `PCV_E2E_PORT` で空いているポートを使い、終わったら自分が立てたプロセスだけを止める（コマンドラインを確かめてから）。全 node/cmd/chrome の一括終了は禁止（理由と使い方は ADR-0016）
- 点群データは worktree に無い（gitignore）。`C:\rust\point-cloud-viewer\data\` を絶対パスで読む
- コミットメッセージの1行目は「絵文字 + 種類 + 本文」にする（所有者の決定 2026-10-17。それより前のコミットは書き換えない）。
  例: `♻️ refactor: 中継するだけの App を消す`。種類と絵文字は次の対応に揃える。scope を付けるときは `📝 docs(book): ...`
  | 種類 | 絵文字 | | 種類 | 絵文字 |
  |---|---|---|---|---|
  | `feat` | ✨ | | `docs` | 📝 |
  | `fix` | 🐛 | | `chore` | 🔧 |
  | `refactor` | ♻️ | | `test` | ✅ |
  | `style` | 🎨 | | `build` | 📦 |
- コミットメッセージの末尾に、ハーネスが指定する `Co-Authored-By` の行を付ける
- 終わったら、実行したコマンドとその出力（テスト結果、CI・Pages の run id）、確かめていないこと、所有者の確認手順を添えて報告する
