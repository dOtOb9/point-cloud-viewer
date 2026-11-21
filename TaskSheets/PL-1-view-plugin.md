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

### 実装の記録 R1（作業役、2026-11-21）

#### コミット（base `ea66232` から）

| コミット | 関心 |
|---|---|
| `afaa3b9` | AC-1: `src/app/tea.ts` の `update` の例外を捨てて報告し、残りの Msg を続ける。ADR-0022 の改訂（PL-1） |
| `c17a848` | AC-1 のテストを型の通る形に書き直した（`afaa3b9` のテストが typecheck で落ちていた） |
| `223341f` | AC-2: `DialogSpec.onClose`。ADR-0023 の改訂（PL-1）の節を作った |
| `b760e29` | AC-4: `RibbonItem` の `group`・`enabled`・`disabledTitle`・`testId` と `RibbonHandle`、`Shortcut.enabled` と `ShortcutHandle` |
| `daee063` | AC-5 の下準備: `DialogSpec.width`・`closeButtonLabel` |
| `cad6883` | AC-3・AC-5〜AC-8: `layers`・`view` の口、`src/plugins/view/`（`pcv.view`）、ビューアごとの視点の文脈、古い配線の削除、`APP_SHORTCUT_KEYS` の変更 |
| `6863da3` | `TaskSheets/ARCHITECTURE.md` を今の形に合わせた |

#### 決めたことと、採らなかった案

- **投影の正本はビューの文脈（`src/app/view.ts` の `ViewContext.state`）**。`pcv.view` の Model は `view.subscribe` で写す。Model に正本を置く案は、レンダラの付け外しがプラグインの外（`src/state/useRendererLifecycle.ts`）で起きるので、作り直したレンダラに投影を渡す道が無くなるので採らなかった（AC-7）。ADR-0023 の改訂（PL-1）に書いた
- **Model に持つ物**: 点群があるか（`pointCloud`）、ビューの文脈の写し（`view`）、ダイアログが開いているか（`dialogOpen`）。`dialogOpen` は AC-2 の `onClose` で戻す。リボンを2度押しても2つ開かない（前の `useState` の `viewDialogOpen` と同じ）
- **押せる／押せないは、Model の購読で `setEnabled` を呼ぶ**（リボンとキーの両方）。点群が無いときのキーは、走らせず `preventDefault` もしない（前の "with only measurement layers left, 5 changes nothing and the key is not taken" と同じ）。`update` も点群が無い間の視点の命令を捨てる（点群を閉じてもダイアログは開いたまま残るため。前と同じ）
- **`handle.close()` のとき `onClose` は呼ばない**（AC-2 の決め）。プラグインが閉じたことを知っているため。`deactivate` のときも呼ばない
- **ステータスの項目の場所**: プラグインの項目を fps の後（前の視点の文の場所）に移した。空のときは包む `span` を `empty:hidden` で消す（空の項目の間隔 `gap` が残らないように）。組み込みのプラグインは `pcv.view` だけなので、ほかの表示の並びは変わらない
- **`ViewPresetId`・`ProjectionMode`・`VIEW_PRESET_IDS` を `src/plugin-api` に置いた**（`src/plugin-api` は `src/renderer` を import できない）。視点の名前（上・正面…）は画面の文なので `src/plugins/view/labels.ts` に置いた。レンダラ側と同じことはテスト "the plugin API's viewpoints and the plugin's labels are the renderer's" で確かめる。
  その結果、`src/renderer/view-presets.ts` の `VIEW_PRESET_LABELS` はテスト以外の使い手が無くなった（`grep -rn VIEW_PRESET_LABELS src` で確かめた）。シートの範囲が「レンダラは口に要る読み取りを足す以外は変えない」なので消していない。消すかはメインの判断（候補）
- **`layers` の読む側の値は、今はビューの文脈の `pointCloud`**（`syncViewWithLayers` がレイヤーの一覧から作る）。レイヤーの一覧を移すとき（PL-3 以降）にレイヤーの文脈へ分ける（ADR-0023 の改訂に書いた）
- **プラグインが購読に渡した関数が投げたら**、ホストがプラグインの id で報告し、ほかの購読者は続ける（テスト "reports a subscriber that throws under the plugin's id, and the other subscribers still hear the change"）
- **`update` に効果の作り方（`ViewEffects`）を3つ目の引数で渡す**: `update` が返す効果は、ホスト（`dialogs`・`view`）とダイアログの中身（プログラムを読む）を閉じ込めた関数で、プログラムを作った後でないと作れない。`activateView` の中で `program` と `effects` を作り、`update` は呼ばれたときに `effects` を受け取る。テストは名前つきの偽の効果で、どの効果が返るかを比べる

