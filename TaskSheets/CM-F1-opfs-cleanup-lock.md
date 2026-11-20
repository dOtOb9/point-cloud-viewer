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

### 実装の記録 R1（2026-11-21、作業役）

何をしたか（コミット `2a16563`）:

- 手順を `src/app/scratch-cleanup.ts` の `removeScratchDirsUnlessConverting(ctx, target)` に書いた。`target` は `{ kind: "all" }`（すべて消す）か `{ kind: "one", name }`（その行の消す）。
  `withConversionLock(ctx.lockManager, …)` の中でだけ消し、取れたら保存領域の表示を更新して `"removed"`、取れなければ何も消さずに `"busy"` を返し、どのボタンが止められたかをストア `scratchCleanupBlockedByConversion` に置く。押すたびに最初にストアを空にする
- `src/state/useOpfsStorage.ts` から `removeOpfsScratchDir`・`clearOpfsScratchDirs`（`useCallback` の手順）を消し、代わりに文脈 `scratchCleanupContext`（`navigator.locks`・消す関数・更新の関数・ストア）を組んで返すだけにした。`useCopcViewer.ts`・`viewer-types.ts` はその名前の付け替え
- `src/ui/settings/pages/StorageDialog.tsx` は `src/app/` の関数を直接呼び、`useStore` でストアを読んで、止められたボタンの近く（「すべて消す」なら見出しのすぐ下、「消す」ならその行のすぐ下）に「変換・ツールの実行中なので消せません。終わってからもう一度押してください。」を出す。色は役割の `text-secondary`（橙。ADR-0017）。消せたときの表示は前と同じ
- 消した関数の使い手: `removeOpfsScratchDir`・`clearOpfsScratchDirs` を `grep -rn` で数え、`StorageDialog.tsx` の 2 か所と配線（`useCopcViewer.ts`・`viewer-types.ts`）だけだった。`withConversionLock`・`cleanupStaleScratchDirs`・`removeScratchDirByName` は変えていない

なぜこの形か:

- ロックの名前と `ifAvailable` は、Worker と同じ `withConversionLock` を使うことで揃えた（同じ名前を二か所に書かない）。待つ（`ifAvailable` なし）案は採らなかった。押した後に長い変換の終わりまで黙って待ち、終わった後に消えるのは、利用者に何が起きているか分からないため
- 文言は `scratchCleanupBlockedByConversion` のストアに「どれが止められたか」を置いて、押した場所の近くに出す。画面全体のバナー（ADR-0011）にしなかったのは、エラーではなく「後でもう一度」の案内だから

受け入れ基準ごとの根拠（テストは `src/app/scratch-cleanup.test.ts`）:

| AC | コード | テスト |
|---|---|---|
| AC-1 | `src/app/scratch-cleanup.ts` の `removeScratchDirsUnlessConverting` | "asks for the conversion lock by the same name, only if available"、"removes nothing and reports busy when a conversion holds the lock"、"keeps the named dir when a conversion holds the lock and remembers which button was blocked" |
| AC-2 | `StorageDialog.tsx` の `ScratchCleanupBusyNotice` と `isBlockedCleanupFor` | "remembers which button was blocked"（上）、"clears the busy notice once a later press removes"、`isBlockedCleanupFor` の 2 件。画面は下の「画面で見たこと」 |
| AC-3 | 同上（フックは文脈を組むだけ） | "removes all scratch dirs and refreshes when the lock is free"、"removes only the named scratch dir when the lock is free"、"releases the lock when removing throws, so a later conversion can take it" |
| AC-4 | — | `npm run check:all` が全部 OK（作業報告に一覧）。消したコメントは無い（`node scripts/removed-comment-reasons.mjs 346288c src` → 0 件） |

画面で見たこと（Playwright の Chromium、`npx vite --port 5391` を自分で立てて止めた。台本は作業役の一時フォルダの `shots.mjs`。`scripts/ui-shots.mjs` は点群を開いてから `data-testid` を押す形で、別のタブでロックを持つ手順を書けないため、同じ幅 375px・1280px で別に撮った）:

- 同じオリジンの 2 つ目のタブで `navigator.locks.request("pcv-web-conversion", …)` を持ったまま、OPFS に `pcv-scratch-shot-a`・`pcv-scratch-shot-b` を作り、設定 → 保存領域で「すべて消す」と行の「消す」を押した。
  両方とも残り（スクリプトの出力 `namesWhileBusy: ["pcv-scratch-shot-a","pcv-scratch-shot-b"]`）、文が見出しの下・その行の下に出た。ロックを離してから「すべて消す」を押すと消え（`namesAfter: []`）、文も消えた（`busyNotices: 0`）。375px・1280px とも同じ
- 375px で文は 2 行に折り返し、ダイアログの外にはみ出さない。1280px のダイアログが全体に白っぽく写るのは、変更前の開いた直後の画面（`1280-1-opened.png`）でも同じで、この変更とは関係ない

確かめていないこと（未確認）:

