# エラーの流れ

## 何をするか

エラーを**黙って捨てず、本文のまま画面に出す**ための経路です（ADR-0011・0013・0015）。
このプロジェクトでは、テストと CI が全部緑のまま画面が真っ黒になる事故が何度も起きたので、
「起きたことが利用者（と所有者）の目に届く」ことを最優先にしています。

出口は二つあります。

- **`reportError(message, source)`** — 現在のエラー一覧（`gpuErrors`）と、セッション全体の履歴（`errorHistory`）に積む。
  積まれると `ErrorDialog` が自動で開く。ステータスバーの「ログ」ボタンで、閉じたあとも履歴を読み返せる。
- **`setError(message)`**（`viewer.error`） — 画面内の短いエラー文。レイヤー情報の欄（`data-testid="viewer-error"`）に出て、`ErrorDialog` にも一件として並ぶ。

## 入口

`src/state/useErrorLog.ts` の `useErrorLog()` が返す `reportError`。`useCopcViewer` が一度だけ作り、他の hook にはこの関数が渡される。

## 発生源ごとの流れ

### 1. WebGPU のエラー（初期化・実行時・デバイス消失）

1. `src/renderer/gpu-resources.ts` — `device.onuncapturederror`、`initWithErrorScope`（パイプライン生成を一つずつ `pushErrorScope` で囲む）、`device.lost` を監視する。
2. `GpuResources` のコンストラクタ引数のコールバック → `PointCloudRenderer.reportGpuError(message)` — `console.error` に出したうえで `onGpuError` を呼ぶ。
3. `src/state/useRendererLifecycle.ts` — `renderer.onGpuErrorReported((message) => { reportError(message); reportToBackendConsole(...) })`。
4. デバイス消失は `device-recovery.ts` の `decideDeviceRecovery`（直近 60 秒に 3 回まで）で復帰を試み、`PointCloudRenderer.handleDeviceRecovered` でキャッシュを空にして読み直す。

### 2. ノード読み込み失敗（Rust の panic を含む）

1. `src/renderer/node-loader.ts` の `NodeLoader` — `readNode` の失敗を `.catch` で受け、**古い世代の失敗と `StaleNodeRequestError`（`src/datasource/stale-node-error.ts`）は黙って捨てる**。それ以外は `onFailed(key, error)`。
2. `PointCloudRenderer.reportNodeLoadError` — `"<通し番号>:<ノードキー>"` を `<レイヤー id>/<ノードキー>` に直す。**読み込み中に消されたレイヤー宛ての失敗は報告しない**。
   本文は `formatNodeLoadErrorMessage`（`src/renderer/node-load-error.ts`。要約も切り詰めもしない）で組み立てる。
3. `useRendererLifecycle.ts` — `renderer.onNodeLoadErrorReported((message) => reportError(message, "node-read"))`。
4. Rust 側（デスクトップ）: `src-tauri/src/copc_state.rs` の `read_node_bytes` が `read_node` だけを `catch_unwind` で囲み、panic は `ReadNodeError::Panicked`。
   `src-tauri/src/lib.rs` の `handle_pcv_protocol` が HTTP 500 とメッセージ・ノードキーを返す（通常の失敗は 400、世代違いは 409 で、409 はフロントが黙って捨てる）。
   panic フック（`install_panic_hook`）は `log::error!` で記録を残す。
5. Web: ノード読み込みは Worker 内。失敗は Worker のメッセージとして `WebSource.readNode` の reject になり、2. 以降は同じ。

### 3. 変換の失敗・キャンセル・容量不足

1. 容量不足は `useFileOpen.ts` の `openFile`／`openFiles` が、`describeInsufficientSpaceWeb`（`src/datasource/opfs.ts`）または `describeInsufficientSpaceDesktop`（`src/state/open-file-text.ts`）の文を `reportError(..., "conversion")` に流し、`status = "error"`・`error = "空き容量が足りません"`。
2. 変換中の失敗は `useConversionSession.ts` の `reportConversionFailure(message, cancelled)` — 進捗を消し、`status` を `"error"`（キャンセルなら `"idle"`）にし、
   `reportError("変換に失敗しました: ..." または "変換をキャンセルしました", "conversion")`。
   - デスクトップ: Rust の `emit_failed`（`src-tauri/src/conversion.rs`）が `conversion-failed` イベントを送り、`onConversionFailed`（`src/datasource/tauri.ts`）が受ける。
   - Web: Worker が `convert-failed` を送り、`WebSource.onConvertFailed` が受ける。Worker の `describeConversionFailure`（`src/datasource/copc.worker.ts`）は、
     wasm のトラップなら `alloc_guard` が残した確保失敗の理由か「メモリ不足の可能性」を添える。
3. 変換の呼び出し自体の例外は `openFile` の `catch` → `setStatus("error")`・`setError(String(e))`。

### 4. Rust の panic