#### 範囲の外で触ったファイル

- `src/code-limits.test.ts`: "the view keys use isTypingTarget" が消えた `src/app/view.ts` の中身を見ていた。"the view keys are harmless plugin shortcuts, which the host checks with isTypingTarget"（`src/plugins/view/index.ts` が `kind: "harmless"` で登録し、ホストが `harmless` を `isTypingTarget` で判定すること）に置き換えた。検査の強さは同じ（見る先が移っただけ）
- `src/state/viewer-types.ts`: `CopcViewerState` に `viewContext` を足した（「`useCopcViewer.ts` まわり（ホストに文脈を渡す配線だけ）」の中と考えた）

#### 消したテストの行き先（AC-8）

| 消したテスト（元のファイル） | 移した先 |
|---|---|
| `src/app/view.test.ts` "a preset goes to the renderer"・"fit all goes to the renderer"・"does nothing (and does not fail) before the renderer exists"・"reports false when the renderer has no visible layer" | 同じファイル（書き直し）の同じ名前 |
| 同 "the projection toggle flips between the two modes" | `src/plugins/view/model.test.ts` の同じ名前、`src/ui/plugins/view-plugin.test.tsx` "5 switches the projection while a point cloud is open, and the key is taken"（往復も見る） |
| 同 "the store is the one source of the projection: a new renderer gets the mode chosen before it existed" | `src/app/view.test.ts` "a new renderer gets the mode chosen before it existed"・"a renderer made again after the first one is gone gets the mode chosen with the first one"、`view-plugin.test.tsx` "a new renderer gets the mode chosen with the old one"・"a renderer attached later gets the mode chosen while there was none"（AC-7） |
| 同 "subscribers are told when the projection changes, and only then" | `src/app/view.test.ts` の同じ名前 |
| 同 "only measurement layers (or none) -> false; a point-cloud layer -> true"・"syncViewEnabled puts the answer into the context" | `src/app/view.test.ts` の同じ名前と "syncViewWithLayers puts the answer into the context" |
| 同 "every view function does nothing while no point-cloud layer is open (only measurement layers left)" | `model.test.ts` "TP-1 F-10: without a point-cloud layer (only measurement layers left) every view command does nothing"、`view-plugin.test.tsx` "with no layer at all the keys do nothing"・"stays open when the point cloud is closed, and its buttons then do nothing" |
| 同 "F / 1 / 2 / 3 / 4 / 5 are fit, top, front, right, isometric, projection"・"every preset has a key and no key is used twice" | `src/plugins/view/labels.test.ts` の "F / 1 / 2 / 3 / 4 / 5 / 6 / 7 are …"・同じ名前、`view-plugin.test.tsx` "F / f / 1 / 2 / 3 / 4 / 6 / 7 are fit, top, front, right, isometric, back, left"（実際の keydown） |
| 同 "keys typed in a field are not shortcuts" | `view-plugin.test.tsx` "keys typed in a field are not shortcuts"（input・textarea・select）・"keys typed in a contenteditable element are not shortcuts" |
| 同 "keys with Ctrl / Meta / Alt, held keys and IME composition are not shortcuts"・"other keys are ignored" | `view-plugin.test.tsx` の同じ名前 |
| 同 viewStatusText の3件 | `labels.test.ts` の同じ名前 |
| `src/ui/tools/ViewDialog.test.tsx` "has 全体 and the six viewpoints with their keys, …"・"pressing a viewpoint moves the view at once and keeps the dialog open" | `view-plugin.test.tsx` の同じ名前 |
| 同 "marks the current viewpoint" | `view-plugin.test.tsx` "marks the current viewpoint, and follows the renderer when it changes" |
| 同 "choosing the orthographic projection calls the setter; the current one is checked" | `view-plugin.test.tsx` "choosing the orthographic projection tells the renderer; the current one is checked" |
| 同 "Esc closes it" | `view-plugin.test.tsx` "%s closes it, and the ribbon button opens it again"（Esc・閉じる） |
| 同 ViewButton "is disabled without a point-cloud layer and enabled with one; the tooltip lists the keys" | `view-plugin.test.tsx` "is disabled without a point-cloud layer, with the hint as its tooltip"・"is enabled with one and the tooltip lists the keys"・"opens the viewpoint dialog once, however often it is pressed" |
| `src/ui/toolbar/useViewShortcuts.test.tsx` の5件（"5 switches the projection while a point cloud is open"・"with only measurement layers left, …"・"with no layer at all the keys do nothing"・"follows the layer list: …"・"F-1 the keys still work while a radio button …"） | `view-plugin.test.tsx` の同じ名前（1件目は "…, and the key is taken"） |
| `src/core/app-shortcut-keys.test.ts` "lists every view shortcut key" | 同じファイルの "leaves the view keys to the pcv.view plugin instead of keeping them for the app"、"the view keys belong to the pcv.view plugin" の "pcv.view registers F and 1 to 7 as harmless shortcuts"・"another plugin cannot take %s, …"（F・1〜7・小文字の f）（AC-6） |
| `src/code-limits.test.ts` "the view keys use isTypingTarget" | 同じファイルの "the view keys are harmless plugin shortcuts, which the host checks with isTypingTarget" |

