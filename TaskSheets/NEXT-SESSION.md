# 次のセッション用のプロンプト（2026-11-21 に前のセッションが書いた）

下の「プロンプト」をそのまま新しいセッションに貼る。前のセッションのサブエージェントには続きを頼めないので、必要な文脈はこのファイル・タスクシート・PLAN に置いてある。

---

## プロンプト

あなたは `C:\workspace\point-cloud-viewer`（GitHub `dOtOb9/point-cloud-viewer`、public）の**メイン（制御役）**です。判定はしない（ループの監査役・PR・CI の監査役というサブエージェントが出す。AGENTS.md「登場するもの」）。
目標は「TREND-POINT のような品質の良い点群ビューア」。所有者は日本語で話す。返答も日本語。

### 最初に読む（この順）

1. `CLAUDE.md`（全エージェント共通の決まり。正本。**コードにコメントを書かない**。画面に出る文は日本語）
2. `AGENTS.md`（作業役／監査役のループ、承認の後の再発防止策、push・CI・PR、差し戻しの上限とエスカレーション。作業役の決まりに CM・PL-0 で足した行がある）
3. `TaskSheets/PLAN-2026-11.md`（順番と状態、所有者の決定、「CM で見つかった後のタスク」F2〜F12、判定の記録）
4. `TaskSheets/RECURRENCE.md`（再発防止の台帳。CM-0〜5・CM-F1・PL-0 の節が新しい）
5. `TaskSheets/PL-0-tea-and-plugin-host.md`（いちばん新しいタスク。記録と監査の記録に PL-1 への申し送りがある）
6. ADR-0021（React は表示だけ・状態は小さなストア）、ADR-0022（TEA）、ADR-0023（プラグイン）。**0022・0023 は末尾の「改訂（PL-0）」が今の API の形**。ADR-0024（初回の読み込み、提案）
7. `TaskSheets/REVIEW-architecture-2026-11.md`（構成のレビュー、RF-0〜RF-16）
8. GitHub の PR・Issue に所有者のコメントがあれば、それを最初に読む（`gh pr list --state all`、`gh issue list`）。`gh run list --branch main --limit 3` で main の CI・Pages が緑かも確かめる

### いまの状態（2026-11-21、main `1ef4706`）

- **PL-0 完了**: `src/app/tea.ts`（`createProgram(init, update, { effectFailed, report })`）、`src/plugin-api/`（口は ribbon・dialogs・status・shortcuts・errors・program）、
  `src/core/plugin-host.ts`（アプリが使うキー `APP_SHORTCUT_KEYS` はプラグインに渡さない）、`src/ui/plugins/`（プラグインの UI ごとの Error Boundary）、`src/plugins/builtin.ts`（空）。画面は前と同じ。
  `src/core/adr-shape.test.ts` が ADR の「口の一覧:」の最後の行とコードを突き合わせる（口を足したら ADR の改訂に新しい「口の一覧:」の行を書く）。`src/core/app-shortcut-keys.test.ts` がキーを扱うファイルの一覧を固定する
- **CM 完了**: コードのコメントは 0（`scripts/comment-baseline.json` は `{}`、`npm run check:comments`）。例外は道具の指示と unsafe の前の1行の `// SAFETY:` だけ。
  コメントを消すときの道具: `scripts/removed-comments-near-literals.mjs`、`scripts/removed-comment-reasons.mjs`（`--docs`）。名前は「それが何か」だけ、理由は表、「何が起きるか」を名前に
- **CM-F1 完了**: 設定の「保存領域」の一時ファイルの削除は変換のロックの中で。`src/app` の関数の外の `createStore`・最上位の `let`・`var` は lint が落とす
- **所有者の確認待ち（画面・実機。どれも未確認）**:
  - CM-F1: Web 版で大きな LAS の変換を始め、別のタブで 設定 → 保存領域 → 一時ファイルの「すべて消す」を押し、「変換・ツールの実行中なので消せません」が出て、一時ファイルが残り、変換が最後まで終わること
  - GPU の描画（シェーダーを .wgsl に出した）: `npm run dev` で sofi か autzen を開き、空・グリッド・EDL のオンとオフ、着色の4モード、点の丸と四角、計測のピックを試し、エラーのバナーが出ないこと
  - 開発モードの `pcv://`: `npm run tauri dev` で LAS を開き、点群が出て、開発者ツールに "Failed to fetch" が出ないこと
  - Web 版の保存領域の一覧・「消す」・「すべて消す」が前と同じに動くこと
  - Android のビルド（CI は Windows・Linux だけ）
  - 前からの残り: 平行投影での計測値の一致、EDL の強さ、Y-up のデータでの北、実機のタッチ（`TaskSheets/TP-trendpoint-parity.md`）
