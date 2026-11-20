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

### 実装の記録 R1

#### やったこと

- **AC-1** `src/app/tea.ts`: `createProgram(init, update, effectFailed)` が `getModel`・`dispatch`・`subscribe` を返す（59 行、ライブラリ無し）。
  `dispatch` は Msg を列に積み、処理中でなければ列が空になるまで「`update` → Model が変わったら購読者を呼ぶ → 効果を返した順に走らせる」を繰り返す。
  効果の中・購読者の中の `dispatch` は列の後ろに並ぶので、処理中の Msg の効果が全部走ってから次の Msg に進む。
  効果の同期の throw と Promise の reject は `effectFailed(error)` で Msg にして `dispatch` する。テストは `src/app/tea.test.ts`（11 件）
- **AC-2** `src/plugin-api/index.ts`: `PcvPlugin`・`PluginHost`（`ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`program` だけ）、`PLUGIN_API_VERSION = 1`、TEA の型の再輸出。
  React を import しないので、描く物の型は `ViewNode`（ReactNode と互換になる広い型）、アイコンは `IconComponent`（lucide のアイコンを受け取る `object`）にした
- **AC-3** `src/core/plugin-host.ts`: `createPluginHost({ reportError })` が、プラグインごとに id を閉じ込めた `PluginHost` を渡して順に `activate` し、
  登録された物（`ribbon`・`status`・`dialogs`・`shortcuts`）を `src/app/store.ts` の `createStore` で持つ。
  `activate` の例外 → そのプラグインの登録を全部消して報告、他は続ける／知らない `apiVersion` → 読み込まずに id と版を報告／同じ id・同じキー → 先を残して後を報告／
  `deactivate(id)` → 後片付けを呼び、登録を全部消す（後片付けの例外も報告）。止まったプラグインが後から登録しようとしても無視する。
  ショートカットは `kind: "harmless"`（`isTypingTarget` で止める）か `"irreversible"`（`isFormControl` で止める）を登録時に選ばせ、判定は `shortcutBlockedByFocus` がする。
  Ctrl・Meta・Alt つき、キーの繰り返し、IME の変換中は反応しない（`src/app/view.ts` の `viewActionForKey` と同じ）。1文字のキーは大文字・小文字を同じに扱う（`sameShortcutKey`。視点のキーと同じ）。
  テストは `src/core/plugin-host.test.ts`（20 件、React も DOM も無し）
- **AC-4** `src/ui/plugins/`: `usePluginHost(plugins, reportError)` がホストを1つ作り、`useEffect` で `activate`／アンマウントで `deactivateAll`、`window` の `keydown` を1つだけ登録してホストに渡す。
  `PluginRibbonItems`（既存の `ToolbarButton` で描く）・`PluginStatusItems`・`PluginDialogs`（既存の `Dialog` の枠）が `useSyncExternalStore` でホストを読む。
  リボンの項目1つ・ステータスの項目1つ・ダイアログの中身1つごとに `PluginErrorBoundary` を置き、描画の例外はその部分だけを消して `host.report(pluginId, error)` に流す。
  テストは `src/ui/plugins/plugin-ui.test.tsx`（jsdom、8 件）
- **AC-5**: `errors.report(source, error)` は `reportError("<source>: <error.message>", "tool")` に流れる（`pluginErrorMessage`）。本文は変えず、前に source（プラグインの id）を付ける。新しいバナーは作っていない
- **AC-6**: `src/plugins/builtin.ts` は空の配列。描き場所は `Toolbar.tsx`（「開く」の次の区切りの後、「視点」の前）、`StatusBar.tsx`（「ログ」の前）、`AppShell.tsx`（`ToolProgressDialog` の後に `PluginDialogs`）。
  空のときは何も描かない（テスト "renders nothing in the slots when no plugin is registered"）。既存の `data-testid` は変えていない（`git diff 346288c -- src | grep data-testid` に出るのは新しいテストの中だけ）
- **AC-7** `eslint.config.js`: `src/plugin-api/**` は React・`ui`・`state`・`renderer`・`datasource` を、`src/core/**` は React・`ui`・`state` を import しない（JSX も不可。正規化していないパスも不可）。
  `src/layer-rules.test.ts` の "PL-0: src/plugin-api and src/core" に import・export-from・動的 `import()`・型の `import()` の形を置いた。`npm run check:circular` は OK
- **AC-8** `TaskSheets/ARCHITECTURE.md`: ディレクトリの図に `src/plugin-api`・`src/core`・`src/plugins`・`src/ui/plugins`・`tea.ts` を足し、「これから」を「PL-0 で入った物」と残りの将来の形に分けた。
  `scripts/check-doc-paths.mjs` の `NOT_BUILT_YET` は「できたら外せ」と落ちるので、できた4つを外して `src/ui/kit` だけにした（範囲の一覧に無いファイルだが、AC-8 の `check:docs` を通すのに要る）

#### 決めたこと（API の形）と採らなかった案

- **`createProgram` の3つ目の引数 `effectFailed`**: ADR-0022 の形は2引数だが、AC-1 の3が「作るときに渡した失敗を Msg に変える関数」を求めるので足した。
  `PluginHost.program` も同じ3引数でそのまま `createProgram` に渡す。採らなかった案: ホストが効果の失敗を自動で `errors.report` に流す（Msg に戻すか報告するかが二重になり、どちらが起きるか読みにくい）
- **ショートカットは `add({ key, label, kind, run })` の1つのオブジェクト**: ADR の `add(key, label, run)` に AC-3 の4の種類が加わり、位置の引数が4つになるので名前つきにした
- **描く物の型 `ViewNode`・`IconComponent`**: AC-2 で plugin-api は React を import できない（型も）。`ReactNode` の代わりに広い型を置き、`src/ui/plugins` が `ReactNode`・`LucideIcon` として描く。
  誤った物を渡されたら描画で投げ、Error Boundary が受け止める。採らなかった案: アイコンを名前の文字列にしてホストが lucide から引く（全アイコンを読み込む表が要り、束ねたファイルが大きくなる。外部のプラグインの宣言の形は PL-9a で決める）
- **リボンの `enabled` の条件・グループは入れていない**: 「点群があるか」を知る口（`layers`）がまだ無く、PL-0 では使い手がいない（使えない口を見せない）。PL-1 で視点を移すときに `layers` と一緒に足す
- **ステータスの項目は `render()`**: 表示が変わる項目は、プラグインが自分の React の部品で自分のプログラムを読む。ホストは並べるだけ
- **エラーの source は既存の `"tool"`（ErrorDialog の見出し「点群ツール」）**: `GpuErrorSource` に `"plugin"` を足すと `src/renderer/gpu-error-log.ts`・`ErrorDialog.tsx` に触る（範囲外）。どのプラグインかは本文の頭の id で分かる。見出しを分けるなら別のタスクで
- **ユーザーに見える報告文は日本語**（「apiVersion 2 に対応していないので読み込みませんでした」など）: `ErrorDialog` に出る既存の文（`raster-window.ts` など）が日本語なのに合わせた
- **`PluginErrorBoundary` はクラス**: React の Error Boundary はクラスの部品でしか書けない（フックの API が無い）。状態は `failed` 1つだけ
- **ダイアログは閉じるとすぐ消える**（`Dialog` の閉じるアニメーションは出ない）: 開いている一覧から外すと部品ごと消えるため。PL-1 で見た目が気になれば、閉じる途中の状態を持たせる
- **ホストは `usePluginHost` の `useState` の初期化で作り、`activate` は `useEffect` でする**: StrictMode で効果が2回走っても、`deactivateAll` → `activate` で元に戻る（テスト "deactivateAll lets the same plugins be activated again"）

#### 触ったファイル

新規: `src/app/tea.ts`・`tea.test.ts`、`src/plugin-api/index.ts`、`src/core/plugin-host.ts`・`plugin-host.test.ts`、`src/plugins/builtin.ts`、
`src/ui/plugins/`（`usePluginHost.ts`・`PluginErrorBoundary.tsx`・`PluginView.tsx`・`PluginRibbonItems.tsx`・`PluginStatusItems.tsx`・`PluginDialogs.tsx`・`plugin-ui.test.tsx`）。
変更: `src/ui/shell/AppShell.tsx`・`src/ui/toolbar/Toolbar.tsx`・`src/ui/status/StatusBar.tsx`（描き場所とホストを渡すだけ）、`eslint.config.js`・`src/layer-rules.test.ts`、`TaskSheets/ARCHITECTURE.md`、`scripts/check-doc-paths.mjs`（`NOT_BUILT_YET`）

#### 共有の判定の使い手

`isTypingTarget`・`isFormControl`（`src/app/typing-target.ts`）は変えていない。呼ぶ側が1つ増えただけ（`grep -rn "typing-target" src | grep import`: `view.ts`・`plugin-host.ts`・`useLayerTool.ts`・`useMeasureTool.ts`・`layer-delete-key.ts` の5つ）

#### 確かめ方

- テスト: `npx vitest run src/app/tea.test.ts src/core src/ui/plugins src/layer-rules.test.ts`（`C:\` の大文字から）
- 画面（AC-6）: `npx vite --port 5341 --strictPort` を起動し、`node scripts/ui-shots.mjs --url http://localhost:5341/ --file C:/rust/point-cloud-viewer/data/autzen-classified.copc.laz --out <dir> --steps view-button` を作業の前（346288c）と後で撮った。
  前: `C:\Users\Masa1\AppData\Local\Temp\claude\65042131baae434c\6c14b4a0-33c2-46f8-a5cf-457a25321be0\scratchpad\shots-before\`、後: `C:\Users\Masa1\AppData\Local\Temp\claude\65042131baae434c\6c14b4a0-33c2-46f8-a5cf-457a25321be0\scratchpad\shots-after\`（作業役の一時フォルダ。再起動などで消えることがある。375・1280 の `0-loaded`・`1-view-button`、各 2 枚）。どちらも console errors 0。
  見比べた所見: リボンのボタンの並び・区切り・ステータスバーの項目・視点のダイアログの位置と中身は同じ。違いは fps の数字だけ。このブラウザでは WebGPU の点群も描かれた
- 所有者の確認手順: `npm run dev` で開き、リボン・ステータスバー・ダイアログが前と同じに見えることを見る（組み込みが空なので、新しい物は何も出ない）

#### 確かめていないこと

- 実際のプラグインが登録したボタン・ダイアログの見た目（組み込みが空なので画面には出ない。jsdom のテストで DOM だけ確かめた）。PL-1 で `pcv.view` を移したときに撮る
- 既存のキー（視点の F・1〜7、Delete、計測の Enter・Esc）とプラグインのショートカットが同じキーを取り合ったときの扱い（ホストはプラグイン同士の重なりしか見ない）。PL-1 で視点のキーを移すときに既存側が消える
- デスクトップ（Tauri）・Android での表示（ホストは画面に何も足さないので変わらない見込み。未確認）

### 実装の記録 R2（監査 R1 の指摘への対応）

R1 の記録のうち、`createProgram` の3つ目の引数・`PluginView.tsx`・報告の `new Error` は、下のとおり変えた（R1 の文は当時の記録として残す）。

- **F-1**（must）: `src/ui/plugins/PluginDialogs.tsx` で `PluginErrorBoundary` を `Dialog` の外に出し、`onError` で報告してから `host.closeDialog(entry.key)` を呼ぶ。中身が投げたら空の枠を残さずダイアログごと閉じる。
  監査役の赤のテスト "removes the whole dialog of a plugin whose dialog content throws, not only its content" を弱めずに一緒にコミットした。
  `PluginView.tsx` は使い手が無くなったので消し、`RenderedByPlugin.tsx` に分けた（ステータスとダイアログが同じ「Boundary の中で `RenderedByPlugin`」の形になり、N-5 も揃った）
- **F-2**（should）: `createProgram(init, update, failures)` の3つ目を `{ effectFailed, report }` にした。列の Msg に「効果の失敗から出た Msg か」を持たせ、その Msg の効果がまた失敗したら `update` に戻さず `report` に流す。
  失敗の Msg の効果が `dispatch` した Msg は普通の Msg として扱う。回数の上限は作らない（メインの決定）。
  テスト（`src/app/tea.test.ts`）: "reports, instead of feeding back to update, an effect that fails while update handles an effect failure"、"reports a promise that rejects while update handles an effect failure"、"treats msgs dispatched by the effects of a failure msg as ordinary msgs again"
- **N-3**（nit）: 購読者の例外は `report` に流し、残りの購読者と効果を続ける。テスト "reports a subscriber that throws and still runs the effects and the other subscribers"
- **F-3**（should）: ホストの `program` が `effectFailed` を包み、`errors.report(プラグインの id, error)` してから Msg を返す。失敗の Msg の処理中の失敗も同じ id で報告する。
  テスト（`src/core/plugin-host.test.ts`）: "reports an effect failure of a plugin program under the plugin's id and still gives the msg to update"、"reports under the plugin's id an effect that fails again while its update handles a failure"
- **F-5**（should）: `src/core/plugin-host.ts` の `APP_SHORTCUT_KEYS`（F・1〜7・Delete・Enter・Escape・Tab）を登録しようとしたら断って報告する。
  数えた物: `grep -rn 'e.key ===\|event.key ===' src`（テスト以外）で Escape・Enter（`useMeasureTool.ts:138,140`・`useLayerTool.ts:206,207`・`Dialog.tsx:51`・`LayerContextMenu.tsx:31`）、
  `layer-delete-key.ts:13` の Delete、`Dialog.tsx` の Tab（`e.key !== "Tab"`、フォーカスの巡回）、`view.ts` の `VIEW_SHORTCUTS` の F・1〜7。
  指摘の例にあった Backspace はアプリのどこでも比べていない（grep で 0 件）ので入れていない。Tab は指摘の例に無いが、Dialog が使っているので入れた。
  テスト `src/core/app-shortcut-keys.test.ts`: `VIEW_SHORTCUTS` の全キーと、ソース中の `e.key`・`event.key`・`input.key` と比べている文字列の全部が一覧に入っていること、一覧の各キー（と小文字の f）が断られて報告されること。
  一覧から "Tab" を一時的に外すと "lists every key the app compares in a key handler" が落ちることを確かめてから戻した。
  既存のテストで使っていた F・1・Delete は K・8・Backspace に替えた。PL-1 で視点が移ったら F・1〜7 を外す（ADR-0023 の改訂に書いた）
- **N-1**（nit）: 報告にしか使わない文は `new Error` で包まず文字列で `report` に渡す（`pluginErrorMessage` が `String(error)` にする）。
  文は日本語のまま（04fc794 の CLAUDE.md の改訂: 画面に出る文はエラーの本文も日本語）
- **F-4**（should）: ADR-0022・ADR-0023 の末尾に「改訂（PL-0、2026-11-21）」の節を足した（本文は変えていない）。`TaskSheets/ARCHITECTURE.md` の TEA とホストの説明も新しい形に合わせた。`npm run check:docs` は OK

触ったファイル（R2）: `src/app/tea.ts`・`tea.test.ts`、`src/core/plugin-host.ts`・`plugin-host.test.ts`・`app-shortcut-keys.test.ts`（新規）、
`src/ui/plugins/PluginDialogs.tsx`・`PluginStatusItems.tsx`・`RenderedByPlugin.tsx`（新規）・`plugin-ui.test.tsx`（監査役の赤のテスト）、`PluginView.tsx`（削除）、
`TaskSheets/ADR-0022-tea-architecture.md`・`ADR-0023-plugins.md`・`ARCHITECTURE.md`

確かめていないこと（R2）: 画面は撮り直していない（変えたのはプラグインが登録したときだけ描かれる部分で、組み込みは空のまま）。F-2 のテストが R1 のコードで落ちること（無限ループ）は、引数の形が変わったので戻して確かめていない（監査役が R1 で実測した）

### 実装の記録 R3（監査 R2 の F-6・nit と、再発防止 PL-0-RP R1）

- **F-6**（should）: `src/core/app-shortcut-keys.test.ts` の検査の範囲を広げた。キーを扱うファイルの一覧を `KEYBOARD_FILES` に固定し、その中のキーの名指し（どの変数名でも `.key` との比較・逆向き・配列の `includes`・`switch` の `case`）を拾う。名前の付いた一覧・Set でのキーの引き当てと `event.code` は、読めない形として「無いこと」を確かめる。
  監査役が挙げた5つの形と `keydown` を持つ新しいファイルを一時的に置くと落ちることを確かめてから戻した（3083fdf）
- **N-8**（nit）: `effectFailed` 自身が投げたら、元の失敗とその例外を両方 `report` に流し、`dispatch` の外へは投げない。ホストは、プラグインの `effectFailed` を呼んでから `errors.report` するので、元の失敗は1度だけ報告される（dcce8fc）。ADR-0022 の改訂に1行足した
- **N-7**（nit）: 直していない。`DialogSpec` に閉じたことの通知（`onClose`）を足すかは、使い手（自分のダイアログの開閉を Model に持つプラグイン）が出る PL-1 で決める
- **再発防止（PL-0-RP R1）**: `TaskSheets/RECURRENCE.md` の「## PL-0」。仕組みとして足した物:
  - `src/ui/plugins/plugin-ui.test.tsx` の "a plugin UI that throws leaves nothing behind, in every place the host draws"（7ca3d42）
  - `src/core/adr-shape.test.ts`（fc317e1）。そろえるため `src/app/tea.ts` の `Failures.effectFailed` をメソッドの書き方にした（型の意味は同じ）
  - AGENTS.md の作業役の決まりに2行（475706b）
- **PL-0-RP R2**: 監査の RP-F1（CRLF で `adr-shape.test.ts` が落ちる形）・RP-F2（ADR-0023 の口の一覧の行を「口の一覧:」の最後の行で読む）・RP-F3（`Failures` の突き合わせを両方向に）を直した。中身は `TaskSheets/RECURRENCE.md` の PL-0 の節の「PL-0-RP R2 での直し」

### 監査の記録

| ラウンド | 監査役 | 判定 | 主な指摘 |
|---|---|---|---|
| R1 | ループ | CHANGES_REQUESTED | F-1 [must] プラグインのダイアログの中身が投げると空の枠が残る（赤のテスト）。F-2 [should] 失敗の Msg への update がまた失敗すると同期の無限ループ、F-3 効果の失敗が errors.report に出ない、F-4 ADR と API の形が違う、F-5 アプリのキーとプラグインのキーが両方走る。N-1 エラーの言葉 → メインが CLAUDE.md を直した（04fc794） |
| R2 | ループ | APPROVE | 全部直った（使い捨てのテストで止まることを確かめた）。F-6 [should] キーの一覧のテストが `switch`・`.code` をすり抜ける。N-7 閉じたことの通知が無い（PL-1 へ） |
| RP R1 | ループ | CHANGES_REQUESTED | 仕組みは元に戻すと落ちる。RP-F1 [must] `adr-shape.test.ts` が CRLF の checkout で落ちる（赤のテスト）。RP-F2 ADR-0023 の一覧の読み方が PL-1 で追いつけない |
| RP R2 | ループ | APPROVE | 実ファイルを CRLF にしても通る。「口の一覧:」の最後の行を読む |
| PR | PR・CI | （この後） | |
