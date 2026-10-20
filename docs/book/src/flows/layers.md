# レイヤー操作

## 何をするか

開いた点群と計測結果は、すべて**レイヤー**として左のパネルに並びます。ここでは、レイヤーの
表示・非表示、選択（クリック／Ctrl／Shift）、着色と見た目、カメラの移動、削除の流れを書きます。
どの操作も「**UI 側の一覧（React）を更新する**」と「**renderer のレイヤーを更新する**」の二つを、`useLayers` が一緒に行います。

## 入口

UI の入口は `src/ui/layers/` の三つ。いずれも最後は `viewer.xxx(...)`（= `src/state/useLayers.ts` の関数）を呼ぶ。

| 操作 | 最初に呼ばれる UI | 呼ばれる viewer の関数 |
|---|---|---|
| 表示・非表示 | `LayerList.tsx` の行のチェックボックス | `setLayerVisible(id, visible)` |
| 選択 | `LayerList.tsx` の行の `onClick` | `selectLayer`／`toggleLayerSelection`（Ctrl・Cmd）／`selectLayerRange`（Shift） |
| 移動 | `LayerList.tsx` の行の `onDoubleClick`、右クリックメニュー（`LayerContextMenu.tsx`）、`LayerActions.tsx` の「移動」 | `focusLayer(id)` |
| 着色 | `LayerActions.tsx` の「着色」→ `src/ui/dialogs/ColorModeDialog.tsx` | `setLayerColorMode(id, mode)` |
| 見た目 | `LayerActions.tsx` の「見た目」→ `src/ui/dialogs/AppearanceDialog.tsx` | `setLayerPointShape(id, shape)`・`setLayerPointSize(id, px)` |
| 削除 | `LayerActions.tsx` の削除ボタン、Delete キー（`layer-delete-key.ts` の `shouldDeleteLayerOnKey`）、右クリックメニュー | `removeLayer(id)` |

## 流れ

### 表示・非表示

1. `useLayers.ts` の `setLayerVisible(id, visible)` — レイヤーがあれば `renderer.setLayerVisible(id, visible)`。
2. `src/renderer/point-cloud-renderer.ts` の `setLayerVisible` — `layer.visible` を変え、グリッドの高さ・大きさを見えているレイヤーに合わせ直す（`updateGridFromVisibleLayers`）。
   非表示のレイヤーは、次のフレームから**ノード選択・読み込み・描画のどれの対象にもならない**。カメラは動かさない。
3. `commitLayers({ ...current, layers: setLayerVisibleInList(...) })`（`src/state/layers.ts`）で一覧を更新。

### 選択（Ctrl／Shift）

1. 通常クリック: `selectLayer(id)` — 追加選択（`extraSelectedIds`）を空にし、`selectLayerInState` で主選択だけにする。
2. Ctrl／Cmd クリック: `toggleLayerSelection(id)` — `src/state/layer-selection.ts` の `toggleSelectedId` で追加・解除。主選択は「最後に選んだもの」。
3. Shift クリック: `selectLayerRange(id)` — `rangeSelectedIds` で主選択から押した行までを選ぶ（主選択は動かさない）。
4. `selectedLayerIds` は `effectiveSelectedIds` で毎回計算する。追加選択のリストは**主選択を含んでいるときだけ信用**する（通常クリック・開く・削除のあとに自然に無効になるので、リセットを書いて回らなくてよい）。
5. 着色・見た目・移動・削除のボタンは**主選択（`selectedLayerId`）**に効く。複数選択を使うのは合成（`src/app/point-cloud-tools.ts` の `mergeSelectedLayers`。`toolSourceLayers`）だけ。

### 着色・見た目

1. `useLayers.ts` の `setLayerColorMode(id, mode)` — `resolveLayerColorMode`（`layers.ts`）で、RGB を持たないレイヤーの `rgb` を標高に落とす。
   計測レイヤーは対象外。`renderer.setLayerColorMode(id, resolved)` を呼び、一覧も更新。
