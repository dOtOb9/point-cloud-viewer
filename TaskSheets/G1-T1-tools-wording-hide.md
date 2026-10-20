# G1-T1: 点群ツールを関数へ移す・呼び名の変更・元レイヤーの非表示

計画 `TaskSheets/G1-raster-and-dtm.md` の トラック T1（G1-0、G0-1、G0-2）の記録。所有者の指示でこのシリーズは日本語で書く。

## 1. 何をしたか（コミット順）

### G1-0: ツールの手順を `src/app/point-cloud-tools.ts` へ（`♻️ refactor`、挙動は変えない）

- `src/state/usePointCloudTools.ts` にあった `runTool`・`extractFromLayer`・`mergeSelectedLayers`・`cancelTool` を、
  `src/app/point-cloud-tools.ts` の**普通の関数**にした（R13 の `open-files.ts` と同じ形）。
  `useCallback`・依存配列・ref・`this` は使っていない。読む物・変える物は全部、第1引数の `PointCloudToolsContext` で受け取る。
- `usePointCloudTools` は、進捗の `useState` を持ち、コンテキストを毎レンダーで作って返すだけの橋渡しのフックになった
  （`useFileOpen` と同じ作り）。返すのは `toolProgress` と `toolContext`。
- UI は関数を直接呼ぶ（F12 で本体に飛べる）:
  `MergeLayersButton` → `mergeSelectedLayers(viewer.toolContext)`、`ToolProgressDialog` → `cancelTool(viewer.toolContext)`、
  `useLayerTool`（`src/state/`）→ `extractFromLayer(viewer.toolContext, ...)`。
  `CopcViewerState` から `cancelTool`・`extractFromLayer`・`mergeSelectedLayers` を消し、`toolContext` を足した。
- 「ツール実行中」フラグ: これまでの `toolRunningRef`（`useRef(false)`）をやめ、`openLock` と同じ
  **アプリの間ずっと同じ素のオブジェクト `toolLock: { running: boolean }`**（`useCopcViewer.ts` が `useState(() => ...)` で一度だけ作る）にした。
  `PointCloudToolsContext.toolLock` と、`useFileOpen` の `isToolRunning`（デスクトップの変換リスナーがツールの進捗を無視するため）が同じオブジェクトを読む。
  関数が受け取れる形にするため（`RefObject` のままでも動くが、R13 の `openLock` と揃えたほうが読む人が迷わない）。
- テスト `src/app/point-cloud-tools.test.ts`（偽のコンテキスト）: 成功で新しいレイヤーが開き状態が ready になる／警告は `reportError`（種別 `"tool"`）／
  失敗の本文がそのまま `reportError` へ／キャンセルの文言／実行中の2つ目は断られる／点群でないレイヤーは断られる／合成の成功と2つ未満の案内／`cancelTool`。

### G0-1: 呼び名（`✨ feat`、画面の文言だけ）

- 「点の選択」→「カット」: リボンのボタン（ラベル）、画面下のガイド、作られるレイヤー名（`選択 - 元の名前` → `カット - 元の名前`）、進捗のタイトル。
- 「複数レイヤー」→「合成」: ボタンのラベルとツールチップ、進捗のタイトル、結果のレイヤー名（`合成 (N)`）、案内・エラーの文言
  （`src/app/point-cloud-tools.ts`、`src/datasource/web.ts` の「合成するレイヤーが2つ未満です」「空き容量が足りないため、合成を実行できません」、Worker に渡すラベル `合成: ...`）。
  デスクトップ側の同じ文言（`src-tauri/src/conversion.rs` の「合成するレイヤーが2つ未満です」）も揃えた。
- 変えていないもの: 複数の LAS/LAZ を開くときの「結合」（別の機能。`crates/` と `open-files` 側）、コードの識別子（`select`・`merge`・`extractFromLayer` など）、`data-testid`。
- Web の抽出の内部ラベル `抽出: <ファイル名>`（`web.ts` の `extractToCopc`）は、画面に出る名前ではなく Worker のラベルなので変えていない（要望外）。

### G0-2: 元のレイヤーを非表示にする（`✨ feat`）

- `hideSourceLayers(ctx, sourceLayerIds)`（`src/app/point-cloud-tools.ts`）を1つ作った。レイヤー欄のチェックを外すのと
  **同じ関数 `layers.setLayerVisible`**（React の状態とレンダラーの両方を更新する）を、`PointCloudToolsContext.setLayerVisible` 経由で呼ぶ。
