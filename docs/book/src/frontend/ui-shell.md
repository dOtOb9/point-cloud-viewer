# src/ui: 画面の部品

`src/ui/` は [ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md)（ガラスの質感）と
[ADR-0017](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0017-ui-shell-ribbon.md)（レイアウトの再構築）が決めた UI シェルの実装です。3D ビューを
ウィンドウ全面に敷き、UI はその上に浮かぶ半透明のガラス面として構成する方針（ADR-0005）は変わっていません。
レイアウト自体は、デスクトップの点群/GIS 系ソフトに多い「上部ツールバー + 左レイヤーツリー + 下部ステータスバー」に
2026-10 に再構築しました（ADR-0017）。

R2（[`TaskSheets/R2-ui-components.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R2-ui-components.md)）で、
`src/ui/shell/` に37ファイルが混在していたのを**役割ごとのフォルダ**に分け、大きなファイルを「1ファイル1つの見える部品」に割りました。見た目と動作は変えていません。

## フォルダの地図

| フォルダ | 主なファイル | 役割 |
|---|---|---|
| `shell/` | `AppShell.tsx`・`ViewerPanel.tsx`・`UnsupportedDeviceScreen.tsx` | 画面全体の組み立て。**読み始めはここ** |
| `toolbar/` | `Toolbar.tsx`・`ToolbarButton.tsx`・`ToolbarSeparator.tsx`・`toolbar-state.ts`・`toolbar-styles.ts`・`useToolbarDragScroll.ts`・`buttons/`（ボタン1つ1ファイル） | 上部のツールバー（グループ見出しなしの1列。区切り線で仕切る） |
| `layers/` | `LayerPanel.tsx`・`LayerList.tsx`・`LayerContextMenu.tsx`・`LayerActions.tsx`・`LayerInfoSection.tsx`・`ConversionBreakdownPanel.tsx`・`LayerStatsDetails.tsx`・`layer-delete-key.ts` | 左のレイヤー欄（一覧・右クリックメニュー・操作ボタン・情報・変換の内訳・詳細統計） |
| `dialogs/` | `Dialog.tsx`・`dialog-styles.ts`・`CloseButton.tsx`・`OptionRow.tsx`・`ColorModeDialog.tsx`・`AppearanceDialog.tsx`・`ConversionDialog.tsx`・`ErrorDialog.tsx` | 共通のダイアログ枠と、設定・ツール以外のダイアログ |
| `settings/` | `SettingsModal.tsx`・`SettingsPageDialog.tsx`・`settings-nav.ts`・`pages/*.tsx` | 設定の一覧と、1ページ1ファイルの設定ページ |
| `tools/` | `MeasureOverlay.tsx`・`MeasurementShape.tsx`・`measure-frame.ts`・`MeasureHud.tsx`・`LayerToolOverlay.tsx`・`SectionDialog.tsx`・`ToolProgressDialog.tsx` | 3D ビューの上に重ねるもの、計測・点の選択・断面のダイアログ |
| `status/` | `StatusBar.tsx`・`UpdateNotice.tsx` | 下部のステータスバーと更新通知 |
| `common/` | `glass.ts`・`crs-format.ts`・`useTransitionMount.ts` | 複数のフォルダが使う小さな部品 |

テストは各ファイルの隣にあります（`*.test.ts(x)`）。クラス名の文字列だけのファイル（`toolbar-styles.ts`・`dialog-styles.ts`）は、使う側のフォルダに置いてあります。

## 組み立て役: `AppShell.tsx`

[`AppShell.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/AppShell.tsx) が `useCopcViewer()`・`useTheme()`・`useWebGpuSupport()`・`useUpdateCheck()`・
`useMeasureTool()`・`useLayerTool()`・`useFileDrop()` をここで一度だけ呼び、各部品へ props で配ります。
すべての部品は `ViewerPanel`（`<canvas>` だけを敷く dumb な部品）の上に重ねた絶対配置の層です。
`viewer`（`CopcViewerState`）は**まるごと** props で渡しています（必要な値だけに絞る整理は未着手）。

```
<div class="fixed inset-0">
  <ViewerPanel />                 ← 3Dビュー(canvas)、全面
  <MeasureOverlay /> <MeasureHud /> <LayerToolOverlay />   ← 3Dビューの上: 計測の線とラベル、案内、点の選択・断面の描画
  <Toolbar />                     ← 上部、1列のボタン（開く｜計測・選択・断面・結合｜設定）
  <LayerPanel />                  ← 左、レイヤー一覧+操作ボタン+レイヤー情報、折りたたみ可
  <StatusBar />                   ← 下部、1行（表示点数/予算・fps・CRS・読み込み進捗・ログ）
  <SettingsModal />               ← 不透明なモーダル（一覧 → 項目ごとのダイアログ）
  <SectionDialog /> <ToolProgressDialog />                 ← 断面の厚み・高さ範囲、点群ツールの進捗
  <ConversionDialog />            ← 中央ダイアログ「変換中」
  <UpdateNotice />                ← 更新通知
  <ErrorDialog />                 ← 中央ダイアログ「エラー」。z-50、最前面。履歴モードもある
  （ドラッグ中だけ「ここにドロップして開く」の案内）
</div>
```

`AppShell` は、計測と「点の選択・断面」が同時に動かないよう、片方を始めるときにもう片方の `stop()` を呼びます。
「変換が始まった」「新しいエラーが出た」も `AppShell` が検出し、対応するダイアログを自動で開きます
（描画中に前回の値と比べる書き方。effect の中の `setState` を避けるため）。

768px 未満（`useNarrowViewport`）では `Toolbar` が端まで広がって角丸をやめ（幅が足りなければ横スクロール）、
`LayerPanel` は画面を覆うドロワーになります（`Toolbar.tsx`／`LayerPanel.tsx` 参照）。

WebGPU が非対応と確定した場合（`useWebGpuSupport().result.supported === false`）は、
`AppShell` がこの全体を [`UnsupportedDeviceScreen`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/UnsupportedDeviceScreen.tsx) に差し替えます
（[ADR-0002](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0002-rendering-api.md) が WebGL2 フォールバックを作らないと決めたため、白画面のまま
放置せず「未対応」と明示する必要があります）。

## 各部品

| 部品 | 内容 |
|---|---|
| [`Toolbar.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/toolbar/Toolbar.tsx)（上部） | ボタンを1列に並べるだけ。順に「開く」（`buttons/OpenFileButton.tsx`: どちらも `ToolbarButton`。ファイルの選び方の違いは `datasource/file-picker.ts` の `pickFilesToOpen` が吸収する。ダイアログを開けなかったときは `viewer.reportError` でバナーに出す）｜距離・高さ・面積（`MeasureButton.tsx`）・点の選択（`SelectPointsButton.tsx`）・断面（`SectionButton.tsx`）・複数レイヤー（`MergeLayersButton.tsx`）｜設定（`SettingsButton.tsx`）。各ボタンが「いつ押せるか」を自分のファイルで決める |
| [`LayerPanel.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/layers/LayerPanel.tsx)（左） | レイヤー一覧（`LayerList.tsx`: 表示チェック・選択・ダブルクリックで移動・右クリックメニュー）+ 操作ボタン（`LayerActions.tsx`: 着色・見た目・移動・削除）+ レイヤー情報（`LayerInfoSection.tsx`: ファイル名・点数・CRS・範囲・変換の進捗/内訳/エラー。計測レイヤーのときは計測結果）+ 詳細統計（`LayerStatsDetails.tsx`、折りたたみ） |
| [`StatusBar.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/status/StatusBar.tsx)（下部、1行） | 表示点数/点予算、fps、CRS、読み込み進捗、エラーログを開くボタン |
| [`SettingsModal.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/settings/SettingsModal.tsx) | 設定の一覧（アイコン+名前のボタン）。押すと `pages/*.tsx` の専用ダイアログへ。詳しくは[設定と単位](../flows/settings.md) |
| [`Dialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/dialogs/Dialog.tsx) | 設定・変換・エラーが共通で使う中央ダイアログ枠(不透明、Esc/✕、フォーカス移動、狭幅は全幅近く) |
| [`ColorModeDialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/dialogs/ColorModeDialog.tsx)・[`AppearanceDialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/dialogs/AppearanceDialog.tsx) | 選択中のレイヤーの着色／点の形と大きさ。`LayerActions` が開閉を持ち、`document.body` へ portal で出す |
| [`ConversionDialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/dialogs/ConversionDialog.tsx) | 変換の進捗・結果(「変換中」、キャンセル) |
| [`ErrorDialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/dialogs/ErrorDialog.tsx) | エラー(コピー・閉じる)と、このセッションの全エラー履歴（[エラーの流れ](../flows/errors.md)） |
| [`MeasureOverlay.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/tools/MeasureOverlay.tsx) | 計測の線・頂点・ラベルを SVG で 3D ビューに重ねる（[計測](../flows/measure.md)） |

**CRS の表示:** `LayerInfoSection` は `CloudInfo.crs`（Rust 側 `pcv_core::crs::CrsInfo`）を `src/ui/common/crs-format.ts` の `formatCrsLong` で文字列にして出します。
読み取りに失敗しても（`crs.error`）ファイルは開き、本文はエラーログに出ます。CRS が無いファイルは、その旨の表示です。
長さの単位の換算にも `CrsInfo` の係数を使います（[計測](../flows/measure.md)）。

### 以前の `Dock`（ADR-0014、廃止）について

以前は画面下部中央にフローティングの `Dock`（レイヤー/情報パネルの開閉・設定を開くボタン）があり、
そのレイアウトだけ ui-forge という専用ツールの `.ui` ファイルから生成していました（ADR-0014）。
2026-10 の UI シェル再構築（ADR-0017）で、レイアウト全体を手書きの TSX に戻す決定とともに `Dock` 自体を
廃止し、ui-forge への依存もすべて取り除きました。詳細は ADR-0017 の対応表、経緯は
[ADR-0014](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0014-ui-forge.md)（冒頭に「状態: 廃止（ADR-0017で置き換え）」と追記）を参照してください。

## ガラスの質感: `glass.ts`

[`glass.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/common/glass.ts) に `GLASS_SURFACE` として集約されています。`backdrop-blur-md` の上に
`bg-white/65`（ライト）・`dark:bg-slate-950/70`（ダーク）の tint を重ねます。
点群は色が任意で高周波ノイズがあり、tint が薄いと文字が背景依存で読めなくなる
という [ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md) のリスクへの対処です。ダイアログ類（設定・変換・エラーなど、`Dialog.tsx` を使うもの）は
意図的にガラスを使わず、不透明です（設定/ログは密なフォーム・ログの可読性のため、エラーはどんな背景の
上でも確実に読めるようにするため）。UI シェル再構築(ADR-0017)でレイアウトを変えた際も、この区別は
そのまま維持しました(`Toolbar`・`LayerPanel`・`StatusBar`・`UpdateNotice` と、3D ビューの上の `MeasureHud`・`LayerToolOverlay` の案内はガラス、ダイアログ類は不透明)。

ガラスのオン/オフというユーザー設定は無く、常にガラスです（ADR-0017）。ただしモバイル端末では端末プロファイル（`device-profile.ts`）が `glassEnabled` を false にしてぼかしを自動で切り、
`OPAQUE_GLASS_SURFACE`（不透明な tint のみ）に切り替わります（[M3-8](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M3-release-and-update.md)、
GPU 負荷削減の一手段。ユーザーが切り替える設定ではない）。ガラスの fps 比較は、切り替えが無くなったため行いません（ADR-0017 参照）。

## エラー・変換の表示: 中央ダイアログ

設定・変換の進捗・エラーは、共通の [`Dialog.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/dialogs/Dialog.tsx)（タイトルバー・本文・右寄せボタンのフッター）で出します。
エラーは以前は画面最前面のバナー（`GpuErrorBanner`、[ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md)）でしたが、
ADR-0017 で中央の `ErrorDialog` に置き換えました（バナーは廃止）。ADR-0011 の要件（本文を要約しない・複数でも
最初のエラーを隠さない・不透明・最前面）は引き継いでいます。「閉じる」は現在のエラーを一覧（`viewer.gpuErrors`）から
消しますが、このセッションの全履歴（`viewer.errorHistory`）には残り、ステータスバーの「ログ」ボタンが同じダイアログを
履歴モードで開きます。エラーの出どころごとの流れは [エラーの流れ](../flows/errors.md)、仕組みの経緯は [renderer の章](./renderer.md#エラーの表示-gpu-error-logts)を参照してください。

変換ダイアログ（`ConversionDialog`）は長時間のLAS/LAZ→COPC変換だけが対象で、ノードの逐次読み込みの進捗は
ステータスバーに出ます。

## まず読むファイル

- [`src/ui/shell/AppShell.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/AppShell.tsx) — 組み立て役。ここから各部品を辿る
- [`src/ui/toolbar/Toolbar.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/toolbar/Toolbar.tsx) — 上部ツールバー。ボタンを並べる束ね役。各ボタンは `buttons/` に1ファイルずつ
- [`src/ui/layers/LayerPanel.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/layers/LayerPanel.tsx) — 左パネル。レイヤー一覧+操作ボタン+情報の束ね役
- [`src/ui/settings/SettingsModal.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/settings/SettingsModal.tsx) — 設定の一覧。各項目は `pages/` に1ファイルずつ
