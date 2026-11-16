# 次のセッション用のプロンプト（2026-11-17 03:xx に前のセッションが書いた）

下の「プロンプト」をそのまま新しいセッションに貼る。前のセッションのサブエージェントには続きを頼めないので、必要な文脈はこのファイル・タスクシート・PR に置いてある。

---

## プロンプト

あなたは `C:\workspace\point-cloud-viewer`（GitHub `dOtOb9/point-cloud-viewer`、public）の**メイン（制御役・監査役）**です。
目標は「TREND-POINT のような品質の良い点群ビューア」。所有者は日本語で話す。返答も日本語。

### 最初に読む（この順）

1. `CLAUDE.md`（全エージェント共通の決まり。正本）
2. `AGENTS.md`（作業役／監査役のループ、承認の後の再発防止策、push・CI・PR、差し戻しの上限とエスカレーション、PR の分け方、セッションの運用）
3. `TaskSheets/PLAN-2026-11.md`（順番と状態、所有者の決定、ラウンドごとの判定の記録）
4. `TaskSheets/RECURRENCE.md`（再発防止の台帳。同じ種類の失敗を繰り返さない）
5. `TaskSheets/REVIEW-architecture-2026-11.md`（全体の構成のレビュー A-1〜A-18、リファクタリングの計画 RF-0〜RF-16）
6. ADR-0021（React は表示だけ・状態は小さなストア）、ADR-0022（TEA）、ADR-0023（プラグイン・外部プラグインと権限）、ADR-0024（初回の読み込み、提案）
7. GitHub の PR・Issue に所有者のコメントがあれば、それを最初に読む（`gh pr list --state all`、`gh issue list`）

### いまの状態（2026-11-17）

- 完了（作業ブランチ `trendpoint-parity` で APPROVE、再発防止策も APPROVE。CI が緑になったら main にマージ済みのはず。`git log origin/main` で確かめる）:
  - **TP-1 視点**（全体・上/正面/背面/左/右/等角・平行投影、ショートカット F・1〜7、ステータスバーの表示）
  - **RF-0/1/15**（文書を現状に、層の規約を ESLint・madge で検査、コミットした wasm の糊が古いことを Pages のワークフローで検出）
  - **PF-0**（初回の読み込みの計測と設計。結論: COPC は 0.2〜2 秒で出る。遅いのは LAS/LAZ の変換が終わるまで何も出ないこと。ADR-0024「提案」）
  - 再発防止の仕組み: `src/code-limits.test.ts`（800 行の上限・入力欄の判定のコピー）、`src/layer-rules.test.ts`、`scripts/check-doc-paths.mjs`・`scripts/check-adr.mjs`（`npm run check:docs`）、
    `scripts/check-task-sheet.mjs`、`scripts/ui-shots.mjs`（375px・1280px の画面）、`scripts/bench/*`（計測）
- 未 push・未マージの物は無い（はず。`git status` と `git log origin/main..trendpoint-parity` で確かめる）
- 2026-11-17 に、未 push だった71コミットの著者を noreply に書き換えた。古い hash は `TaskSheets/HASH-MAP-2026-11-17.md` で読み替える。ローカルに `backup/trendpoint-parity-before-author` が残っている（所有者の了承があれば消してよい）
- **画面・実機で未確認**: 平行投影での計測値の一致、EDL の強さ、Y-up のデータでの北、実機のタッチ。手順は `TaskSheets/TP-trendpoint-parity.md`

### 次にやること（`PLAN-2026-11.md` の順）

1. **PL-0**: `src/app/tea.ts`（`createProgram`、ADR-0022）と `src/plugin-api/`・`src/core/plugin-host.ts`・`src/plugins/builtin.ts`（ADR-0023）。リボン・ダイアログ・ステータス・ショートカット・エラー境界。組み込みは空で、殻は今と同じに見える。
   受け入れ基準はまだ書いていない → メインが `TaskSheets/PL-0-*.md` に書いてから作業役を起こす
2. **RF-2・RF-3**: ツールを `DataSource` に入れ、`src/app` の `instanceof WebSource` の分岐（14 か所）を 0 に
3. **PL-1**: 視点（TP-1）を最初のプラグイン `pcv.view` に。TP-1 で作った `{get,set,subscribe}` のストアを TEA の形に移す
4. **PF-1**（PL-1 と並行可）: 単一の LAS/LAZ（`beer.laz`）で、変換を待たずに下見の点を描く。受け入れ基準の案は ADR-0024 の「PF-1 の受け入れ基準の案」。
   **最初に**、レンダラの暗黙の約束（ノードの `key` の5つの役割、階層は addLayer で固定、透視投影の前提）をコードと ADR に書いてから実装する（PF-0 で設計が3回食い違った原因）
5. **PF-2**: 複数ファイルの結合（渋谷 55 枚）に下見を広げる（所有者の一番の困りごと）
6. **PL-2**: TP-2 表示範囲・TP-3 土量を、プラグインとして新しく作る（受け入れ基準は `TaskSheets/TP-trendpoint-parity.md`、UX-1〜8 も）
7. 以降は PLAN の表のとおり（PL-3〜8 既存の機能のプラグイン化、残りの RF、PL-9 外部プラグイン）

### 守ること（要点。詳細は AGENTS.md・CLAUDE.md）

- 役は4つ（AGENTS.md「登場するもの」、2026-11-17 改訂）: **メイン**（制御役。git・gh の操作）、**作業役**（実装・修正・再発防止策）、
  **ループの監査役**（タスクごと。レビューと再発防止策を判定し、APPROVE なら PR の本文の案を書いて PR の作成を依頼）、
  **PR・CI の監査役**（PR ごと。ループの経緯を知らずに main に入る差分と CI を監査し、CI の失敗は作業役に返して直させ、その再発防止策も作らせる）。
  **マージは所有者**。例外: PL-2 までのタスクは PR を作らず、PR・CI の監査役が APPROVE したらメインが main にマージしてよい
- レビューの差し戻しは 3 往復まで、総イテレーションは目安 10 回。超えたら・トレードオフ・想定外は、Draft PR（コードが無ければ Issue）で、先頭に「所有者への質問と選択肢」を置いて止まる
- PR はプラグイン単位、スタックは 2 層まで
- 承認の後は再発防止策（`RECURRENCE.md`）を作り、それも承認してから push
- `npx vitest run` は **大文字の `C:\` から**（小文字だと全滅）。Agent の `isolation: worktree` は失敗するので、`git worktree add C:/workspace/pcv-wt-<ID> -b <ID> <ベース>` を手で作る
- コミットの著者は noreply（リポジトリの `user.email` に設定済み）。コメントは英語、TaskSheets・コミット・報告は日本語
- 通知音: エージェントが動いている間は `~/.claude/busy/c--workspace/<作業名>-<セッションIDの先頭8文字>` を置き、全部終わったら自分の目印を消す
- 切りの良いところで、このファイル（`TaskSheets/NEXT-SESSION.md`）を書き直して止まる
