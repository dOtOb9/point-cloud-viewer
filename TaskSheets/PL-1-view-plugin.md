# PL-1: 視点（TP-1）を最初のプラグイン `pcv.view` に移す

- 元: `PLAN-2026-11.md` の 8、ADR-0023 の「移す順」の PL-1（「API が実用になるかの試金石」）
- 前提のタスク: PL-0（main e7f3572）。前提に入れたもの: PL-0 の PR 監査 F-1、PL-0 の N-7、PLAN の F11
- 方針: 画面と操作は今と同じにする（利用者から見て変わらない）。コードにコメントを書かない。push しない（push はメイン）

## いまの形（メインが読んで確かめたこと、2026-11-21 の `23c51a7`）

- 視点の手順と状態は `src/app/view.ts`。`export const viewContext: ViewContext = createViewContext()`（26 行）がモジュールに1つの文脈で、
  使い手は `src/state/useRendererLifecycle.ts`（38・80 行の `attachViewRenderer`・`detachViewRenderer`）、`src/ui/shell/AppShell.tsx`（23・61 行）、`src/ui/status/StatusBar.tsx`（2・27 行）、`src/ui/tools/ViewDialog.tsx`（`context = viewContext` の既定値）
- 画面の部品: リボンの `src/ui/toolbar/buttons/ViewButton.tsx`（`data-testid="view-button"`、点群が無いと `disabled`、ツールチップにキーの一覧）、
  ダイアログの `src/ui/tools/ViewDialog.tsx`（`placement="side"`・`widthClass="max-w-xs"`・フッターの「閉じる」、`view-presets`・`view-fit`・`view-preset-<id>`・`view-projection`）、
  ステータスバーの `view-status`（`StatusBar.tsx` 62〜64 行。`viewer.stats.viewPreset` と投影から `viewStatusText`）
