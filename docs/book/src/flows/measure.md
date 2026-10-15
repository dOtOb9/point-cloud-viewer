# 計測

## 何をするか

3D ビューをクリックして、距離・高さ・面積を測ります。クリックした位置の 3D 座標は、**GPU が描いた深度を読み戻して**求めます
（点は CPU に残していないため）。測り終えた結果は**計測レイヤー**として一覧に加わり、3D ビューの上に SVG で線とラベルが重なります。
数値は、ファイルの座標系の単位から、利用者が選んだ表示単位（m または ft）へ換算して出します。

## 入口

`src/ui/ribbon/RibbonToolsGroup.tsx` の計測ボタンの `onClick` → `measure.toggle(kind)`
（`kind` は `"distance" | "height" | "area"`）。`measure` は `src/state/useMeasureTool.ts` の `useMeasureTool(viewer, canvasRef)` が返す値で、`AppShell` が作る。

## 流れ

1. `useMeasureTool.ts` の `toggle(kind)` → `reset(kind)` — 計測モードに入る（同じ種類をもう一度押すと抜ける）。点の入力リストを空にし、
   世代番号（`generationRef`）を進めて、それ以前に始まったピックの結果を捨てられるようにする。
   `AppShell` は、計測と「点の選択・断面」（`useLayerTool`）が同時に動かないよう、片方を始めるときにもう片方の `stop()` を呼ぶ。
2. `useMeasureTool.ts` の effect（計測中だけ）— キャンバスに `pointerdown`／`click`／`dblclick`（capture）と、`window` に `keydown`（Esc・Enter）を張る。
   クリックとカメラのドラッグは「押してから離すまでの移動が `CLICK_MOVE_TOLERANCE_PX`（5px）以下か」で見分ける。
   ダブルクリックの二回目の `click`（`detail >= 2`）は無視し、`dblclick` では `stopImmediatePropagation()` して**カメラの fly-to を止め**、面積を閉じる。
3. `addPointAt(cssX, cssY)` — 一つの Promise の鎖（`queueRef`）に載せて、素早い連続クリックも順番に処理する。
   `viewer.pickPoint(cssX, cssY)` を待つ。
4. `src/state/useCopcViewer.ts` の `pickPoint` — `renderer.pickPoint` への素通し。失敗は `reportError("計測の点を取れませんでした: ...")` に流して `null`。
5. `src/renderer/point-cloud-renderer.ts` の `PointCloudRenderer.pickPoint(cssX, cssY)` — **二段階**で 3D 座標を得る（式は `src/renderer/pick-math.ts`）。
   1. 段階1: 直近フレームで描いた深度を `gpu.readDepthWindow(...)`（`gpu-resources.ts`）で、クリック周りの小窓（`COARSE_HALF`）だけ読み戻す。
      `nearestHit` で点のある最も中心に近い画素を選び、`unprojectWindowSample` で粗い 3D 座標にする。
      何も無ければ `null`（背景をクリックした）。
   2. 段階2: 粗い距離 `depthToEyeDistance` を挟む狭い near/far（`refineDepthRange`）の射影で、その画素の周り（`REFINE_HALF`）だけ
      `gpu.renderDepthWindow(...)` で**描き直して**深度を読む。24bit の深度は遠くで粗い（z=3000 で一段約54）ため、near/far を絞って精度を取り戻す。
      成功すれば `{ point, refined: true }`、失敗なら段階1の値を `refined: false` で返す。
   - 逆射影は常に JS の f64（`mat4.ts` の `invert`・`transformPoint`）。600000 台のような大きな座標でも精度が落ちない。
6. `addPointAt` に戻る — 点を `pointsRef` に足す。`autoFinishCount(kind)`（距離・高さは 2 点）に達したら `commit`。面積は `finish`（Enter・ダブルクリック・HUD の「閉じる」）で、3 点以上のとき `commit`。
   背景だったら `showNotice("点がありません")`。
7. `commit(kind, pts)` — `viewer.getViewSnapshot()` から上方向 `up` を取り、`viewer.addMeasurement({ kind, points, up })`。
8. `src/state/useLayers.ts` の `addMeasurement(measurement)` — 元になる点群レイヤー（選択中が点群ならそれ、無ければ最初の点群レイヤー）を探し、
   名前（`距離 1` など。種類ごとの連番）を付けて `makeMeasureLayer`（`src/state/layers.ts`）で計測レイヤーを作り、`commitLayers(addLayerToState(...))`。
   計測レイヤーは `cloudId = -1`、`info.pointCount = 0`、`info.min/max` は測った点の外接箱、**`info.crs` は元の点群レイヤーから引き継ぐ**（単位の換算のため）。
   renderer には入らない。