#### 受け入れ基準ごとの根拠

- AC-1: `src/app/tea.ts` の `updateOrReport`。`src/app/tea.test.ts` の describe "createProgram: an update that throws"（"drops the msg, keeps the model, tells no subscriber, reports once and does not throw out of dispatch"・"processes the msgs queued behind the failed one within the same dispatch"・"keeps the program usable after the failure"）、
  `src/core/plugin-host.test.ts` "reports an update that throws once under the plugin's id and keeps the program running"。ADR-0022 の末尾の「改訂（PL-1、2026-11-21）」。
  戻す道は作っていない（捨てて報告するだけ）ので、「戻した先でまた失敗」は起きない
- AC-2: `src/core/plugin-host.ts` の `closeDialog`・`removeDialog`。テスト: `plugin-host.test.ts` "tells the plugin exactly once when the host closes its dialog"・"does not tell the plugin when the plugin closes its own dialog through the handle"・"does not tell a plugin that is being deactivated about its dialogs"・"reports an onClose that throws under the plugin's id and the dialog stays closed"、
  `src/ui/plugins/plugin-ui.test.tsx` の describe "a plugin is told once when the host closes its dialog"（Esc・枠の外・中身の例外・フッターの閉じる）。ADR-0023 の改訂（PL-1）
- AC-3: `src/plugin-api/index.ts` の `LayersApi`・`ViewApi`、`src/core/plugin-host.ts` の `layersFor`・`viewFor`。テスト: `plugin-host.test.ts` の describe "plugin host: layers and view"。ADR-0023 の改訂（PL-1）の「口の一覧: `ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`layers`・`view`・`program`」を `src/core/adr-shape.test.ts` が突き合わせて通る
- AC-4: `RibbonItem` の `group`・`enabled`・`disabledTitle`・`testId`、`RibbonHandle`。`src/ui/toolbar/Toolbar.tsx` で `<PluginRibbonItems group="view" />` が「開く」の区切りの後・計測の区切りの前。
  テスト: `plugin-ui.test.tsx` "grays out a disabled ribbon button with its disabled title, and enables the same button in place"、`view-plugin.test.tsx` "follows opening and closing the point cloud without being made again"（同じ要素のまま）、`plugin-host.test.ts` の describe "plugin host: ribbon enabled and groups"。画面は AC-9
- AC-5: `src/plugins/view/`（`index.ts`・`model.ts`・`effects.ts`・`labels.ts`・`view/ViewDialogBody.tsx`・`view/ViewStatus.tsx`・`view/useViewModel.ts`）、`src/plugins/builtin.ts`。`npm run lint` が import の規則を通す。テストは `view-plugin.test.tsx`・`model.test.ts`・`labels.test.ts`。画面は AC-9
- AC-6: `src/plugins/view/index.ts` が `VIEW_SHORTCUTS` を `kind: "harmless"` で登録。`APP_SHORTCUT_KEYS` は `["Delete", "Enter", "Escape", "Tab"]`。テストは上の表（`app-shortcut-keys.test.ts`、`view-plugin.test.tsx` のキーの describe）
- AC-7: `export const viewContext` を消した（`grep -rn "viewContext" src` で、残りは `useCopcViewer.ts`・`useRendererLifecycle.ts`・`viewer-types.ts`・`AppShell.tsx` の引数・欄だけ）。`useCopcViewer` が `useState(createViewContext)` でビューアごとに作る。テストは上の表の AC-7 の行と `src/app/view.test.ts` "two viewers do not share a view context"
- AC-8: `ViewDialog.tsx`・`ViewButton.tsx`・`useViewShortcuts.ts` と、その2つのテストを消した。`AppShell.tsx` の `viewDialogOpen`・`useViewShortcuts`、`Toolbar.tsx` の `onOpenView`・`ViewButton`、`StatusBar.tsx` の `view-status` と `useStore(viewContext.projection)` を消した。行き先は上の表
- AC-9: 下の「画面」
- AC-10: 作業報告に `npm run check:all` と `node scripts/check-task-sheet.mjs ea66232` の出力を貼る

#### 画面（AC-9）

- 撮り方: base は `git worktree add --detach C:\tmp\pcv-PL-1-base ea66232`（`node_modules` はこの worktree へのジャンクション）で `npx vite --port 5391 --strictPort`、後はこの worktree で `npx vite --port 5392 --strictPort`。
  `node scripts/ui-shots.mjs --url <url> --file C:\rust\point-cloud-viewer\data\autzen-classified.copc.laz --out <dir> --steps view-button`。点群が無いときの絵は `ui-shots.mjs` が撮らないので、scratchpad の `shots-tools/disabled-shot.mjs`（開く前に撮り、`view-button` の `disabled`・`title` と `view-status` の数を出し、5 を押してダイアログが出ないことを見る）で撮った。終わった後、自分が立てた vite だけ（コマンドラインを確かめてから）止め、一時の worktree を消した
- 画像（作業役の scratchpad。消えうる）: base は `C:\Users\Masa1\AppData\Local\Temp\claude\65042131baae434c\5e501d87-7692-452d-a138-ba92ad3bc8f2\scratchpad\shots-base\`、後は同じ場所の `shots-after\`。それぞれ `375-0-loaded.png`・`375-1-view-button.png`・`375-no-pointcloud.png`・`1280-0-loaded.png`・`1280-1-view-button.png`・`1280-no-pointcloud.png`
- 所見: 1280px・375px とも、押した後（ダイアログ）の絵は base と同じに見えた（右の side パネル、幅、全体・6視点・キーの表示、投影のラジオと説明、フッターの「閉じる」、ステータスバーの「視点: 自由（透視投影）」が fps の後）。違いは fps の数（60 と 57）だけ。
  375px は下の side パネルが画面の下半分の点群に重なる（base と同じ。この作業で変えていない）。点群が無いときは両方とも「視点」がグレーアウトし、`title` は「点群を開くと、視点を変えられる」、`view-status` は 0 個、5 を押してもダイアログは出なかった（両方で同じ出力）。WebGPU の描画は出た（点群が見えた）
- 実際のブラウザでの動き: scratchpad の `shots-tools/probe.mjs`（1280px、autzen を開いて 1 → 5 → F → 2 のキー、ダイアログの aria-pressed とラジオ、透視のラジオ、ラジオにフォーカスがある状態で 4、上のボタン、Esc、開き直し、「閉じる」）を base と後の両方で流し、出力が全部同じだった
  （例: "after 1: 視点: 上（透視投影）"、"after 5: 視点: 上（平行投影）"、"after 4 with radio focused: 視点: 等角（透視投影） isometric pressed: true"、"dialogs after 閉じる: 0"）

#### 所有者の確認手順

1. `npm run dev` で sofi か autzen を開く。リボンの「視点」が「開く」の右（区切りの後）にあり、押すと右（スマホは下）に視点のダイアログが出る
2. ダイアログの全体・上・正面・背面・左・右・等角、投影のラジオがすぐ効き、今の視点のボタンが強調される。Esc・「閉じる」・枠の外で閉じ、もう一度押すと開く
3. F・1〜7 のキーが効く（入力欄の中では効かず、ラジオの上では効く）。ステータスバーの「視点: …（…投影）」が変わる（狭い画面では「上・平行」の形）
4. レイヤーを消して点群を無くすと、「視点」がグレーアウトし（ツールチップ「点群を開くと、視点を変えられる」）、キーが効かない。開き直すとまた押せる
