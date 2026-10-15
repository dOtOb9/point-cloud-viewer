# 毎フレームの描画

## 何をするか

`requestAnimationFrame` のたびに、カメラを進め、点予算を決め、**見えているレイヤー全部から**今描くノードを選び、
足りないノードをローダーに頼み、選んだノードを WebGPU で描きます。
UI（React）はこの間まったく関わりません。統計だけが 500ms ごとに UI へ戻ります。

## 入口

`src/renderer/point-cloud-renderer.ts` の `PointCloudRenderer.renderOnce(time)`（`start()` が張った `requestAnimationFrame` から毎フレーム呼ばれる）。

## 流れ

1. `renderOnce` — `gpu.isReady()` でなければ何もしない（デバイス消失中など）。fps 用の時刻を `frameTimestamps` に積み、
   `recordFrameDelta(time)` で直近のフレーム間隔を `recentFrameDeltasMs` に積む（同時にリフレッシュ周期の推定
   `updateRefreshIntervalEstimate`、`src/renderer/point-budget.ts`）。
2. **カメラを進める** — `camera.update(経過時間)`（`src/renderer/orbit-camera.ts` の `OrbitCamera`。慣性・ズーム・視点移動）。
   動きを使うかは `motionEnabled()`（設定のアニメーション **かつ** OS の「視差効果を減らす」がオフ）で毎フレーム決める。
3. **点予算を決める**
   - `updateIdleBoost(time)`（HQ-2。判定の本体は `src/renderer/idle-boost.ts` の `stepIdleBoost`）: カメラが `IDLE_BOOST_DELAY_MS`（500ms）
     止まったら点予算を上限（`autoPointBudgetMax`）まで上げ、動いたらその**描く前に**元の値へ戻す。
     止まっている間は AIMD を呼ばない（戻すときに `recentFrameDeltasMs` を捨てて AIMD をやり直す）。
   - `autoAdjustPointBudget(time)`（止まっていないときだけ）: `evaluatePointBudget`（`point-budget.ts`）に直近のフレーム間隔を渡し、
     vsync に間に合っているかで予算を増減する（AIMD）。手で予算を決めると自動調整は止まる（`setPointBudget`）。
   - 予算が変わったら `cache.maxPoints = 予算 × CACHE_BUDGET_MULTIPLIER` も更新する。
4. **行列を作る** — `perspective`・`camera.viewMatrix()`・`multiply`（`src/renderer/mat4.ts`）で `viewProj` を作り、`frustumPlanes`（`frustum.ts`）で視錐台の面を得る。
   `lastViewProj`・`lastView` は保存しておく（ホイール・ダブルクリック・ピックが使う）。
5. **ノードを選ぶ** — `visibleLayers()`（`visible` が真のレイヤーだけ）を `SelectionLayer`（`keyPrefix` と `hierarchy`）にして、
   `src/renderer/node-selection.ts` の `selectNodesForLayers(...)` を呼ぶ（クラスのフィールドに触らない純粋関数）。
   - レイヤーごとに octree の根から子へたどる。視錐台の外（`aabbIntersectsFrustum`）の部分木には降りない。
   - **LOD A**: 点間隔が `MIN_NODE_SPACING_PIXELS`（0.5px）を下回ったノードの子孫は候補にしない（画素より細かい点は読んでも見た目が変わらない）。
   - 候補に `screenSpaceError`（`screen-space-error.ts`）で優先度を付け、中央優先度の重み（`center-priority.ts` の `centerPriorityWeight`）を掛ける。
   - **全レイヤーを一つの候補リストに入れて並べ、点予算を一つだけ共有する**。レイヤーごとに予算を分けない。
   - 予算に収まる範囲で採用し、キャッシュ済みは `toDraw`、未取得は `wanted`。
   ノードのキーは `"<通し番号>:<ノードキー>"`（`src/renderer/layer-key.ts`）で、レイヤーごとに分かれる。
