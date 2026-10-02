# src/state: React とレンダラをつなぐ

`src/state/` は、[規約3](../conventions.md#規約3-srcrenderer-は-react-を知らない) の境界を実際に跨ぐ層です。
`src/renderer/` は React を知らず、`src/ui/` はレンダラを直接触りません。
その間を取り持つのがここにあるフックです。

## `useCopcViewer.ts`: アプリの中心的な状態

[`useCopcViewer()`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useCopcViewer.ts) が、`<canvas>` への ref と、UI が必要とするほぼすべての状態
（`CopcViewerState`）を返します。`AppShell.tsx` がこれを1回だけ呼び、各パネルへ
props として配ります（複数箇所で呼ぶと `PointCloudRenderer` が複数生成されて
しまうため）。

`CopcViewerState` に含まれるものの一部:

```ts
export interface CopcViewerState {
  status: ViewerStatus;
  error: string | null;
  cloudInfo: CloudInfo | null;
  pointBudget: number;
  autoPointBudgetEnabled: boolean;
  stats: RenderStats | null;
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  edlEnabled: boolean;
  isMobile: boolean;
  renderScale: number;
  pointShape: PointShape;
  colorMode: ColorMode;
  gpuErrors: GpuErrorEntry[];
  conversionProgress: ConversionProgress | null;
  openFile: (pathOrFile: string | File) => Promise<void>;
  cancelConversion: () => void;
  setPointBudget: (budget: number) => void;
  // ... 各設定に対応するsetter
}
```

このフックは実行環境（Tauri か ブラウザか）を [`isTauriEnvironment()`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/environment.ts) で判定し、
`TauriSource`/`WebSource` のどちらを使うかを決めます。[`PointCloudRenderer`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/point-cloud-renderer.ts)
（レンダラ本体）の初期化・`openFile` の呼び出し・統計情報の購読もここで行います。

端末ごとの既定値（点予算の自動調整の上限、レンダースケール、EDL の初期値など）は
`defaultRenderSettings(readDeviceProfileInput())`（[`device-profile.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/device-profile.ts)）を
呼んで決めます。この関数は `AppShell.tsx` も同じ入力で独立に呼んでおり
（ガラス表現の既定値のため）、副作用の無い純粋関数なのでハンドシェイクは
必要ありません（[renderer の章](./renderer.md)参照）。

## `useTheme.ts`: ダーク / ライトの判定

OS の `prefers-color-scheme` への追従と、設定画面からの手動固定
（`system`/`dark`/`light`）を扱います。判定ロジック（`resolveTheme()`）は
DOM や `localStorage` に触れない純粋関数として切り出され、`useTheme.test.ts`
で直接検証されています。

## `useWebGpuSupport.ts` / `useUpdateCheck.ts`

- [`useWebGpuSupport.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useWebGpuSupport.ts) — `navigator.gpu` と `requestAdapter()` の可否を確認し、
  `AppShell.tsx` が非対応端末向けの画面に差し替えるかどうかを決めます
  （[ADR-0002](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0002-rendering-api.md)、[配布の章](../distribution.md)）
- [`useUpdateCheck.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useUpdateCheck.ts) — 起動時の更新チェック（`tauri dev` 中は走らせません）

## 計測用フック（`useIpcBench.ts` / `useNodeConcurrencyBench.ts` / `useWebGpuProbe.ts`）

M0〜M2 で ADR の実測に使われた計測ハーネスで、設定画面の診断パネルに残っています。
いずれもボタンを押すまで実行されません。かつてはマウント時に自動実行していましたが、
**`<details>` で畳んでいても React はマウントを止めないため、起動のたびに重い
計測（IPC ベンチで最大20〜30秒）が走ってアプリがフリーズする**という不具合があり、
ボタン起動に直されています（[落とし穴と教訓](../pitfalls.md)参照）。

## まず読むファイル

- [`src/state/useCopcViewer.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/state/useCopcViewer.ts) — アプリの状態のほぼすべてがここに集まる
- [`src/renderer/device-profile.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/device-profile.ts) — 端末ごとの既定値（`useCopcViewer`/`AppShell`両方から呼ばれる）