- `runTool` が、新しいレイヤーを開いて状態を ready にした**あと**で、元のレイヤー（カット・断面は1つ、合成は選んだ全部）に対して呼ぶ。
  失敗・キャンセルでは例外で飛ぶので呼ばれず、元のレイヤーは表示のまま。元のレイヤーは消さず、書き換えない。
- 今後のツール（間引き・フィルタ・DTM）は `runTool` に元のレイヤーの id を渡せば同じ動きになる。
- テスト: 成功後に元のレイヤーが非表示になる（カット・合成）／失敗・キャンセルでは何も隠さない／`hideSourceLayers` 単体。

## 2. 採らなかった案

- **`toolRunningRef` のまま `RefObject<boolean>` をコンテキストに入れる**: 動くが、`openLock` と二通りの書き方が並ぶ。素のオブジェクトに揃えた。
- **`runTool` の中で非表示にせず、各ツール関数で個別に呼ぶ**: 今後のツールが増えるたびに呼び忘れる。1箇所（`runTool`）にまとめた。
- **非表示をレンダラーに直接指示する**: React の状態（チェックボックス）とずれる。チェックボックスと同じ `setLayerVisible` を使う。
- **UI 側のフックにラップを残して `viewer.extractFromLayer` のままにする**: F12 が型宣言で止まる（R13 の動機そのもの）ので、直接呼ぶ形にした。
- **「結合」を全て「合成」に置換**: ファイルを開くときの結合は別の機能なので、ツール関連だけに限った。

## 3. 触ったファイル

- 新規: `src/app/point-cloud-tools.ts`、`src/app/point-cloud-tools.test.ts`
- 変更: `src/state/usePointCloudTools.ts`、`src/state/useCopcViewer.ts`、`src/state/useFileOpen.ts`、`src/state/viewer-types.ts`、`src/state/useLayerTool.ts`、
  `src/app/open-files.ts`（コメントのみ）、`src/ui/toolbar/buttons/MergeLayersButton.tsx`、`src/ui/toolbar/buttons/SelectPointsButton.tsx`、
  `src/ui/tools/ToolProgressDialog.tsx`、`src/ui/tools/LayerToolOverlay.tsx`、`src/datasource/web.ts`、`src/datasource/web-protocol.test.ts`（ラベル文字列のみ）、
  `src-tauri/src/conversion.rs`（文言1箇所）
- 設計書: `docs/book/src/flows/point-cloud-tools.md`（呼び名と入口・流れを新しい構成に）、`flows/errors.md`・`flows/layers.md`・`flows/open-file.md`・`flows/settings.md`、
  `frontend/state.md`・`frontend/datasource.md`、`maps/open-file.md`（`usePointCloudTools` / `toolRunningRef` への言及を直した）

## 4. 実行したこと・確かめたこと

- `npm test`: 67 ファイル、621 テストが通った（G1-0 の時点では 620 → 非表示のテストで 621）。`npm run lint`、`npx tsc --noEmit` も通った。
- CI の `invariants`（規約2・3・5）と同じ grep をローカルで実行: `@tauri-apps/api` を含むのは `src/datasource/tauri.ts` だけ、`src/app` に React と `state/use*` の import なし。
  規約1（`cargo build -p pcv-core --target wasm32-unknown-unknown`）は Rust の `pcv-core` を触っていないので実行していない。
- Rust は `src-tauri/src/conversion.rs` の文字列1つだけの変更。`cargo` でのビルドは**していない（未確認）**。
- 画面での確認（Web ビルド、実 GPU）: 下の手順で実行した。結果は報告に書いた。

## 5. 所有者が自分で確かめる手順

1. `npm run build` のあと `npx vite preview --port 4417`（空いているポートでよい）を開く。
2. 「開く」で `data/autzen-classified.copc.laz` を開く。リボンに「カット」「断面」「合成」が並ぶこと（「点の選択」「複数レイヤー」が無いこと）。
3. 「カット」→ 3か所クリック → Enter。レイヤーが2つになり、元のレイヤーのチェックが外れ、新しい `カット - ...` だけが見えること。
4. 元のレイヤーのチェックを入れ直すと再び見えること（消えていない）。
5. 「断面」でも同じ（2点を拾い、厚みを確定）。「合成」は Ctrl か Shift で2つ以上選ぶと押せる。結果は `合成 (N)`、元の全レイヤーが非表示になること。
6. ツール実行中にキャンセルすると、元のレイヤーは表示のままであること。

## 6. 確かめていないこと

- 「断面」「合成」の画面での動作（カットだけ実機で通した。断面・合成は単体テストの偽のコンテキストのみ）。
- デスクトップ（Tauri）での動作。Android。