- キー: `src/ui/toolbar/useViewShortcuts.ts` が `window` の `keydown` で `viewActionForKey` → `runViewAction`。`src/core/plugin-host.ts` の `APP_SHORTCUT_KEYS` が F・1〜7 をプラグインに渡さない
- 今いる視点（`viewPreset`）はレンダラの `stats`（`point-cloud-renderer.ts` 788 行の `matchViewPreset`）から来る
- プラグインの口（`src/plugin-api/index.ts`）は `ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`program` だけ。`RibbonItem` に `enabled`・グループ・`data-testid` が無く、`DialogSpec` に幅・フッター・閉じたことの通知が無い
- `src/app/tea.ts` の `step` で `update` が投げると、例外は `dispatch` の外へ出て、キューに残った Msg は次の `dispatch` まで処理されない（PL-0 PR 監査 F-1）

## 範囲

触ってよい: `src/plugins/view/`（新規）・`src/plugins/builtin.ts`、`src/plugin-api/`、`src/core/plugin-host.ts` とテスト、`src/ui/plugins/`、`src/app/tea.ts` とテスト、
`src/app/view.ts`（プラグインに移した後に残る物の整理、または削除）、`src/ui/tools/ViewDialog.tsx`・`src/ui/toolbar/buttons/ViewButton.tsx`・`src/ui/toolbar/useViewShortcuts.ts`（移した後は消す）、
`src/ui/shell/AppShell.tsx`・`src/ui/toolbar/Toolbar.tsx`・`src/ui/status/StatusBar.tsx`・`src/state/useRendererLifecycle.ts`・`src/state/useCopcViewer.ts` まわり（ホストに文脈を渡す配線だけ）、
`src/core/app-shortcut-keys.test.ts`・`src/core/adr-shape.test.ts`、`eslint.config.js`・`src/layer-rules.test.ts`（要るなら）、`TaskSheets/ADR-0022-tea-architecture.md`・`TaskSheets/ADR-0023-plugins.md`（末尾に改訂の節を足すだけ）、`TaskSheets/ARCHITECTURE.md`、このシートの記録。
触らない: `src/state/useOpfsStorage.ts`・`src/app/scratch-cleanup.ts`・`src/ui/settings/`・`package.json` の `build:wasm`・`crates/`（CM-F が並行して触る）、レンダラのカメラの計算（`src/renderer/` は、口に要る読み取りを足す以外は変えない）

## 受け入れ基準

- **AC-1（TEA の update の失敗）** `createProgram` の `update` が投げたら、その Msg は捨てて Model を変えず、例外を `failures.report` に流し、キューに残っている Msg は同じ `dispatch` の中で続けて処理する（`dispatch` の外へは投げない）。
  ホストの `program` では、その報告がプラグインの id で出る。テストで固定する: 「投げた Msg の後ろの Msg がその場で処理される」「Model が変わらない」「購読者に知らせない」「報告が1度」「プラグインの id で出る」。
  ADR-0022 の末尾に「改訂（PL-1、日付）」として1行足す（メインの決定: 捨てて報告して続ける。理由は、購読者の例外（PL-0 の N-3）と同じ扱いにそろえ、1つのバグで後ろの Msg が止まらないようにするため）
- **AC-2（ダイアログを閉じた通知、N-7）** `DialogSpec` に閉じたことを知らせる口を足す。利用者が閉じたとき（Esc・×・枠の外など、ホストが閉じるすべて）と、中身が投げてホストが閉じたときに、ちょうど1度呼ばれる。
  プラグインが自分で `handle.close()` したときの扱い（呼ぶ／呼ばない）を決めて ADR-0023 の改訂に書き、テストで固定する。通知が投げたら報告してダイアログは閉じたままにする
- **AC-3（口を足す）** 視点に要る口を足す。少なくとも: 点群のレイヤーがあるかを読む・変わったら知らせる（`layers` の読む側）、全体・決まった視点・投影をレンダラに伝え、今いる視点と投影を読む・変わったら知らせる（`view`）。
  ADR-0023 の末尾に「改訂（PL-1、日付）」の節を足し、新しい「口の一覧:」の行を書く（`src/core/adr-shape.test.ts` がホストの口と突き合わせる）。使い手のいない口は足さない
- **AC-4（リボンの enabled とグループ）** `RibbonItem` に、押せるかどうか（点群が無いときはグレーアウトしてツールチップに「点群を開くと、視点を変えられる」に当たる文）と、置く場所（グループ）を足す。
  視点のボタンは今と同じ場所（「開く」の区切りの後、計測の区切りの前）に、今と同じアイコン（`Eye`）・名前・ツールチップ・`data-testid="view-button"` で出る。点群を開いた・閉じたときに、作り直し無しで押せる／押せないが変わる
- **AC-5（`pcv.view`）** 視点を `src/plugins/view/` の組み込みプラグイン `pcv.view` に移す（ADR-0023 の「1プラグイン = 1フォルダ」。状態はプラグインの `program` の Model に）。
  リボンのボタン・視点のダイアログ（`placement="side"`・今の幅・フッターの「閉じる」・`view-presets`・`view-fit`・`view-preset-<id>`・`view-projection` の `data-testid`、今いる視点の強調、投影のラジオ）・
  ステータスバーの `view-status`（今と同じ文。幅が狭いときの短い文も）が、今と同じに見えて動く。`src/plugins/**` の import の規則（`eslint.config.js`）を守る
- **AC-6（キー）** 視点のキー（F・1〜7）は `pcv.view` が `shortcuts.add` で `kind: "harmless"` として登録する。`APP_SHORTCUT_KEYS` から F・1〜7 を外し、`src/core/app-shortcut-keys.test.ts` を新しい形に合わせる（視点のキーはプラグインのもので、他のプラグインが取れないことを確かめる形に）。
  点群が無いときにキーが何もしないこと、入力欄では効かずラジオの上では効くこと（今の `isTypingTarget` の使い分け）、Ctrl などの修飾・押しっぱなし・IME の変換中は効かないことを、今の `src/app/view.test.ts` と同じ強さでテストする
- **AC-7（F11、モジュールに1つの文脈を無くす）** `export const viewContext` を消す。視点の文脈はビューアごと（ホストを作るとき）に作り、レンダラの付け外し（`useRendererLifecycle.ts`）はその文脈に渡す。
  レンダラが作り直されても、選んでいた投影がそのまま新しいレンダラに渡ることをテストで固定する（今の "a new renderer gets the mode chosen before it existed" と同じ強さ）
- **AC-8（古い配線を消す）** `ViewDialog.tsx`・`ViewButton.tsx`・`useViewShortcuts.ts` と、`AppShell.tsx`・`Toolbar.tsx`・`StatusBar.tsx` の視点の配線（`viewDialogOpen`・`onOpenView` など）を消す。今のテスト（`src/app/view.test.ts`・`src/ui/tools/ViewDialog.test.tsx`）が確かめていたことは、移した先のテストで全部確かめる（消すテストごとに、どこへ移したかを記録の表に書く）
- **AC-9（画面）** `scripts/ui-shots.mjs` で、作業の前（base）と後に、幅 375px と 1280px で `view-button` を押した前後を撮り、見比べた所見を記録に書く（AGENTS.md の作業役の決まり）。点群が無いときのグレーアウトも撮る。
  WebGPU の描画が出なければ「未確認」と書く
- **AC-10** `npm run check:all` が全部 OK。`node scripts/check-task-sheet.mjs <base>` の出力を作業報告に貼る

## 確かめ方

- 上のテストの名前、`npm run check:all` の一覧、`node scripts/check-task-sheet.mjs <base>`
- 画面は AC-9。所有者の確認手順: `npm run dev` で sofi か autzen を開き、リボンの「視点」・ダイアログの全ボタン・投影の切り替え・F・1〜7 のキー・ステータスバーの文が前と同じに動くこと、点群を閉じるとボタンがグレーアウトしてキーが効かないこと

## 記録

（作業役が足す）