- 実際の変換が走っている最中に押したとき（上はロックを手で持っただけ）。所有者の確認手順: Web 版で大きな LAS の変換を始め、別のタブで 設定 → 保存領域 → 一時ファイルの「すべて消す」を押す。押した近くに「変換・ツールの実行中なので消せません。…」が出て、一時ファイルが残り、変換が最後まで終わること。変換が終わってからもう一度押すと消えること
- デスクトップ版・Android は保存領域の画面を出さない（`isBrowser` のときだけ）ので対象外

### 実装の記録 R2（2026-11-21、作業役。監査 R1 の指摘への対応）

コミット `f613f87`。

- F-1（文が実際の状態より長く残る）: 直した。
  - 止められた記録は、押すたび（R1 から）に加えて、保存領域を開いたとき（`SettingsModal.tsx` の開いたときの読み直しを `refreshStorageAndForgetBlockedCleanup` に替えた）と「更新」を押したときにも忘れるようにした
  - 「すべて消す」の文は、ボタンと同じ「一時ファイルが 1 件以上」の条件のときだけ出す。行の文は、その行があるときだけ出る（R1 から）
  - テスト: "forgets the busy notice when the storage page is opened again after the conversion ended"、"forgets the busy notice of a row when the list is refreshed"
- F-2（ストアがモジュールに 1 つ）: 直した。`scratchCleanupBlockedByConversion` を消し、`createBlockedCleanupStore()` を `useOpfsStorage` の `useState` の初期化で呼んで、ビューアごとに作る。
  文脈は `useMemo` で組み、依存（`refreshOpfsStorageInfo`・`reportError`・ストア）はどれも作り直されないので、文脈も描画ごとに変わらない（開いたときの effect の依存に使うため）。
  テスト: "keeps the busy notice of one viewer out of another viewer"
- F-3（消すのに失敗したとき何も出ない）: 直した。`removeScratchDirsUnlessConverting` が失敗を受け止め、`reportError("一時ファイルを消せませんでした: …", "conversion")` で既存のエラー表示（ADR-0011）に流し、`"failed"` を返す。
  種類は `"conversion"`（変換エラー）にした。`GpuErrorSource` に保存領域の種類を足すには `src/renderer/gpu-error-log.ts` と `src/ui/dialogs/ErrorDialog.tsx` を触ることになり、このシートの範囲の外のため。
  テスト: "shows a failure to remove in the error log instead of dropping it"、"releases the lock when removing throws, so a later conversion can take it"（失敗しても投げずに `"failed"` を返す形に合わせた）
- 変えた共有の関数の使い手: `useOpfsStorage` は引数に `reportError` を取るようになり、呼び手は `useCopcViewer.ts` の 1 か所（`grep -rn "useOpfsStorage(" src`）。`refreshOpfsStorageInfo` は消していない（`open-files.ts` の変換後の読み直しが使う）

画面で見たこと（R1 と同じ台本を (a)(b) の手順を足して撮り直した。`npx vite --port 5391` を自分で立てて止めた）:

- 375px・1280px とも、スクリプトの出力は `namesWhileBusy` 2 件、`noticesAfterReopen: 0`、`noticesAfterRefresh: 0`、`namesAfter: []`、`noticesAtEnd: 0`
- (b) 止められた後にロックを離し、「戻る」→「保存領域」で開き直すと文は出ない（`*-5-reopened-after-conversion.png`）
- (a) 止められた後に、別のタブが一時ファイルを片付けてロックを離し、「更新」を押すと、一覧は「無し」で文も出ない（`*-6-refreshed-after-conversion-cleaned-up.png`）
- 止められたときの文の位置は R1 と同じ（`375-3-remove-one-busy.png` で行の下に 2 行で出て、はみ出さない）

確かめていないこと（未確認）: R1 と同じ（実際の変換中に押す確認は所有者の手順のとおり）。消すのに失敗したときのエラー表示は、画面では出していない（失敗させる手段が無いため。テストだけ）

### 監査の記録

| ラウンド | 監査役 | 判定 | 主な指摘 |
|---|---|---|---|
| R1 | ループ | CHANGES_REQUESTED | ロックの外で消す所は残っていない（grep）。F-1 [must]「消せません」の文が実際の状態より長く残る（変換が終わって一覧が空でも残る、開き直しても残る）。F-2 [should] ストアがモジュールに1つ。F-3 [nit] 消すのに失敗しても画面に出ない |
| R2 | ループ | APPROVE | 全部直った（開いたとき・更新で忘れる、ストアはビューアごと、失敗はエラーのログへ）。F-4 [nit] 失敗が「変換エラー」の見出しで出る（範囲外、後のタスクへ）。構成の負債: 変換済みキャッシュの削除もロックの外 |
| RP R1 | ループ | CHANGES_REQUESTED | `src/app` のモジュールの状態を落とす lint が `as`・オブジェクトの中・`export default`・名前空間・別名ですり抜ける（赤のテスト5件）。テストのファイルを誤って落とす |
| RP R2 | ループ | APPROVE | 関数の外の `createStore` を書き方によらず落とし、テストのファイルは層の規則だけ。残る限界（`viewContext` など）は RECURRENCE に |
| PR | PR・CI | （この後） | |
