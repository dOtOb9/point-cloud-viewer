# 起動からビューアが動くまで

## 何をするか

ページ（または Tauri のウィンドウ）が開いたとき、React の木を作り、WebGPU が使えるかを確かめ、
`<canvas>` にレンダラとデータソースを結び付けて、毎フレームの描画ループを始めます。
ここまでで画面には空のビューアが出ます（点群はまだ開いていません）。

## 入口

`src/main.tsx`（`ReactDOM.createRoot(...).render(<AppShell />)`。`React.StrictMode` で包んである）。

## 流れ

1. `src/main.tsx` — `AppShell` を描画する。
2. `src/ui/shell/AppShell.tsx` の `AppShell` — state の hook をここで**一度だけ**呼ぶ。
   `useCopcViewer()`・`useTheme()`・`useWebGpuSupport()`・`useUpdateCheck()`・`useMeasureTool()`・`useLayerTool()`・`useFileDrop()`。
3. `src/state/useWebGpuSupport.ts` の `useWebGpuSupport` — effect の中で `src/renderer/webgpu-probe.ts` の
   `probeWebGpu()`（`navigator.gpu` と `requestAdapter()` の確認だけ。描画はしない）を呼ぶ。
   結果が `status: "done"` で `supported: false` なら、`AppShell` は全体を
   `src/ui/shell/UnsupportedDeviceScreen.tsx` に差し替えて終わる（WebGL2 には落とさない。ADR-0002）。
4. `src/state/useCopcViewer.ts` の `useCopcViewer` — 関心ごとごとの hook を**決まった順に**呼んで組み立てる:
   `useErrorLog` → `useDisplaySettings` → `useRendererLifecycle` → `useLayers` → `useOpfsStorage` → `useTempDir` →
   `useConversionSession` → `useFileOpen` → `usePointCloudTools`。
   `rendererRef`・`sourceRef` はここで作る（`useDisplaySettings` が `rendererRef` を、`useRendererLifecycle` が
   `useDisplaySettings` の `onStats` を必要とする循環を、ref を組み立て側で作ることで避けている）。
   `useRendererLifecycle` を `useConversionSession` より前に呼ぶ順序には意味がある（5. が `sourceRef` を埋め、
   `useConversionSession` の effect がそれを読む。effect は呼んだ順に動く）。
5. `src/state/useRendererLifecycle.ts` の `useRendererLifecycle` — マウント時の effect（一度だけ）で次をする。
   - `new PointCloudRenderer(canvas)` を作り `rendererRef` に入れる。
   - `isTauriEnvironment()`（`src/datasource/environment.ts`）で `new TauriSource()`（`src/datasource/tauri.ts`）か
     `new WebSource()`（`src/datasource/web.ts`。中で Web Worker を一本作る）を選び `sourceRef` に入れる。
     **この二択をするのはここだけ**。
   - 保存済みのアニメーション設定を `renderer.setAnimationEnabled` で反映する。
   - コールバックを結ぶ: `renderer.onStatsUpdate`（→ `display.onStats`）、`renderer.onGpuErrorReported`、
     `renderer.onNodeLoadErrorReported`（後ろの二つは `reportError` へ。[エラーの流れ](./errors.md)）。
   - `renderer.init()` が成功したら `renderer.start()`。失敗したら `setError(String(e))`。
   - `window` の `resize` を購読し `renderer.resize(...)` を呼ぶ。アンマウントで `renderer.dispose()`。
6. `src/renderer/point-cloud-renderer.ts` の `PointCloudRenderer` のコンストラクタ — `defaultRenderSettings(readDeviceProfileInput())`
   （`src/renderer/device-profile.ts`）で、モバイル判定・レンダースケール・点の形・EDL・点予算の既定値を決める。
   `NodeCache`・`NodeLoader`・`GpuResources` を作る（`NodeLoader` は一つで全レイヤーを扱う）。
   同じ関数を `useDisplaySettings` も呼ぶので、初期値は握手なしで一致する。
7. `PointCloudRenderer.init()` → `src/renderer/gpu-resources.ts` の `GpuResources.init()`（中の `setupDevice()`）—
   `navigator.gpu.requestAdapter()` → `requestDevice()` → `canvas.getContext("webgpu")`。`device.onuncapturederror`
   と `device.lost` の監視をここで張る。パイプラインの生成は `initWithErrorScope` で一つずつ囲み、
   失敗したら「どの生成が失敗したか」が分かるメッセージにする。
   続いて `PointCloudRenderer.init()` が `attachOrbitControls`（`src/renderer/orbit-camera.ts`）でマウス・タッチ操作をつなぐ。
8. `PointCloudRenderer.start()` — `requestAnimationFrame` のループを始める。毎フレーム `renderOnce(time)` が呼ばれる
   （[毎フレームの描画](./render-frame.md)）。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| `canvasRef` | `useCopcViewer`（`AppShell` が受け取り、`ViewerPanel` が `<canvas>` に付ける） |
| `rendererRef`・`sourceRef` | `useCopcViewer` が作り、`useRendererLifecycle` が中身を入れる |
| `status`・`error` | `useCopcViewer`（ほぼ全部の hook が書くため、組み立てファイルに残してある） |
| WebGPU 対応の判定 | `useWebGpuSupport`（`AppShell` だけが使う） |
| 端末ごとの既定値 | `useDisplaySettings` の `deviceProfileDefaults` |

## 関連と落とし穴

- [R1-state-refactor.md](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R1-state-refactor.md)（hook を分けた理由）、
  [ADR-0002](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0002-rendering-api.md)（WebGL2 フォールバックを作らない）、
  [ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md)（Web は Worker）。
- hook の呼び出し順を入れ替えると、`sourceRef.current` がまだ空のうちに `useConversionSession` の effect が読む。
  `useCopcViewer.ts` の呼び出し部分のコメントを読んでから動かすこと。
- `React.StrictMode` の開発時は effect が二回動く（作る → 破棄 → 作る）。`dispose()` が後始末を落とすと、
  GPU デバイスやイベント購読が二重になる。
- `useCopcViewer()` を二箇所で呼ぶと、レンダラが二つ作られる。呼ぶのは `AppShell` だけ。
- URL に `?pcvDebug` を付けると `window.__pcvRenderer` に renderer が出る（実ブラウザでの計測用）。
