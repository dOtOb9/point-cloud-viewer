# CM-F1: 設定画面からの一時ディレクトリの削除を、変換のロックの中で行う

- 元: CM-2 のループの監査 R1 の「構成の負債」（`PLAN-2026-11.md` の「CM で見つかった後のタスク」F1）
- 方針: 振る舞いを安全な側に寄せるだけ。コードにコメントを書かない。push しない

## 問題（メインが読んで確かめたこと）

- Worker の変換・ツールは `src/datasource/opfs.ts` の `withConversionLock`（`navigator.locks` の `ifAvailable`）の中で一時ディレクトリを作って使う（`src/datasource/copc.worker.ts` の 486・640・826・959・1056・1248 行）
- 設定の「保存領域」の「すべて消す」（`src/state/useOpfsStorage.ts` の `clearOpfsScratchDirs` → `cleanupStaleScratchDirs()`）と「消す」（`removeOpfsScratchDir` → `removeScratchDirByName`）は、このロックを取らずに消す
- そのため、別のタブ（または同じタブの Worker）が変換を始めた直後に押すと、使っている途中の一時ディレクトリを消しうる（推定、未検証。消した後の変換がどう失敗するかも未確認）

## 範囲

触ってよい: `src/state/useOpfsStorage.ts`、`src/datasource/opfs.ts`（ロックの関数の再利用に要る分だけ）、新しい `src/app/` の関数とテスト、設定の「保存領域」の表示（`src/ui/settings/` の該当の部品）、このシートの記録。
触らない: `src/ui/shell/`・`src/ui/toolbar/`・`src/ui/status/`（PL-0 が並行して触る）

## 受け入れ基準

- **AC-1** 「すべて消す」「消す」は、変換と同じロック（`withConversionLock` と同じ名前・`ifAvailable`）を取れたときだけ消す。取れなかったら何も消さない
- **AC-2** 取れなかったとき、利用者に「変換・ツールの実行中なので消せません。終わってからもう一度押してください」に当たる文が、押した場所の近くに出る（黙って何もしない、にしない）。消せたときの今の表示は変えない
- **AC-3** 手順は `src/app/` の普通の関数に書き（ADR-0021。フックに新しいロジックを足さない）、偽のロックの管理者（`LockManagerLike`）で「取れた → 消す関数が呼ばれる」「取れない → 呼ばれず、取れなかったことが返る」をテストで固定する。消す関数が投げたときにロックが離されることも
- **AC-4** `npm run check:all` が全部 OK。消したコメントや増えた数値は無い（新しいコードにコメントを書かない）

## 確かめ方

- 上のテストの名前、`npm run check:all` の一覧、`node scripts/check-task-sheet.mjs <ループ開始前のコミット>`
- ブラウザでの確認は「未確認」とし、所有者の確認手順を記録に書く（Web 版で大きな LAS の変換を始め、別のタブの設定で「すべて消す」を押して、消せない旨が出て変換が最後まで終わること）

## 記録

（作業エージェントが足す）