6. **ローダーに頼む** — `loader.setWanted(selection.wanted, (key) => cache.has(key))`（`src/renderer/node-loader.ts` の `NodeLoader`）。
   同時要求数を絞って `readLayerNode(key)` を呼び、キーの前置きからそのレイヤーの `readNode`（= `DataSource.readNode(cloudId, nodeKey)`）に届く。
   届いたら `handleNodeLoaded` → `gpu.createCachedNode` → `cache.set`。そのレイヤーの強度の範囲もここで広げる。
   読み込み中に消されたレイヤーの結果は捨てる（`StaleNodeRequestError`・通し番号が無い場合）。
7. **フェードインの起点** — 初めて `toDraw` に入ったノードに `firstDrawnAtMs = time` を刻む。
8. **レイヤーごとの着色設定を書く** — 見えている各レイヤーについて `ensureColorBuffer(layer)` で uniform バッファを得て、
   `gpu.writeColorSettings(buffer, layer.colorMode, layer.elevationRange, layer.intensityRange ?? {0,0})`。
   標高の範囲は LAS ヘッダーの実データ範囲（`CloudInfo.min/max`）、強度の範囲はノードが届くたびに広げた値。**どちらもレイヤーごと**。
9. **描く** — `DrawFrameOptions`（背景・グリッド・EDL・レンダースケール・`nodeStyle`・カメラ位置・上方向）を組み、
   `src/renderer/gpu-resources.ts` の `GpuResources.drawFrame(viewProj, width, height, selection.toDraw, drawOptions)` を呼ぶ。
   - EDL オン: パス1で点群だけをオフスクリーンの色＋深度へ描く → 空・グリッドをスワップチェーンへ → EDL 合成パス（`edl.ts`）。
   - EDL オフ: 一つのパスで背景と点群を直接スワップチェーンへ描く。
   - ノードごとに `options.nodeStyle(node)`（= `PointCloudRenderer.nodeStyleOf` が**ノードのキーの前置きからレイヤーを引いて**点の形と大きさを返す）で
     丸/四角のパイプラインを選び、点の大きさは `sizePx × renderScale`。着色はノードの bind group が指すレイヤーの uniform バッファが決める。
10. `updateStats(toDraw, time, visibleLayers.length)` — `STATS_INTERVAL_MS`（500ms）ごとに `onStats` を呼ぶ。
    `useDisplaySettings.onStats` が `stats` と、自動調整で変わった点予算を React 側へ写す。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| カメラ・点予算の実値・キャッシュ・ローダー・各レイヤー（`Layer`）・直近の `viewProj` | `PointCloudRenderer`（React は持たない） |
| 画面に出す点予算・fps などのコピー（`stats`） | `useDisplaySettings`（`onStats` で 500ms ごとに更新） |
| 点予算・背景・グリッド・EDL・レンダースケールなどの設定値 | `useDisplaySettings` が React 側に持ち、setter で renderer に流す（[設定と単位](./settings.md)） |
| レイヤーごとの着色・点の形・大きさ | renderer の `Layer.colorMode`・`Layer.style`。UI 側の写しは `useLayers`（[レイヤー操作](./layers.md)） |

## 関連と落とし穴

- [ADR-0009](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0009-adaptive-render-settings.md)・
  [ADR-0010](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0010-lod-priority-and-point-budget.md)（点予算の自動調整。ラチェットの不具合の経緯）、
  `TaskSheets/HQ-high-quality-mode.md`（LOD A・止まったら上限）、`TaskSheets/L1-multi-layer.md`（複数レイヤー）、
  [ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md)（GPU エラーの可視化）。
- **選択の本体は純粋関数、WebGPU を叩くのは `gpu-resources.ts` だけ。** 数式やアルゴリズムを直すなら `vitest` で確かめられる前者、
  描画の見た目なら後者。`point-cloud-renderer.ts` は「いつ何を渡すか」だけを持つ。
- 非表示のレイヤーは選択の対象にならず、ロードも要求されない。表示に戻すとそこから読み直す。
- 標高の範囲を octree のセル（立方体）から取ると「標高が全部同じ色」になる（実機で起きた）。必ず `CloudInfo.min/max`。
- 点予算の自動調整は、60Hz で「下がる一方で二度と増えない」不具合を三段階で直した。`point-budget.ts` を触る前に ADR-0010 の追記を読むこと。
- 緑のテストでも画面は真っ黒になりうる（EDL の `depthStencil` 宣言漏れ）。描画を触ったら実ブラウザで見る。
