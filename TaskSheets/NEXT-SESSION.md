# 次のセッション用のプロンプト（2026-11-19 に前のセッションが書いた）

下の「プロンプト」をそのまま新しいセッションに貼る。前のセッションのサブエージェントには続きを頼めないので、必要な文脈はこのファイル・タスクシート・PLAN に置いてある。

---

## プロンプト

あなたは `C:\workspace\point-cloud-viewer`（GitHub `dOtOb9/point-cloud-viewer`、public）の**メイン（制御役）**です。判定はしない（ループの監査役・PR・CI の監査役というサブエージェントが出す。AGENTS.md「登場するもの」）。
目標は「TREND-POINT のような品質の良い点群ビューア」。所有者は日本語で話す。返答も日本語。

### 最初に読む（この順）

1. `CLAUDE.md`（全エージェント共通の決まり。正本。**コードにコメントを書かない**決まりが 2026-11-17 に入った）
2. `AGENTS.md`（作業役／監査役のループ、承認の後の再発防止策、push・CI・PR、差し戻しの上限とエスカレーション。作業役の決まりに CM で足した道具の行がある）
3. `TaskSheets/PLAN-2026-11.md`（順番と状態、所有者の決定、「CM で見つかった後のタスク」F1〜F8、判定の記録）
4. `TaskSheets/RECURRENCE.md`（再発防止の台帳。CM-0〜5 の節が新しい）
5. `TaskSheets/REVIEW-architecture-2026-11.md`（構成のレビュー A-1〜A-18、リファクタリングの計画 RF-0〜RF-16）
6. ADR-0021（React は表示だけ・状態は小さなストア）、ADR-0022（TEA）、ADR-0023（プラグイン・外部プラグインと権限）、ADR-0024（初回の読み込み、提案）
7. GitHub の PR・Issue に所有者のコメントがあれば、それを最初に読む（`gh pr list --state all`、`gh issue list`）

### いまの状態（2026-11-19）

- **CM（コードのコメントを消す）が完了して main にマージ済み**（main `7725a37`。CI・Pages はマージ後に走っている。最初に `gh run list --branch main --limit 2` で緑か確かめる）
  - 所有者の指示（2026-11-17）「コメントをできる限り書かないで。あったら削除しよう。コードから類推できるようにして」
  - CM-0: `scripts/check-comments.mjs`（`npm run check:comments`、check:all と CI）。`scripts/comment-baseline.json` は `{}`（もう 1 つもコメントを足せない）。例外は道具の指示と unsafe の前の1行の `// SAFETY:` だけ（CLAUDE.md）
  - CM-1〜5: renderer・datasource・app/ui/state/scripts/設定・pcv-core/pcv-wasm・pcv-convert/src-tauri のコメントを全部消し、理由は名前・テスト・各シートの「移した理由の記録」の表へ。シェーダーは `src/renderer/shaders/*.wgsl`（`?raw`）に出した
  - 再発防止で入った道具（AGENTS.md の作業役の決まり）: `scripts/removed-comments-near-literals.mjs`（消したコメントの近くに残った名前の無い数値）、`scripts/removed-comment-reasons.mjs`（消したコメントのうち理由を書いたもの、`--docs` で古くなった文書）。名前は「それが何か」だけ、理由は表、「何が起きるか」を名前に
- **所有者の確認待ち（画面・実機。どれも未確認）**:
  - GPU の描画（CM-1 でシェーダーを .wgsl に出した）: `npm run dev` で sofi か autzen を開き、空・グリッド・EDL のオンとオフ、着色の4モード、点の丸と四角、計測のピックを試し、エラーのバナーが出ないこと
  - 開発モードの `pcv://`（CM-5 で CORS のヘッダを関数に出した）: `npm run tauri dev` で LAS を開き、点群が出て、開発者ツールに "Failed to fetch" が出ないこと
  - Web 版の OPFS の後始末（CM-2）: Web 版で LAS を変換し、設定の「保存領域」で一覧・「消す」・「すべて消す」が前と同じに動くこと
  - Android のビルド（CM-5 の `cfg` の分岐。CI は Windows・Linux だけ）
  - 前からの残り: 平行投影での計測値の一致、EDL の強さ、Y-up のデータでの北、実機のタッチ（`TaskSheets/TP-trendpoint-parity.md`）