| 入口 | 受け止める場所 | 画面に出る形 |
|---|---|---|
| `pcv://` のノード読み出し | `copc_state.rs` の `catch_unwind` → HTTP 500 | 2. の経路で `reportError(..., "node-read")` |
| 点群ツール（選択・断面・結合）のコマンド | `src-tauri/src/conversion.rs` の `catch_unwind`（`spawn_blocking` の中）。`"内部エラー(panic): ..."` の `Err` にする | `usePointCloudTools.ts` の `runTool` の `catch` → `reportError(message, "tool")` |
| Web の Worker（wasm） | `init_panic_hook`（`crates/pcv-wasm/src/lib.rs`。`console.error` に出す）。トラップは Worker の `try/catch` が拾い `error`／`convert-failed` のメッセージに | 3. の経路 |
| 変換本体（`std::thread::spawn` のスレッド） | **`conversion.rs` の変換スレッドには `catch_unwind` が見当たらない**（grep で確認。動作は未検証） | panic すると `conversion-failed` が出ず、画面が「変換中」のままになりうる（推定） |

### 5. その他

- CRS の読み取り失敗: `useFileOpen.ts` の `addOpenedLayer` が `reportError(..., "crs")`。ファイルは開く。
- ファイルを閉じる失敗: `useLayers.ts` の `removeLayer` が `reportError(..., "node-read")`。
- 計測の深度読み戻しの失敗: `useCopcViewer.ts` の `pickPoint` が `reportError(...)`。
- 点群ツールの警告（CRS なしを通したなど）と失敗: `usePointCloudTools.ts` の `reportToolMessage` → `source = "tool"`。
- `renderer.init()` の失敗: `useRendererLifecycle.ts` が `setError(String(e))`（`viewer.error` の側）。
- WebGPU 非対応: `UnsupportedDeviceScreen`（[起動](./startup.md)）。

## 表示まで

1. `src/state/useErrorLog.ts` の `reportError` — `GpuErrorLog.report(message, undefined, source)`（`src/renderer/gpu-error-log.ts`。**直前と同じメッセージは件数を増やすだけ**にして、毎フレームの連投を抑える）。
   `gpuErrors` に現在の一覧を、`errorHistory` に `mergeErrorHistory`（`src/state/error-history.ts`）で履歴を入れる。
2. `src/ui/shell/AppShell.tsx` — 前回の `gpuErrors.length`・`error` と比べ、増えたら `setErrorDialogMode("current")`（描画中に前回値と比べる書き方で、effect の中の `setState` を避けている）。
3. `src/ui/dialogs/ErrorDialog.tsx` — `source`（`gpu`／`node-read`／`conversion`／`crs`／`tool`）で見出しを出し分け、本文はそのまま、同じエラーが続いたら「N 回発生」。
   「閉じる」は `dismissGpuError` で現在の一覧から消す（履歴には残る）。
4. `src/ui/status/StatusBar.tsx` の「ログ」ボタン — `onOpenErrorLog` で履歴モードの同じダイアログを開く。履歴があると赤くなる。
5. デスクトップでは `reportToBackendConsole`（`src/datasource/tauri.ts`）でバックエンドのコンソールにも同じ文を送る（GUI なしで追うため）。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| `gpuErrors`・`errorHistory`・`reportError`・`dismissGpuError` | `useErrorLog`（`GpuErrorLog` を ref に持ち、変わるたびに一覧のコピーを state に入れる） |
| `status`・`error`（`viewer.error`） | `useCopcViewer` |
| ダイアログの開閉・モード（`current`／`history`） | `AppShell` |
| 連投の抑制・件数の集計 | `GpuErrorLog`（`src/renderer/gpu-error-log.ts`。WebGPU にも React にも依存しない純粋なクラス） |

## 関連と落とし穴

- [ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md)（GPU エラーの可視化）、
  [ADR-0013](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0013-crash-visibility.md)（クラッシュの可視化）、
  [ADR-0015](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0015-error-handling-incremental.md)（触ったところから `Result` に直す）、
  [ADR-0017](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0017-ui-shell-ribbon.md)（バナーからダイアログへ）。
- **クラス名・ファイル名は `Gpu` のままだが、中身は汎用**（ノード読み込み・変換・ツールのエラーも同じ仕組みに乗せた）。名前を直すなら import が広範囲に及ぶ。
- 新しいエラー源を足すときは、専用の表示を作らず `reportError(message, source)` を呼ぶ。`source` を増やすなら `GpuErrorSource`（`gpu-error-log.ts`）と `ErrorDialog.tsx` の `SOURCE_LABEL` の両方。
- 本文を要約・切り詰めしないこと（ADR-0013。Rust が残した panic メッセージとノードキーが画面まで届く保証）。
- 古い世代・消えたレイヤー宛ての失敗を報告すると、ファイルを開き直すたびに偽のエラーが出る。`Stale` 系は黙って捨てるのが正しい。
- 画面や実機の GPU でしか出ないエラーがある（WebGPU のバリデーション）。緑のテストでは見つからないので、描画を触ったら実ブラウザで見る。