9. `src/ui/tools/MeasureOverlay.tsx` の `MeasureOverlay` — 見えている計測レイヤーか計測中の入力があるあいだ、`requestAnimationFrame` ごとに
   `viewer.getViewSnapshot()`（`renderer.getViewSnapshot()`: 直近の `viewProj` と `up`）を読み、変わったときだけ state を更新する。
   各レイヤーを `MeasurementShape.tsx` で描く（線は `measurementSegments`、ラベル位置は `labelAnchor`）。重なるラベルは `labelShifts`（`src/renderer/screen-project.ts`）で下にずらす。
   入力中の途中経過（ドラフト）は閉じない形で描く。案内の文は `MeasureHud.tsx`。
10. ラベルの数値 — `src/state/measure.ts` の `measurementLabelLines(m, units)`。計算は `distanceStats`（3D 距離・水平・高さ差）と `polygonStats`（水平面へ射影した面積・周長。重心を引いてから計算し桁落ちを避ける）。
    換算は次の「単位」。

### 単位の換算（CRS の単位と表示単位）

- 座標はファイルの CRS の長さ単位のまま持つ。Rust が WKT から読んだ `CrsInfo.horizontalUnitToMeter`／`verticalUnitToMeter`（m 換算係数）を使う。**水平と垂直で係数が違うことがある**（autzen は水平が international foot、垂直が US survey foot）。
- `src/state/units.ts` の `lengthUnitsFor(crs, display)` が `LengthUnits` を作る。`formatLength`・`formatArea`・`formatDistance3d` が「ファイル単位 → m → 表示単位」と換算して文字列にする。
  水平の量（水平距離・面積・周長）は水平係数、垂直の量（高さ）は垂直係数。表示の ft は international foot（0.3048 m）。
- **係数が不明（`null`）のときは換算しない。** 数字をそのまま出し、「座標の単位（m かどうか不明）」と添える（m だと思い込ませない）。
- 表示単位は `src/state/useDisplayUnit.ts`（モジュール単位の小さなストア。`useDisplayUnit()` が `[unit, setDisplayUnit]` を返す）。設定の「単位」ページが書き、`MeasureOverlay`・レイヤー情報が読む（[設定と単位](./settings.md)）。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| 計測中の種類（`mode`）・入力済みの点（`points`）・通知（`notice`） | `useMeasureTool`（`AppShell` が作る。`CopcViewerState` には入らない） |
| 計測レイヤーの一覧への追加（`addMeasurement`）・連番（`measureCountersRef`） | `useLayers` |
| 直近の `viewProj`・深度の読み戻し | `PointCloudRenderer`（`getViewSnapshot`・`pickPoint`） |
| 表示単位 | `useDisplayUnit`（localStorage `pcv-display-unit`） |
| 計算・ラベル・線の形 | `src/state/measure.ts`（純粋関数。React にも WebGPU にも依存しない） |

## 関連と落とし穴

- `TaskSheets/L2-layer-tools.md`（L2-D の記録: SVG にした理由・深度読み戻しにした理由）、[ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md)。
- 計測の線は DOM の SVG で、WebGPU のパイプラインを足していない。ラベルに DOM が要るので二系統にしないため。代わりに**線は点群に隠れず常に手前に出る**（測るときは見失わないほうが大事、という判断）。
- ピックは非同期（GPU からの読み戻し）。計測を止める・種類を替えるとき、途中のピックの結果を `generationRef` で捨てないと、止めたあとに点が足される。
- 深度の段階1だけだと、遠くの点で数十単位ずれる。段階2は省かないこと（`pick-math.ts` 冒頭の説明）。
- 計測レイヤーでは着色・見た目・`source.close` は使えない（[レイヤー操作](./layers.md)）。
- `data-testid="measure-overlay"`・`measure-hud`・`measure-label` を画面確認・単体テストが使う（リポジトリの E2E は使っていない）。UI を作り直すときは付け直すこと。
