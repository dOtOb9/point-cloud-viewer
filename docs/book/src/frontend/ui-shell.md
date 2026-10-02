# src/ui/shell: 画面の部品

`src/ui/shell/` は [ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md) が決めた UI シェルの実装です。3D ビューを
ウィンドウ全面に敷き、UI はその上に浮かぶ半透明のガラス面として構成します。

## 組み立て役: `AppShell.tsx`

[`AppShell.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/AppShell.tsx) が `useCopcViewer()`・`useTheme()`・`useWebGpuSupport()`・`useUpdateCheck()`
をここで一度だけ呼び、各パネルへ props で配ります。すべてのパネルは
`ViewerPanel`（`<canvas>` だけを敷く dumb な部品）の上に重ねた絶対配置の層です。

```
<div class="fixed inset-0">
  <ViewerPanel />                 ← 3Dビュー(canvas)、全面
  <LayerPanel />                  ← 左、折りたたみ可
  <InfoPanel />                   ← 右、折りたたみ可
  <Dock />                        ← 下部中央、フローティング
  <SettingsModal />                ← 不透明なモーダル
  <UpdateNotice />                 ← 更新通知
  <GpuErrorBanner />               ← z-50、最前面
</div>
```

WebGPU が非対応と確定した場合（`useWebGpuSupport().result.supported === false`）は、
`AppShell` がこの全体を [`UnsupportedDeviceScreen`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/UnsupportedDeviceScreen.tsx) に差し替えます
（[ADR-0002](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0002-rendering-api.md) が WebGL2 フォールバックを作らないと決めたため、白画面のまま
放置せず「未対応」と明示する必要があります）。

## 各パネル

| パネル | 内容 |
|---|---|
| [`LayerPanel.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/LayerPanel.tsx)（左） | ファイルを開く、点予算、背景、グリッド、着色モード、変換の進捗 |
| [`InfoPanel.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/InfoPanel.tsx)（右） | 点数、描画中のノード数、fps、カメラの姿勢 |
| [`Dock.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/Dock.tsx)（下部中央） | レイヤー/情報パネルの開閉、設定を開くボタン |
| [`SettingsModal.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/SettingsModal.tsx) | モバイル向け最適化、テーマ、更新チェックの設定、診断パネル |

**EDL のオン/オフは `SettingsModal`（設定画面）にあります。** `LayerPanel` には
ありません。これは当初 `LayerPanel` にあったものが、[M3-8](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M3-release-and-update.md) のモバイル最適化
作業で、レンダースケール・点の形・ガラス表現・点予算の上限と並ぶ「モバイル最適化」
節の1項目として `SettingsModal` へ移設されたためです。タスクシートの古い記述
（`LayerPanel` にあるという説明）はこの移設前のもので、**コードが正**です。

## ガラスの質感: `glass.ts`

[`glass.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/glass.ts) に `GLASS_SURFACE` として集約されています。`backdrop-blur-md` の上に
`bg-white/65`（ライト）・`dark:bg-slate-950/70`（ダーク）の tint を重ねます。
点群は色が任意で高周波ノイズがあり、tint が薄いと文字が背景依存で読めなくなる
という [ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md) のリスクへの対処です。`SettingsModal` と `GpuErrorBanner` だけは
意図的にガラスを使わず、不透明です（前者は密な設定フォームの可読性のため、
後者はどんな背景の上でも確実に読めるようにするため）。

モバイルでは `glassEnabled` を false にすることでガラス表現自体をオフにでき、
`OPAQUE_GLASS_SURFACE`（不透明な tint のみ）に切り替わります（[M3-8](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M3-release-and-update.md)、
GPU 負荷削減の一手段）。**ガラスの fps への影響自体は、所有者の実機計測待ちで
未計測のままです**（[ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md) が計測すると決めた項目）。

## エラーの表示: `GpuErrorBanner.tsx`

[`GpuErrorBanner.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/GpuErrorBanner.tsx) は `z-50` で他のすべての面より前面に表示される、**意図的に
不透明な**バナーです。WebGPU のエラーとノード読み出しの失敗を `source` で
見出しを出し分けながら表示します。本文はそのまま表示し、要約しません。
複数のエラーが出ても最初のエラーを隠さず、個別に閉じられます。設計の経緯は
[renderer の章](./renderer.md#エラーの表示-gpu-error-logts--gpuerrorbannertsx)と [ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md) を参照してください。

## まず読むファイル

- [`src/ui/shell/AppShell.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/AppShell.tsx) — 組み立て役。ここから各パネルを辿る
- [`src/ui/shell/SettingsModal.tsx`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/ui/shell/SettingsModal.tsx) — EDL を含むモバイル最適化の切り替え