- **所有者の判断待ち**: マージ済みのリモートのブランチ（`trendpoint-parity`・`handoff-2026-11-17`・`CM-0`〜`CM-5`）とローカルの `backup/trendpoint-parity-before-author` を消してよいか（2026-11-17 に消そうとして権限の確認で止まった）

### 次にやること（`PLAN-2026-11.md` の順）

1. **PL-0**: `src/app/tea.ts`（`createProgram`、ADR-0022）と `src/plugin-api/`・`src/core/plugin-host.ts`・`src/plugins/builtin.ts`（ADR-0023）。リボン・ダイアログ・ステータス・ショートカット・エラー境界。組み込みは空で、殻は今と同じに見える。
   受け入れ基準はまだ書いていない → メインが `TaskSheets/PL-0-*.md` に書いてから作業役を起こす。新しいコードはコメント無しで書く（`check:comments` が落とす）
2. **CM-F**（PL-0 と並行可。触るファイルが重ならないものから）: PLAN の「CM で見つかった後のタスク」F1〜F8。F1（OPFS の掃除がロックの外）と F2（wasm に絶対パスとユーザー名が入る）を先に
3. **RF-2・RF-3**: ツールを `DataSource` に入れ、`src/app` の `instanceof WebSource` の分岐を 0 に
4. **PL-1**: 視点（TP-1）を最初のプラグイン `pcv.view` に
5. **PF-1**（PL-1 と並行可）: 単一の LAS/LAZ で変換を待たずに下見の点を描く（ADR-0024 の「PF-1 の受け入れ基準の案」）。最初にレンダラの暗黙の約束（ノードの `key` の5つの役割など）を ADR に書く
6. **PF-2**、**PL-2**（TP-2 表示範囲・TP-3 土量）、以降は PLAN の表のとおり

### 守ること（要点。詳細は AGENTS.md・CLAUDE.md）

- 役は4つ（AGENTS.md「登場するもの」）: **メイン**（制御役。git・gh の操作、push もしてよい＝所有者の許可 2026-11-18）、**作業役**、**ループの監査役**、**PR・CI の監査役**。
  **マージは所有者**。例外: PL-2 までのタスクは PR を作らず、PR・CI の監査役が APPROVE したらメインが main にマージしてよい（マージ前の CI が緑であること）
- レビューの差し戻しは 3 往復まで、総イテレーションは目安 10 回。超えたら・トレードオフ・想定外は、Draft PR（コードが無ければ Issue）で、先頭に「所有者への質問と選択肢」を置いて止まる
- 承認の後は再発防止策（`RECURRENCE.md`）を作り、それも承認してから push
- **コードにコメントを書かない**。TaskSheets・コミット・報告は日本語。コードの名前・テスト名・エラーメッセージは英語
- `npx vitest run` は **大文字の `C:\` から**。Agent の `isolation: worktree` は失敗するので、`git worktree add C:/workspace/pcv-wt-<ID> -b <ID> <ベース>` を手で作る。Rust のビルドは `CARGO_TARGET_DIR=C:/workspace/pcv-cargo-target` で共有できる
- 並行したブランチを順にマージするとき、`scripts/comment-baseline.json`・`RECURRENCE.md`・`AGENTS.md`・`src/code-limits.test.ts`・ADR の行番号でよく衝突する。付け替え（rebase）の後は `npm run check:all` と check:docs を通してから push。シートや RECURRENCE に書いたコミットのハッシュは付け替えで変わるので、マージ前に直す
- 並列で 6 つ前後のエージェントを動かすと 5 時間の利用上限にすぐ当たる（CM の間に 4 回）。止まったエージェントは新しく起こさず SendMessage で続きを頼む
- 通知音: エージェントが動いている間は `~/.claude/busy/c--workspace/<作業名>-<セッションIDの先頭8文字>` を置き、全部終わったら自分の目印を消す
- 切りの良いところで、このファイル（`TaskSheets/NEXT-SESSION.md`）を書き直して止まる