- **所有者の判断待ち**: マージ済みのリモートのブランチ（`trendpoint-parity`・`handoff-2026-11-17`・`handoff-2026-11-19`・`handoff-2026-11-21`・`CM-0`〜`CM-5`・`CM-F1`・`PL-0`）とローカルの `backup/trendpoint-parity-before-author` を消してよいか（権限の確認で止まった）

### 次にやること（`PLAN-2026-11.md` の順）

1. **PL-1**: 視点（TP-1）を最初のプラグイン `pcv.view` に移す。受け入れ基準はまだ → メインが `TaskSheets/PL-1-*.md` に書いてから作業役を起こす。AC に入れる前提:
   - PL-0 の PR 監査 F-1: `tea.ts` で update が投げるとキューの Msg が次の dispatch まで残る。扱い（残りを捨てるか、報告して続けるか）を決めてテストで固定
   - N-7: ダイアログを閉じたことをプラグインに知らせる口
   - `APP_SHORTCUT_KEYS` から F・1〜7 を外し、視点のキーはプラグインのショートカットに
   - PLAN の F11: `src/app/view.ts` のモジュールに1つの `viewContext` を解消
   - リボンの enabled（点群が無いときはグレーアウト）とグループ。要る口（`layers` など）は ADR-0023 の改訂に「口の一覧:」の行と一緒に足す
   - 実際のプラグインのボタン・ダイアログを `scripts/ui-shots.mjs` で 375px・1280px で撮る
2. **CM-F**（PL-1 と並行可。触るファイルが重ならないもの）: PLAN の F2（wasm に絶対パスとユーザー名が入る）・F9（変換済みキャッシュの削除もロックの外）を先に。F10・F12 は小さい
3. **RF-2・RF-3**: ツールを `DataSource` に入れ、`src/app` の `instanceof WebSource` の分岐を 0 に
4. **PF-1**: 単一の LAS/LAZ で変換を待たずに下見の点を描く（ADR-0024 の「PF-1 の受け入れ基準の案」）。最初にレンダラの暗黙の約束（ノードの `key` の役割など）を ADR に書く
5. **PF-2**、**PL-2**（TP-2 表示範囲・TP-3 土量）、以降は PLAN の表のとおり

### 守ること（要点。詳細は AGENTS.md・CLAUDE.md）

- 役は4つ: **メイン**（git・gh の操作。push もしてよい＝所有者の許可 2026-11-18）、**作業役**、**ループの監査役**、**PR・CI の監査役**。
  **マージは所有者**。例外: PL-2 までのタスクは PR を作らず、PR・CI の監査役が APPROVE したらメインが main にマージしてよい（マージする版の CI が緑であること）
- レビューの差し戻しは 3 往復まで、総イテレーションは目安 10 回。超えたら・トレードオフ・想定外は、Draft PR（コードが無ければ Issue）で、先頭に「所有者への質問と選択肢」を置いて止まる
- 承認の後は再発防止策（`RECURRENCE.md`）を作り、それも承認してから push
- **コードにコメントを書かない**。TaskSheets・コミット・報告・画面に出る文は日本語。コードの名前・テスト名・内部の不変条件の違反の文は英語
- `npx vitest run` は **大文字の `C:\` から**。Agent の `isolation: worktree` は失敗するので、`git worktree add C:/workspace/pcv-wt-<ID> -b <ID> <ベース>` を手で作る。Rust のビルドは `CARGO_TARGET_DIR=C:/workspace/pcv-cargo-target` で共有できる
- この PC は `core.autocrlf=true`。ファイルを文字列で読むテストは改行を LF にそろえてから読む（PL-0-RP の RP-F1）
- 並行したブランチを順にマージするとき、`eslint.config.js`・`RECURRENCE.md`・`AGENTS.md`・`src/code-limits.test.ts`・`src/layer-rules.test.ts`・ADR の行番号でよく衝突する。付け替え（rebase）の後は `npm run check:all` を通してから push。シートや RECURRENCE に書いたコミットのハッシュは付け替えで変わるので、マージ前に直す
- 同時に動かすエージェントは 2 つ程度にする（6 つ前後だと 5 時間の利用上限にすぐ当たった）。止まったエージェントは新しく起こさず SendMessage で続きを頼む
- 通知音: エージェントが動いている間は `~/.claude/busy/c--workspace/<作業名>-<セッションIDの先頭8文字>` を置き、全部終わったら自分の目印を消す
- 切りの良いところで、このファイル（`TaskSheets/NEXT-SESSION.md`）を書き直して止まる
