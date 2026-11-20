# PL-0: TEA の `createProgram` と、プラグインの API・ホストの土台

- 元: [ADR-0022](./ADR-0022-tea-architecture.md)（TEA）、[ADR-0023](./ADR-0023-plugins.md)（プラグイン）の段階 PL-0
- 次: PL-1（視点 `pcv.view` を最初のプラグインに）。PL-0 では組み込みのプラグインは**空**のまま、画面は今と同じに見える
- 方針: 既存の機能は動かさない（移すのは PL-1 以降）。コードにコメントを書かない（CLAUDE.md）。push しない

## いまの形（メインが読んで確かめたこと）

- リボンは `src/ui/toolbar/Toolbar.tsx` にボタンが手で並び、開くダイアログは `src/ui/shell/AppShell.tsx` の `useState` で持つ
- ダイアログの枠は `src/ui/dialogs/Dialog.tsx`（`placement` は `center`・`side`、Escape・フォーカスの扱いあり）
- ステータスバーは `src/ui/status/StatusBar.tsx`、エラーは `src/state/useErrorLog.ts` の `reportError(message, source?)` が `ErrorDialog` とログに流す
- キーの判定は `src/app/typing-target.ts`（害の無いキーは `isTypingTarget`、消す・確定するキーは `isFormControl`。AGENTS.md）
- `eslint.config.js` には `src/plugins/**` の import の規約が既にある（`src/plugin-api`・自分のフォルダ・`react`・`lucide-react`・`src/ui/kit` だけ）。`src/core/`・`src/plugin-api/` の規約はまだ無い

## 範囲

触ってよい: `src/app/tea.ts`（新規）、`src/plugin-api/`（新規）、`src/core/`（新規）、`src/plugins/builtin.ts`（新規）、`src/ui/plugins/`（新規。ホストに登録された物を描く React の部品）、
`src/ui/shell/AppShell.tsx`・`src/ui/toolbar/Toolbar.tsx`・`src/ui/status/StatusBar.tsx`（ホストの描き場所を差し込むだけ）、`eslint.config.js`・`src/layer-rules.test.ts`、`TaskSheets/ARCHITECTURE.md`、このシートの記録。
触らない: 既存の機能（計測・断面・ツール・視点など）の配線、`src/state/useOpfsStorage.ts`（CM-F1 が並行して触る）

## 受け入れ基準

- **AC-1 `src/app/tea.ts`**: ADR-0022 の `createProgram(init, update, …)` が `getModel`・`dispatch`・`subscribe` を返す。ライブラリは足さない。テストで次を固定する:
  1. `update` が返した効果が、返した順に走る
  2. 効果の中で `dispatch` した Msg が、次の `update` に届く（同期の効果と、`await` の後の効果の両方）
  3. 効果の例外（同期の throw と、Promise の reject の両方）を黙って捨てず、プログラムを作るときに渡した「失敗を Msg に変える関数」で Msg として `update` に戻す
  4. `subscribe` の購読者は Model が変わったときだけ呼ばれ、購読を外すと呼ばれない。`dispatch` の途中で `dispatch` しても順番が崩れない（処理中の Msg の後に並ぶ）
- **AC-2 `src/plugin-api/`**: ADR-0023 の `PcvPlugin`（`id`・`name`・`apiVersion: 1`・`activate(host)` が後片付けを返せる）と `PluginHost` の型を置く。
  PL-0 で実装するのは `ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`program` だけ。`layers`・`tools`・`view`・`units`・`settings` は型にも入れない（使えない口を見せない。PL-1 以降で、使う機能と一緒に足す）。
  `src/plugin-api/` は型と小さな関数だけで、`src/ui`・`src/state`・`src/renderer`・`src/datasource`・React を import しない
- **AC-3 `src/core/plugin-host.ts`**: プラグインの一覧を受け取って順に `activate` し、登録された物（リボンの項目・ステータスの項目・ショートカット・開いているダイアログ）を、React に依存しないストアとして持つ。
  1. `activate` が例外を投げたプラグインは止め（登録しかけた物を残さない）、`errors.report` に流して、他のプラグインは続けて読み込む
  2. 知らない `apiVersion` のプラグインは読み込まず、理由（プラグインの id と版）を `errors.report` に流す
  3. 同じ `id` のプラグイン、同じキーのショートカットを2度登録しようとしたら、先のものを残して後のものをエラーとして報告する
  4. ショートカットは、登録するときに「害が無い（`isTypingTarget` で止める）」か「消す・確定する（`isFormControl` で止める）」かを選ばせ、判定はホストが `src/app/typing-target.ts` で行う（プラグインは判定を書かない）
  5. 後片付け（`activate` の戻り値）を呼ぶ口があり、呼ぶとそのプラグインの登録が全部消える
  6. それぞれをテストで固定する（React も DOM も無しで、偽のプラグインで）
- **AC-4 描画（`src/ui/plugins/`）**: ホストのストアを `useSyncExternalStore` で読み、リボンの項目を `Toolbar.tsx` の決まった位置に、ステータスの項目を `StatusBar.tsx` に、ダイアログを既存の `Dialog` の枠で描く。
  ショートカットは `window` の `keydown` を1つだけ登録してホストに渡す。**プラグインの UI ごとに Error Boundary** を置き、描画の例外はそのプラグインの UI だけを消して `errors.report` に流す（アプリは落ちない）。
  jsdom のテストで、偽のプラグインのボタンが出る・押すとダイアログが開く・描画で投げてもほかが残りエラーが報告される、を確かめる
- **AC-5 エラーの行き先**: ホストの `errors.report(source, error)` は、既存の `reportError` に本文のまま流れ、今の `ErrorDialog` とログに出る（ADR-0011・ADR-0015）。新しいバナーを作らない
- **AC-6 組み込みは空**: `src/plugins/builtin.ts` は空の配列。今の画面（リボンのボタン・ステータスバー・ダイアログ）は見た目も `data-testid` も変わらない。
  `node scripts/ui-shots.mjs` で、作業の前と後を幅 375px・1280px で撮って見比べ、画像のパスと所見を報告に書く。E2E の `data-testid`（CLAUDE.md の表）は変わらない
- **AC-7 層の規約**: `eslint.config.js` に、`src/plugin-api/**` が React・`src/ui`・`src/state`・`src/renderer`・`src/datasource` を import しないこと、`src/core/**` が React・`src/ui`・`src/state` を import しないことを足し、
  `src/layer-rules.test.ts` に破る形（import・export-from・動的 `import()`・型の `import()`）のケースを置く。`npm run check:circular` も通る
- **AC-8 文書**: `TaskSheets/ARCHITECTURE.md` のディレクトリの図と「これから」の節を、今あるもの（`src/app/tea.ts`・`src/plugin-api/`・`src/core/`・`src/plugins/`・`src/ui/plugins/`）に合わせる（`npm run check:docs`）
- **AC-9** `npm run check:all` が全部 OK。新しいファイルにコメントが無い（`check:comments`）。800 行の上限（`code-limits.test.ts`）

## 確かめ方

- 上の各テストの名前と `npm run check:all` の一覧、`node scripts/check-task-sheet.mjs <ループ開始前のコミット>`
- AC-6 の撮った画像のパスと所見（WebGPU の描画がヘッドレスで出ないときは、描画以外の UI だけを見て描画は「未確認」と書く）

## 記録

（作業エージェントが足す）
