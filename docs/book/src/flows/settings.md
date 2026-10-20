# 設定と単位

## 何をするか

ツールバーの「設定」で開く設定の一覧と、各ページの値が、どの hook の setter を通って renderer（または別の場所）に届くか、
そしてどれが localStorage に**保存される**かをまとめます。設定の値の多くは**保存されません**（再起動すると端末ごとの既定値に戻る）。

## 入口

`src/ui/toolbar/buttons/SettingsButton.tsx` の「設定」ボタン → `AppShell` の `setSettingsOpen(true)` → `src/ui/settings/SettingsModal.tsx` の `SettingsModal`。

## 流れ

1. `SettingsModal` — 一覧は「アイコン＋名前のボタン」だけ。ボタンを押すと一覧を閉じて、その項目専用のダイアログ（`settings/pages/*.tsx`）を開く。
   一覧と専用ダイアログは同時に開かない。どちらを開いているかは `settings-nav.ts` の `settingsNavReducer` が持ち、出す項目は `visibleSettingsPages` が決める
   （一時フォルダはデスクトップだけ、保存領域は Web だけ）。設定を開くたびに一覧から始める（`useLayoutEffect` で `reset`）。
2. 各ページ（`settings/pages/*.tsx`）— 共通の枠 `SettingsPageDialog.tsx`（タイトルと「戻る」）に、`viewer.setXxx(...)` を呼ぶ入力を載せるだけ。
3. `viewer.setXxx` の実体は `src/state/useDisplaySettings.ts` の setter（`useCopcViewer` が `display.setXxx` を `CopcViewerState` に入れて渡している）。
   どれも「React の state を更新する」と「`rendererRef.current?.setXxx(...)` で renderer に伝える」を対で行う。
4. renderer は次のフレームから新しい値を使う（[毎フレームの描画](./render-frame.md)）。

### 設定の一覧

| 項目 | ページ | 呼ぶ関数 | 届く先 | 保存 |
|---|---|---|---|---|
| テーマ | `ThemeDialog` | `theme.setPreference`（`useTheme.ts`） | `<html data-theme>` | localStorage `pcv-theme-preference` |
| アニメーション | `AnimationDialog` | `viewer.setAnimationEnabled`（`useDisplaySettings`） | `renderer.setAnimationEnabled` と `<html data-motion>`（`applyMotionAttribute`） | localStorage `pcv-animation-enabled`（`motion-setting.ts`） |
| 背景・グリッド | `BackgroundDialog` | `setBackgroundMode`／`setGridEnabled` | `renderer.setBackgroundMode`／`setGridEnabled`（`sky.ts`・`ground-grid.ts`） | なし |
| 点予算（自動調整） | `PointBudgetDialog` | `setPointBudget`／`setAutoPointBudgetEnabled` | `renderer.setPointBudget`（呼ぶと自動調整が止まる）／`setAutoPointBudgetEnabled` | なし |
| 読み込み優先（中央優先度） | `LoadPriorityDialog` | `setCenterPriorityStrength`／`setMinCenterPriorityWeight` | `renderer.setCenterPriorityStrength`／`setMinCenterPriorityWeight` | なし |
| 陰影（EDL） | `EdlDialog` | `setEdlEnabled` | `renderer.setEdlEnabled`（強さ `0.05` は固定） | なし |
| 単位 | `UnitDialog` | `useDisplayUnit()` の `setDisplayUnit`（`useDisplayUnit.ts`） | 計測ラベル・レイヤー情報（購読している側が再描画） | localStorage `pcv-display-unit` |
| 解像度 | `RenderScaleDialog` | `setRenderScale` | `renderer.setRenderScale` → `applyCanvasSize`（描画バッファを作り直す） | なし |
| 更新の確認 | `UpdateDialog` | `update.setEnabled`（`useUpdateCheck.ts`） | 起動時の更新チェック（開発中は走らない） | localStorage `pcv-update-check-enabled` |
| 一時ファイル（デスクトップのみ） | `TempDirDialog` | `viewer.pickAndSetTempDir`／`clearTempDir`（`useTempDir.ts`。フォルダ選択は `pickTempDirectory`、`src/datasource/tauri.ts`） | `openFiles`（`ctx.tempDir`）／`src/app/point-cloud-tools.ts`（`ctx.tempDir`）が Rust に `tempDir` として渡す | localStorage `pcv-conversion-temp-dir` |
| 保存領域（Web のみ） | `StorageDialog` | `viewer.refreshOpfsStorageInfo`／`removeOpfsCachedConversion` など（`useOpfsStorage.ts`） | OPFS の変換キャッシュ・作業フォルダ | OPFS 自体 |