2. `setLayerPointShape`／`setLayerPointSize` — `renderer.setLayerPointShape`／`setLayerPointSize`（大きさは `sanitizePointSize` で丸める）。一覧も更新。
3. renderer 側は `Layer.colorMode`・`Layer.style` を書き換えるだけ。反映は**次のフレーム**（[毎フレームの描画](./render-frame.md) の 8. で着色の uniform、9. で `nodeStyleOf`）。
   形・大きさ・着色はすべて**レイヤーごと**。レイヤーを足すときに形を省くと、端末プロファイルの既定値（`renderer` の `pointShape`、コンストラクタで決まり、後から変えられない）が初期値になる。

### 移動（focusLayer）

1. `useLayers.ts` の `focusLayer(id, orientation?)` — 計測レイヤー（`layer.measurement` あり）は renderer の外にあるので、
   `renderer.focusBox(layer.info.min, layer.info.max)`（点の外接箱へ）。点群レイヤーは `renderer.focusLayer(id, orientation?)`。
2. `PointCloudRenderer.focusLayer` → `moveCameraToLayer(layer, false, orientation)` — `layerFocusBounds`（`src/renderer/layer-focus.ts`）で範囲を決め、
   `camera.setSceneScale`・`applyGridBounds`（グリッドもそのレイヤーに合わせる）・`camera.animateTo(focusGoalFor(...))`。向き（yaw／pitch）は今のまま。

### 削除（removeLayer と source.close）

`useLayers.ts` の `removeLayer(id)` が**この順**で行う（順序に意味がある）。

1. `renderer.removeLayer(id)` — レイヤーを表から外し、`cache.removeByPrefix(keyPrefix)` でそのレイヤーのノードを GPU バッファごと捨て、着色 uniform を `destroy()`。
   読み込み中のノードが後から届いても、通し番号がもう無いので `handleNodeLoaded` が捨てる（`readLayerNode` は `StaleNodeRequestError`）。
2. 変換結果のダウンロード URL があれば `URL.revokeObjectURL`。
3. `commitLayers(removeLayerFromState(...))` — 選択中を消したら残りの先頭を選ぶ。レイヤーが 0 件になり `status` が `"ready"` なら `"idle"` に戻す。
4. 計測レイヤーなら終わり（`DataSource` のファイルを持たない）。点群レイヤーは `sourceRef.current?.close(layer.cloudId)`。
   失敗は黙って捨てず `reportError("ファイルを閉じられませんでした: ...", "node-read")`。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| レイヤー一覧・主選択（`LayersState`）と、それを読む `layersStateRef`、書く `commitLayers` | `useLayers`（一覧は state と ref の二重持ち。書くのは `commitLayers` だけ） |
| 追加選択（`extraSelectedIds`） | `useLayers` |
| レイヤー id の採番（`nextLayerId`、`layer-N`。消しても再利用しない） | `useLayers` |
| 一覧を編集する純粋関数（`addLayerToState`・`removeLayerFromState`・`setLayerVisibleInList` など） | `src/state/layers.ts`（テストあり） |
| Ctrl／Shift の選択計算 | `src/state/layer-selection.ts`（純粋関数） |
| レイヤー固有の描画状態（表示・着色・形・大きさ・範囲・ノード階層） | renderer の `Layer`（`point-cloud-renderer.ts`） |
| `DataSource` 側のファイル（`cloudId`） | `TauriSource`／`WebSource`。`ViewerLayer.cloudId` が対応表 |
| ダイアログの開閉 | `LayerActions.tsx`（`document.body` へ portal。パネルが transform で動くため） |

## 関連と落とし穴

- `TaskSheets/L1-multi-layer.md`・`TaskSheets/L2-layer-tools.md`、[ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md)
  （機能は「選んだレイヤーから新しいレイヤーを作る」形。元のレイヤーは書き換えない）。
- **`ViewerLayer`（React 側）と `Layer`（renderer 側）は別物で、同じ id で結ばれている。** 片方だけ直すとずれる。
  `useLayers` の各関数が「renderer を呼ぶ→一覧を更新する」を対にして持っているので、新しいレイヤー操作を足すときも同じ対にする。
- 計測レイヤーは renderer に居ない（`cloudId = -1`）。着色・見た目・`source.close` は計測レイヤーでは飛ばす。`isMeasureLayer` で見分ける。
- `data-testid="layer-row"`・`layer-actions`・`layer-context-menu` は単体テスト（`LayerActions.test.tsx` など）が使う。UI を作り直すときは付け直すこと。
