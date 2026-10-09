# src/ui/shell: 画面の部品

`src/ui/shell/` は [ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md)（ガラスの質感）と
[ADR-0017](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0017-ui-shell-ribbon.md)（レイアウトの再構築）が決めた UI シェルの実装です。3D ビューを
ウィンドウ全面に敷き、UI はその上に浮かぶ半透明のガラス面として構成する方針（ADR-0005）は変わっていません。
レイアウト自体は、デスクトップの点群/GIS 系ソフトに多い「上部リボン + 左レイヤーツリー + 下部ステータスバー」に
2026-10 に再構築しました（ADR-0017）。

## 組み立て役: `AppShell.tsx`

[`AppShell.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/AppShell.tsx) が `useCopcViewer()`・`useTheme()`・`useWebGpuSupport()`・`useUpdateCheck()`
をここで一度だけ呼び、各部品へ props で配ります。すべての部品は
`ViewerPanel`（`<canvas>` だけを敷く dumb な部品）の上に重ねた絶対配置の層です。

```
<div class="fixed inset-0">
  <ViewerPanel />                 ← 3Dビュー(canvas)、全面
  <Ribbon />                      ← 上部、ファイル/表示/ツール/設定の4グループ
  <LayerPanel />                  ← 左、レイヤーツリー+レイヤー情報、折りたたみ可
  <StatusBar />                   ← 下部、1行（表示点数/予算・fps・CRS・読み込み進捗）
  <SettingsModal />                ← 不透明なモーダル
  <ConversionDialog />             ← 中央ダイアログ「変換中」
  <ErrorDialog />                  ← 中央ダイアログ「エラー」。z-50、最前面。履歴モードもある
  <UpdateNotice />                 ← 更新通知
</div>
```

768px 未満（`useNarrowViewport`）では `Ribbon` がハンバーガーメニューに畳まれ、
`LayerPanel` は画面を覆うドロワーになります（`Ribbon.tsx`/`LayerPanel.tsx`参照）。

WebGPU が非対応と確定した場合（`useWebGpuSupport().result.supported === false`）は、
`AppShell` がこの全体を [`UnsupportedDeviceScreen`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/UnsupportedDeviceScreen.tsx) に差し替えます
（[ADR-0002](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0002-rendering-api.md) が WebGL2 フォールバックを作らないと決めたため、白画面のまま
放置せず「未対応」と明示する必要があります）。

## 各部品

| 部品 | 内容 |
|---|---|
| [`Ribbon.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/Ribbon.tsx)（上部） | ファイル(開く)/表示(着色・EDL・点のサイズ・中央優先度)/ツール(未実装4種、グレーアウト)/設定(モーダルを開く)の4グループ。各グループは`Ribbon*Group.tsx`に分けてある |
| [`LayerPanel.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/LayerPanel.tsx)（左） | レイヤーツリー(開いているファイルを1件のレイヤーとして表示)+レイヤー情報(`LayerInfoSection.tsx`: ファイル名・点数・CRS・バウンディングボックス・背景・グリッド・点予算・変換の進捗/内訳/エラー)+詳細統計(`LayerStatsDetails.tsx`、折りたたみ) |
| [`StatusBar.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/StatusBar.tsx)（下部、1行） | 表示点数/点予算、fps、CRS、読み込み進捗、エラーログを開くボタン |
| [`SettingsModal.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/SettingsModal.tsx) | レンダースケール、テーマ、更新チェック、一時ファイルの置き場所、OPFSの保存領域、診断パネル |
| [`Dialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/Dialog.tsx) | 設定・変換・エラーが共通で使う中央ダイアログ枠(不透明、Esc/✕、フォーカス移動、狭幅は全幅近く) |
| [`ConversionDialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/ConversionDialog.tsx) | 変換の進捗・結果(「変換中」、キャンセル) |
| [`ErrorDialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/ErrorDialog.tsx) | エラー(コピー・閉じる)と、このセッションの全エラー履歴 |

**CRS について(正直に):** `LayerInfoSection`・`StatusBar`はどちらも「CRS: 不明（未配線）」と表示します。
`CloudInfo`（`src/datasource/DataSource.ts`）には現時点で CRS フィールドが無く、`crates/pcv-core/src/crs`
モジュールはあるものの `CloudInfo` まで配線されていません。UI シェルの再構築作業では新しいデータパイプラインを
追加する判断をせず、推測で値を出さずに「不明」と表示するに留めています。

### 未実装のツールはグレーアウトする

