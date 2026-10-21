# src/state: React とレンダラをつなぐ

`src/state/` は、[規約3](../conventions.md#規約3-srcrenderer-は-react-を知らない) の境界を実際に跨ぐ層です。
`src/renderer/` は React を知らず、`src/ui/` はレンダラを直接触りません。
その間を取り持つのがここにあるフックです。

以前は `useCopcViewer.ts` が1,500行の1ファイル（`useState`／`useRef` が約40、250行の mount effect、200行級の関数が二つ）でしたが、
R1（[`TaskSheets/R1-state-refactor.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R1-state-refactor.md)）で
**関心ごとごとの hook に分け**、`useCopcViewer.ts` は組み立てだけのファイル（約200行）になりました。
外から見た形（`useCopcViewer()` が `[canvasRef, CopcViewerState]` を返す。`CopcViewerState` の各フィールドの名前と意味）は変えていません。

## 組み立て役: `useCopcViewer.ts`

[`useCopcViewer()`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useCopcViewer.ts) が、下の hook を決まった順に呼んで `CopcViewerState` に束ねます。
`AppShell.tsx` がこれを**1回だけ**呼び、各パネルへ props として配ります（複数箇所で呼ぶと `PointCloudRenderer` が複数生成されてしまうため）。

ここに残してあるものは次のとおりです。

- `status` — ほぼ全部の hook が書くため（hook に入れても同じ引数を持ち回るだけ）。型は `viewer-status.ts` の判別共用体 `ViewerStatus`（`idle`／`opening`／`converting`／`ready`／`error`。`error` だけが `message` を持つ）。読む側は `isFileOpenBusy`・`openButtonLabel`・`statusErrorMessage`・`isOpenRunningOrDone` を使う。変換中のファイル名と進捗は、`converting` になる前や `ready` になった後にも読まれるため、共用体に入れず `useFileOpen` の `useState` が持つ（`openFiles` が `OpenFilesContext` 越しに書く）。
- `rendererRef`・`sourceRef` — `useDisplaySettings` が `rendererRef` を、`useRendererLifecycle` が `useDisplaySettings` の `onStats` を必要とする循環を、ref を組み立て側で作ることで避けている。
- `toolLock`（`{ running: boolean }`。`useCopcViewer.ts` が `useState` で一度だけ作る素のオブジェクト）— `openFiles`（`ctx.isToolRunning()` 経由。ツールの進捗イベントを変換と取り違えないため）と `src/app/point-cloud-tools.ts`（立てる側）が共有する。`openLock` と同じ考え方。
- `pickPoint`・`getViewSnapshot` — renderer への 15 行ほどの素通し。
- `CopcViewerState` に使う型の再エクスポート（`src/ui` が renderer／datasource の型に届くには state を通す、という規約のため）。

### `viewer.xxx` から実装へ辿る

`CopcViewerState`（[`viewer-types.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/viewer-types.ts)）は、フィールドを自分では宣言せず、
各 hook の interface から `Pick<Layers, "layers" | ...> & Pick<DisplaySettings, ...> & ...` で選んで束ねています。
**フィールドの型と説明文は、それを作る hook の interface に1回だけ**書かれています（`useLayers.ts` の `Layers`、`useDisplaySettings.ts` の `DisplaySettings` など。開く操作の `fileOpenContext` などは、フックではなく `viewer-types.ts` に直接書いてある）。
`viewer-types.ts` に直接書いてあるのは、`useCopcViewer` 自身が作る `status`・`isBrowser`・`pickPoint`・`getViewSnapshot` と、`useFileOpen` 由来の `fileOpenContext`・`conversionProgress`・`convertingFileName`、それに `copyConversionBreakdownText` です。

ただし開く操作は、`viewer.xxx` を通さず、UI が `src/app/open-files.ts` の関数を直接 import して呼びます。
たとえば `OpenFileButton.tsx` の `openFiles(viewer.fileOpenContext, picked)` で、`openFiles` の上で F12（定義へ移動）を押すと、
実装の `src/app/open-files.ts` の `openFiles` に着きます（TypeScript の言語サービスで確かめた: R13 の記録）。`viewer.fileOpenContext` は、その関数が読み書きするものを束ねたオブジェクトです。

フィールドを足す・消すときは、①その hook の interface ②`viewer-types.ts` の `Pick` の名前の並び ③`useCopcViewer.ts` の `state`（明示的な一覧。スプレッドにしないのは、hook の内部用の値を UI に見せないため）の3か所を揃えます。

呼び出し順は `useRendererLifecycle` が先です（effect の中で `sourceRef` を埋める。ほかの hook は `sourceRef.current` を呼ばれた時点で読む）。
R11 で変換の購読の effect が無くなり、R12 で `useConversionSession` 自体を消したので、順序が効く場所はほかにありません(`openFiles` は `sourceRef` を開くときに読む)。

## src/app: React の外で動く処理

「手順を踏む」処理（開く・変換・レイヤー・ツール）は、フックではなく**普通の TypeScript の関数**として `src/app/` に置く方針です
（オーナーの決定 2026-10-18。[R12](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R12-file-opener-outside-react.md)、
[R13](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R13-open-files-as-functions.md)で、クラスをやめて関数にした）。状態は React に置いたまま、関数へ引数として渡します。
今は1つ目の `openFiles`・`addOpenedLayer`・`cancelConversion`（ファイルを開く）だけが移っています。

- `src/app/` は `react`・`use*.ts` のフック・React を import するモジュールを import しない。`src/datasource/`・`src/renderer/`（型と定数）・`src/state/` の React を使わないモジュール（`layers.ts`・`viewer-status.ts` など）は import してよい。
- 関数は、読み書きするものを**1つの引数**（`OpenFilesContext`）で受け取る。ref の中身（レンダラ・DataSource）はゲッターで、必要な瞬間に読む。一時フォルダなどの普通の値は、context を作った描画の時点のもの。
- UI に見せる値（進捗・ファイル名）は、フックが持つ `useState` の setter を context に入れて書かせる。購読の仕組みは要らない。
- 隠れた状態は持たない。共有する可変なものは `ctx.openLock` だけで、渡していることが見える。クラスにするのは、長く生きる資源を持つ物（`PointCloudRenderer`・`WebSource`）だけ。
- テストは React 無しで書ける（`src/app/open-files.test.ts`。偽の `DataSource` と偽のレンダラー）。

使われ方: `useFileOpen.ts`（フック）が、描画のたびに `OpenFilesContext`（`{ getSource, getRenderer, setStatus, reportError, addLayerToList, ... }` の普通のオブジェクト）を作る。
`useCopcViewer.ts` がそれを `fileOpenContext` として `CopcViewerState` に出し、`addOpenedLayer(fileOpenContext, ...)` を `usePointCloudTools` に渡す。ツールも同じ形で、手順は `src/app/point-cloud-tools.ts` の関数、`usePointCloudTools` は進捗の state と `PointCloudToolsContext`（`viewer.toolContext`）を作るだけ。UI は `openFiles(viewer.fileOpenContext, ...)` を直接呼ぶ。
レイヤー一覧はまだ React の state なので、`addLayerToList` で渡している（次の段階で `src/app/` に移す予定）。

## hook の一覧（1ファイル1関心事）

| ファイル | 持つもの | 入口 |
|---|---|---|
| `useCopcViewer.ts` | 組み立て。`status`・各 ref | `useCopcViewer()` |
| `viewer-types.ts` | `CopcViewerState`（各 hook の interface から `Pick` で組み立てる）とその小さな型（`ToolProgressState`・`OpfsStorageInfo`）。型だけ | （型） |
| `viewer-status.ts` | `ViewerStatus`（開く・変換する状態の判別共用体）と、それを読むヘルパー。純粋関数 | `isFileOpenBusy` ほか |
| `useRendererLifecycle.ts` | `PointCloudRenderer` と `TauriSource`／`WebSource` の生成・コールバック接続・リサイズ・破棄 | `useRendererLifecycle(refs, callbacks)` |
| `useErrorLog.ts` | `gpuErrors`・`errorHistory`・`reportError`・`dismissGpuError`（`GpuErrorLog` を包む） | `useErrorLog()` |
| `useDisplaySettings.ts` | 点予算・自動調整・背景・グリッド・EDL・アニメーション・レンダースケール・点の形・中央優先度・`stats`・端末の既定値 | `useDisplaySettings(rendererRef)` |
| `useLayers.ts` | レイヤー一覧と選択、レイヤーごとの操作（表示・着色・形・大きさ・移動・削除）、計測レイヤー | `useLayers(deps)` |
| `useFileOpen.ts` | 変換の進捗・変換元の名前の `useState`、`openLock`、`src/app/open-files.ts` の関数に渡す `OpenFilesContext` を作って返すだけ（約50行） | `useFileOpen(inputs)` |
| `useSectionView.ts` | 2D の断面図パネルの state（開いているレイヤー・点・表示・パネルの大きさ・なぞっている線 `trace`）と `SectionViewContext`（手順は `src/app/section-view.ts`。[カット・断面・合成](../flows/point-cloud-tools.md)の 3-D） | `useSectionView(inputs)` |
| `usePointCloudTools.ts` | ツールの進捗の state と `PointCloudToolsContext`（手順は `src/app/point-cloud-tools.ts`。カット・断面・合成を「新しいレイヤーを作る」形で実行。ADR-0018） | `usePointCloudTools(inputs)` |
| `useOpfsStorage.ts` | Web の保存領域の使用量と掃除（設定ページ用） | `useOpfsStorage()` |
| `useTempDir.ts` | デスクトップの一時フォルダ設定（localStorage）と `supportsCustomTempDir` | `useTempDir()` |
| `error-history.ts` | 純粋: 現在のエラー一覧を履歴に統合 | `mergeErrorHistory` |
| `device-meta.ts` | 純粋: 内訳テキストに付ける端末情報（ファイル名の取り出しは `src/datasource/file-name.ts`、容量不足の文は `prepare-outcome.ts`） | `currentDeviceMeta` |
| `stats-summary.ts` | 純粋: バックエンドのコンソールへ送る統計1行 | `formatStatsSummary` |

hook は **依存を引数で受け取り**、お互いを import しません（例: `usePointCloudTools` は `addOpenedLayer` を引数で受ける）。
各 hook の先頭のコメントを読めば、何に依存しているかが分かります。
開く処理は hook ではなく `src/app/open-files.ts` の関数で、`useCopcViewer.ts` が `useFileOpen` に最新の値を渡し、`addOpenedLayer` を `usePointCloudTools` に渡します。

### 純粋関数のファイル（React に触れない。テストあり）

- `layers.ts` — `ViewerLayer`・`LayersState` と、一覧の編集（`addLayerToState`・`removeLayerFromState`・`selectLayerInState`・`setLayerVisibleInList` など）。
  計測レイヤーの作成 `makeMeasureLayer`・判定 `isMeasureLayer`。
- `layer-selection.ts` — Ctrl／Shift 選択の計算（`toggleSelectedId`・`rangeSelectedIds`・`effectiveSelectedIds`・`toolSourceLayers`）。
- `measure.ts` — 計測の計算とラベル（`distanceStats`・`polygonStats`・`measurementLabelLines`・`measurementSegments`）。
- `units.ts` — 長さの単位の換算（`lengthUnitsFor`・`formatLength` など）。
- `tool-math.ts` — 点の選択・断面の計算（`sectionBox`・`projectToNdc`・`displayLengthToFile`）。
- `motion-setting.ts` — アニメーション設定の保存と `<html data-motion>`。

## 3D ビューの上のマウス操作・その他の hook

次の hook は `CopcViewerState` の一部ではなく、**`AppShell` が個別に呼び**、`CopcViewerState` を入力として受け取ります。

- `useMeasureTool.ts` — 計測のマウス操作（[計測](../flows/measure.md)）。結果は `viewer.addMeasurement` で計測レイヤーになる。
- `useLayerTool.ts` — カット（画面上の多角形）と断面（2点を結ぶ線）のマウス操作。結果は `extractFromLayer(viewer.toolContext, ...)`（`src/app/point-cloud-tools.ts`）で新しいレイヤーになる。
  `usePointCloudTools` が「ツールを走らせる側」、`useLayerTool` が「画面に描く側」。
- `useDisplayUnit.ts` — 表示単位（m／ft）。hook というよりモジュール単位の小さなストア（[設定と単位](../flows/settings.md)）。
- `useFileDrop.ts` — ドラッグ&ドロップで開く（受け取り方の違いは `datasource/file-picker.ts`）（[ファイルを開く](../flows/open-file.md)）。
- `useTheme.ts` — ダーク／ライトの判定。判定（`resolveTheme`）は DOM や `localStorage` に触れない純粋関数で、`useTheme.test.ts` で直接検証。
- `useWebGpuSupport.ts` — `probeWebGpu()` で非対応端末を見分け、`AppShell` が専用画面に差し替える（[起動](../flows/startup.md)）。
- `useUpdateCheck.ts` — 起動時の更新チェック（`tauri dev` 中は走らせない）。
- `useNarrowViewport.ts` — 幅 768px 未満かどうか（ツールバーの角丸・端寄せ・レイヤーパネルのドロワー化）。

## 状態を持つ場所の見分け方

| 知りたいこと | 持ち主 |
|---|---|
| レイヤーの一覧・選択 | `useLayers`（`layersStateRef` が最新、`commitLayers` だけが書く） |
| renderer の中の実際の状態（カメラ・点予算の実値・各レイヤーの描画状態） | `PointCloudRenderer`。React 側の値は写しで、`stats` 経由（500ms ごと）か setter で同期する |
| エラー | `useErrorLog`（出口は `reportError`）と、`useCopcViewer` の `error` |
| 変換の途中経過 | `useFileOpen` の state（`openFiles` が書く） |
| 端末ごとの既定値 | `defaultRenderSettings(readDeviceProfileInput())`（`src/renderer/device-profile.ts`）。`useDisplaySettings` と `PointCloudRenderer` のコンストラクタが同じ純粋関数を同じ入力で呼ぶので、握手なしで一致する |
| 保存される設定 | テーマ・アニメーション・単位・更新確認・一時フォルダ（[設定と単位](../flows/settings.md)）。ほかは保存されない |

## まず読むファイル

- [`src/state/useCopcViewer.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useCopcViewer.ts) — 約200行。ここから各 hook へ。各 hook の先頭コメントに「次に読むファイル」が書いてある
- [`src/state/useLayers.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useLayers.ts) — レイヤー操作の中心
- [`src/app/open-files.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/app/open-files.ts) — ファイルを開く（React を使わない関数。一番長い関数がある）
- [`src/state/useFileOpen.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useFileOpen.ts) — `OpenFilesContext` を作って React につなぐ約50行
