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

- `status` — ほぼ全部の hook が書くため（hook に入れても同じ引数を持ち回るだけ）。型は `viewer-status.ts` の判別共用体 `ViewerStatus`（`idle`／`opening`／`converting`／`ready`／`error`。`error` だけが `message` を持つ）。読む側は `isFileOpenBusy`・`openButtonLabel`・`statusErrorMessage`・`isOpenRunningOrDone` を使う。変換中のファイル名と進捗は、`converting` になる前や `ready` になった後にも読まれるため、共用体に入れず `useConversionSession` が持つ。
- `rendererRef`・`sourceRef`・`toolRunningRef` — `useDisplaySettings` が `rendererRef` を、`useRendererLifecycle` が `useDisplaySettings` の `onStats` を必要とする循環を、ref を組み立て側で作ることで避けている。
  `toolRunningRef` は `useConversionSession`（ツールの進捗イベントを変換と取り違えないため）と `usePointCloudTools`（立てる側）が共有する。
- `pickPoint`・`getViewSnapshot` — renderer への 15 行ほどの素通し。
- `CopcViewerState` に使う型の再エクスポート（`src/ui` が renderer／datasource の型に届くには state を通す、という規約のため）。

### `viewer.xxx` から実装へ辿る

`CopcViewerState`（[`viewer-types.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/viewer-types.ts)）は、フィールドを自分では宣言せず、
各 hook の interface から `Pick<Layers, "layers" | ...> & Pick<DisplaySettings, ...> & ...` で選んで束ねています。
**フィールドの型と説明文は、それを作る hook の interface に1回だけ**書かれています（`useFileOpen.ts` の `FileOpen`、`useLayers.ts` の `Layers` など）。
`viewer-types.ts` に直接書いてあるのは、`useCopcViewer` 自身が作る `status`・`isBrowser`・`pickPoint`・`getViewSnapshot` だけです。

たとえば `OpenFileButton.tsx` の `viewer.openFiles(picked)` で、`openFiles` の上で F12（定義へ移動）を押すと、
`src/state/useFileOpen.ts` の `interface FileOpen` の `openFiles` に飛びます（ホバーすると、そこに書いた説明文が出ます）。
実装は同じファイルの下の `useFileOpen()` の中にあります。

フィールドを足す・消すときは、①その hook の interface ②`viewer-types.ts` の `Pick` の名前の並び ③`useCopcViewer.ts` の `state`（明示的な一覧。スプレッドにしないのは、hook の内部用の値を UI に見せないため）の3か所を揃えます。

呼び出し順には意味が一箇所あります。`useRendererLifecycle` が effect の中で `sourceRef` を埋め、`useConversionSession` の effect がそれを読むので、
**lifecycle を先に呼ぶ**（effect は呼んだ順に動く）。

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
| `useFileOpen.ts` | `openFile`・`openFiles`・`addOpenedLayer` | `useFileOpen(deps)` |
| `useConversionSession.ts` | 変換の進捗・変換元の名前・完了/失敗イベントの購読・完了待ちの結果・キャンセル・内訳のコピー | `useConversionSession(deps)` |
| `usePointCloudTools.ts` | 選択・断面・結合を「新しいレイヤーを作る」形で実行（ADR-0018）、ツールの進捗・キャンセル | `usePointCloudTools(deps)` |
| `useOpfsStorage.ts` | Web の保存領域の使用量と掃除（設定ページ用） | `useOpfsStorage()` |
| `useTempDir.ts` | デスクトップの一時フォルダ設定（localStorage）と `supportsCustomTempDir` | `useTempDir()` |
| `error-history.ts` | 純粋: 現在のエラー一覧を履歴に統合 | `mergeErrorHistory` |
| `open-file-text.ts` | 純粋: ファイル名の取り出し・容量不足の文 | `basenameOfPath`・`extensionOfFileName`・`describeInsufficientSpaceDesktop` |
| `stats-summary.ts` | 純粋: バックエンドのコンソールへ送る統計1行 | `formatStatsSummary` |

hook は **依存を引数で受け取り**、お互いを import しません（例: `useFileOpen` は `conversion`・`display`・レイヤーの ref を引数で受ける）。
`useFileOpen` の先頭のコメントを読めば、何に依存しているかが分かります。
`openFileRef` は `useConversionSession` が持ち、`useFileOpen` が毎レンダー後に最新の `openFile` を代入します
（イベントは一度だけ購読するが、呼ぶのは常に最新の `openFile`、というパターン。両側のコメントに握手の説明があります）。

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
- `useLayerTool.ts` — 点の選択（画面上の多角形）と断面（2点を結ぶ線）のマウス操作。結果は `viewer.extractFromLayer` で新しいレイヤーになる。
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
| 変換の途中経過 | `useConversionSession` |
| 端末ごとの既定値 | `defaultRenderSettings(readDeviceProfileInput())`（`src/renderer/device-profile.ts`）。`useDisplaySettings` と `PointCloudRenderer` のコンストラクタが同じ純粋関数を同じ入力で呼ぶので、握手なしで一致する |
| 保存される設定 | テーマ・アニメーション・単位・更新確認・一時フォルダ（[設定と単位](../flows/settings.md)）。ほかは保存されない |

## まず読むファイル

- [`src/state/useCopcViewer.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useCopcViewer.ts) — 約200行。ここから各 hook へ。各 hook の先頭コメントに「次に読むファイル」が書いてある
- [`src/state/useLayers.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useLayers.ts) — レイヤー操作の中心
- [`src/state/useFileOpen.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useFileOpen.ts) — ファイルを開く（一番長い関数がある）