`Ribbon`の「ツール」グループ（計測・断面・点の選択・複数レイヤー）はいずれも未実装で、`disabled`属性つきの
ボタンとして表示されます。クリックしても何も起きず、`title`に「未実装（予定）」と出ます。実装が入ったら
対応するボタンの`disabled`を外すところから始めます（`RibbonToolsGroup.tsx`）。

### 以前の `Dock`（ADR-0014、廃止）について

以前は画面下部中央にフローティングの `Dock`（レイヤー/情報パネルの開閉・設定を開くボタン）があり、
そのレイアウトだけ ui-forge という専用ツールの `.ui` ファイルから生成していました（ADR-0014）。
2026-10 の UI シェル再構築（ADR-0017）で、レイアウト全体を手書きの TSX に戻す決定とともに `Dock` 自体を
廃止し、ui-forge への依存（`Dock.ui`/`Dock.generated.tsx`/`npm run ui:gen`/`ui:check`/CI ステップ/
`package.json`の依存）もすべて取り除きました。`Dock`が持っていた開閉操作は `Ribbon`（設定を開く）と
`LayerPanel`自身の開閉ボタンに引き継いでいます。詳細は ADR-0017 の対応表、経緯は
[ADR-0014](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0014-ui-forge.md)（冒頭に「状態: 廃止（ADR-0017で置き換え）」と追記）を参照してください。

## ガラスの質感: `glass.ts`

[`glass.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/glass.ts) に `GLASS_SURFACE` として集約されています。`backdrop-blur-md` の上に
`bg-white/65`（ライト）・`dark:bg-slate-950/70`（ダーク）の tint を重ねます。
点群は色が任意で高周波ノイズがあり、tint が薄いと文字が背景依存で読めなくなる
という [ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md) のリスクへの対処です。`SettingsModal` と `GpuErrorBanner`・`ErrorLogDialog`だけは
意図的にガラスを使わず、不透明です（設定/ログは密なフォーム・ログの可読性のため、バナーはどんな背景の
上でも確実に読めるようにするため）。UI シェル再構築(ADR-0017)でレイアウトを変えた際も、この区別は
そのまま維持しました(`Ribbon`・`LayerPanel`・`StatusBar`・`UpdateNotice`はガラス、残り3つは不透明)。

ガラスのオン/オフというユーザー設定は無く、常にガラスです（ADR-0017）。ただしモバイル端末では端末プロファイル（`device-profile.ts`）が `glassEnabled` を false にしてぼかしを自動で切り、
`OPAQUE_GLASS_SURFACE`（不透明な tint のみ）に切り替わります（[M3-8](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M3-release-and-update.md)、
GPU 負荷削減の一手段。ユーザーが切り替える設定ではない）。ガラスの fps 比較は、切り替えが無くなったため行いません（ADR-0017 参照）。

## エラー・変換の表示: 中央ダイアログ

設定・変換の進捗・エラーは、共通の [`Dialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/Dialog.tsx)（タイトルバー・本文・右寄せボタンのフッター）で出します。
エラーは以前は画面最前面のバナー（`GpuErrorBanner`、[ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md)）でしたが、
ADR-0017 で中央の `ErrorDialog` に置き換えました（バナーは廃止）。ADR-0011 の要件（本文を要約しない・複数でも
最初のエラーを隠さない・不透明・最前面）は引き継いでいます。「閉じる」は現在のエラーを一覧（`viewer.gpuErrors`）から
消しますが、このセッションの全履歴（`viewer.errorHistory`）には残り、ステータスバーの「ログ」ボタンが同じダイアログを
履歴モードで開きます。設計の経緯は [renderer の章](./renderer.md#エラーの表示-gpu-error-logts--gpuerrorbannertsx)も参照してください。

変換ダイアログ（`ConversionDialog`）は長時間のLAS/LAZ→COPC変換だけが対象で、ノードの逐次読み込みの進捗は
ステータスバーに出ます。

## まず読むファイル

- [`src/ui/shell/AppShell.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/AppShell.tsx) — 組み立て役。ここから各部品を辿る
- [`src/ui/shell/Ribbon.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/Ribbon.tsx) — 上部リボン。4グループの束ね役
- [`src/ui/shell/LayerPanel.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/LayerPanel.tsx) — 左パネル。レイヤーツリー+情報の束ね役
- [`src/ui/shell/SettingsModal.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/SettingsModal.tsx) — モバイル最適化・テーマ・更新チェックの設定