点の形・大きさ・着色は設定画面ではなく**レイヤーごと**（[レイヤー操作](./layers.md)）。全体の点の形を変える設定は無い（形を省いて足したレイヤーの初期値は、端末プロファイルの既定値）。

### 端末ごとの既定値

`useDisplaySettings` の初期値と renderer のコンストラクタの初期値は、どちらも `defaultRenderSettings(readDeviceProfileInput())`（`src/renderer/device-profile.ts`）から来る。
モバイル判定（`navigator.deviceMemory` とタッチ主体か）で、点予算の初期値と上限・レンダースケール・点の形・EDL・ガラス表現を一箇所で決める。
同じ純粋関数を同じ入力で呼ぶので、握手なしで一致する。だから、**保存しない設定は再起動で端末の既定値に戻る**。

### 単位

- 表示単位（`DisplayUnit` = `"meter" | "foot"`）は `src/state/units.ts` の型。保存と購読は `src/state/useDisplayUnit.ts`
  （モジュール単位の小さなストアを `useSyncExternalStore` で読む。props を木の奥まで渡さずに済ませるため）。
  読み書きは `try/catch` で囲み、localStorage が使えなくても動く（その場の選択は有効、再読込で既定の m に戻る）。
- 換算は `lengthUnitsFor(crs, display)` → `formatLength` などの純粋関数（[計測](./measure.md)の「単位の換算」）。
- 一時フォルダの保存先・OPFS の使用量など、**単位ではない保存**は `useTempDir`／`useOpfsStorage`。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| 点予算・背景・グリッド・EDL・アニメーション・レンダースケール・点の形・中央優先度・`stats` | `useDisplaySettings` |
| テーマ | `useTheme`（`AppShell` が呼ぶ。`SettingsModal` へ props） |
| 更新確認 | `useUpdateCheck`（同上） |
| 表示単位 | `useDisplayUnit`（hook ではなくモジュールのストア） |
| 一時フォルダ | `useTempDir` |
| OPFS の保存領域 | `useOpfsStorage` |
| 設定の一覧／専用ページのどちらを開いているか | `SettingsModal` 内の `useReducer`（`settings-nav.ts`） |

## 関連と落とし穴

- [ADR-0009](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0009-adaptive-render-settings.md)（手動設定を常に自動より優先）、
  [ADR-0017](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0017-ui-shell-ribbon.md)（設定を「アイコンの一覧＋1項目1ダイアログ」にした）、
  [R2-ui-components.md](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R2-ui-components.md)。
- 新しい設定を足す手順: ① `useDisplaySettings` に state と setter（renderer を呼ぶ）② 型と説明は `useDisplaySettings` の `DisplaySettings` に書く ③ `viewer-types.ts` の `CopcViewerState` の `Pick<DisplaySettings, ...>` に名前を足し、`useCopcViewer` の `state` に追加
  ③ `settings/pages/` に 1 ファイル、`SettingsModal.tsx` の `PAGE_BUTTONS` と `settings-nav.ts` の `SettingsPageId`・`visibleSettingsPages` に追加。保存したいなら localStorage を `try/catch` で。
- 点予算は、手で変えると自動調整が止まる。UI が 500ms 遅れて気づくと「勝手に切り替わった」ように見えるため、`setPointBudget` は UI 側でも自動調整のフラグを先に下ろす。
  自動調整が変えた値は `stats` 経由で UI に写る（`onStats`）。
- レンダースケールに `devicePixelRatio` を掛けない（掛けるとモバイルの既定 0.5 が実質 1.0 になる。`render-scale.ts` 冒頭）。
- localStorage は読み書きとも `try/catch`。プライベートウィンドウやサイトデータのブロックで例外になる。
- 中央優先度の下限を 0 にすると、点予算が厳しいとき画面端のノードが選ばれなくなる（飢餓防止が効かない）。設定画面の説明文に書いてある。
