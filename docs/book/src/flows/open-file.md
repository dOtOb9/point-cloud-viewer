# ファイルを開く

## 何をするか

利用者が選んだ（またはドロップした）ファイルを、レイヤーとして画面に出します。
COPC（`.copc.laz`）はそのまま開き、生の LAS/LAZ/E57/PLY/PCD は先に COPC へ**変換**してから同じ道に乗せます。
開いたものは**いつも新しいレイヤーとして足します**（既存のレイヤーは置き換えない）。

## 入口

| きっかけ | 最初に呼ばれるもの |
|---|---|
| 「開く」（全プラットフォーム共通） | `src/ui/toolbar/buttons/OpenFileButton.tsx` の `ToolbarButton`（`data-testid="open-button"`）を押す → `pickFilesToOpen()`（`src/datasource/file-picker.ts`）→ `openFiles(viewer.fileOpenContext, picked)`。キャンセルは `null` で、何もしない |
| ↳ Web での選択 | `pickFilesToOpen` が、DOM に付けない `<input type="file" multiple>` を作って `click()` する（`accept` は `source-format.ts` の `OPENABLE_EXTENSIONS` から作る）。`click()` は押した瞬間に同期で呼ぶ（`await` の後だとブラウザに止められる）。結果は `File[]` |
| ↳ デスクトップ・Android での選択 | `pickFilesToOpen` が `pickLocalFiles()`（`src/datasource/tauri.ts`）を呼ぶ。ダイアログの絞り込みも `OPENABLE_EXTENSIONS` から作る。結果はパス `string[]` |
| ドラッグ&ドロップ | `src/state/useFileDrop.ts` の `useFileDrop` → `onFilesDroppedToOpen()`（`file-picker.ts`。Web は DOM の `drop`、デスクトップは `onFilesDropped`）→ `AppShell.tsx` が渡した `openFiles(viewer.fileOpenContext, items)` |

開ける形式の一覧は `src/datasource/source-format.ts` の `OPENABLE_EXTENSIONS`（`las` `laz` `e57` `ply` `pcd`）の1か所です。
Web もデスクトップも同じ形式を開けます。

どれも `src/app/open-files.ts` の **`openFiles`** に着く。開くボタンとドロップが、この関数を直接 import して呼ぶので、`openFiles` の上で F12（定義へ移動）を押すと実装に着く。`viewer.fileOpenContext` は、この関数が読み書きするものを束ねた `OpenFilesContext`（`useFileOpen.ts` が描画のたびに作る。[src/app](../frontend/state.md#srcapp-react-の外で動く処理)）。

## 流れ

1. `openFiles(ctx, pathsOrFiles)`。0 件なら何もしない。
   **別の `openFiles` が走っている間は断る**: `ctx.openLock.busy` が立っていたら、「ファイルを開いている途中・変換中は、新しいファイルを開けません」をエラー表示に出して戻る（`status` は触らない。走っている方の表示を壊さないため）。立っていなければ立て、終わったら（成功・失敗・例外のどれでも）`finally` で下ろす。
   `status` を `"opening"` にし、進捗を消す。2 件以上で LAS/LAZ 以外が混じっていたら、名前を挙げて拒否する（変換前）。
   表示名を `ctx.setConvertingFileName` で預けてから、**`await source.prepareToOpen(items, { tempDir, isMobile, onConverting, onProgress })`**（`DataSource`）を呼ぶ。
   Web とデスクトップの違いはこの中にあり、`open-files.ts` には `instanceof` が無い。
   **変換が要るときも、この `await` の中で終わる**（完了イベントが `openFile` を呼び直すことはない）。変換の進み具合はコールバックで届く:
   - `onConverting` — 変換が本当に始まったとき1回だけ（COPC そのもの・変換済みキャッシュでは呼ばれない）。`status = "converting"` にする。
   - `onProgress` — 進捗。`ctx.setConversionProgress` で `useFileOpen` の state（`conversionProgress`）に渡す（点群ツールの実行中、`isToolRunning()` が真の間は無視する）。

   戻り値 `PrepareOutcome` は3種類:
   - `ready { path, conversion }` — 開ける COPC のパス／キー。`conversion` は変換したときだけ入る（COPC そのもの・キャッシュでは `null`）。2. に進む。
   - `failed { summary, details }` — `summary` をパネルの状態へ、`details` をエラーログへ（変換の失敗もここ。`details` は「変換に失敗しました: …」）。そのあと `refreshOpfsStorageInfo()`（デスクトップでは何もしない）。
   - `cancelled` — `status = "idle"` にして `reportError("変換をキャンセルしました", "conversion")`。

   各ビルドの中身:
   - **Web の `WebSource.prepareToOpen`**（`src/datasource/web.ts`）: `File` 1 件は `isCopcFile`（`copc-header.ts`。拡張子ではなくヘッダーで判定）で COPC なら `registerFile` で `"file:<連番>"` にして `ready`。
     COPC でなければ `detectSourceFormatByName`（`source-format.ts`）で形式を決め、
     PCD・PLY・E57 は `startPointFileConversion`（1本の経路。形式は Worker が Rust のクラスを選ぶのに使う）、
     それ以外（LAS/LAZ）は `startConversion`。複数 `File` は `startMultiConversion`。
     変換が始まったら `beginConversion` が要求 id ごとの待ち（`convertPending`）を**投函の前に**登録し、`handleResponse` が
     `convert-progress` を `onProgress` へ、`convert-done` / `convert-failed` を待ちの解決に回す。
     完了したら `opfs.getConvertedFile` で読み戻し → `registerFile` → ダウンロード用の URL を作り、`ready` にする。読み戻せなければ `failed`。
   - **デスクトップ・Android の `TauriSource.prepareToOpen`**（`src/datasource/tauri.ts`）: まず `watchConversionEnd` で `conversion-progress` / `conversion-done` / `conversion-failed` を
     **購読してから**コマンドを呼ぶ（速い完了イベントを取りこぼさない）。パス 1 件は `startLasConversion(path, tempDir)`。
     COPC なら Rust がヘッダーだけ読んで `alreadyCopc`（= `ready`）を返す。生の LAS/LAZ/PCD は `cached`（`ready`）／`insufficientSpace`（`failed`）／
     `converting` のどれか。複数パスは `startMultiLasConversion`。`converting` なら完了／失敗イベントを待ち、完了イベントの `output_path` をそのまま `ready.path` にする。購読は `finally` で解除。
   - 各 `start*` の結果（`ConversionOutcome`）を `PrepareOutcome` にするのは `toPrepareOutcome`、変換の失敗・キャンセルは `toConversionFailureOutcome`（どちらも `src/datasource/prepare-outcome.ts`）。文言もここ
     （`describeInsufficientSpaceDesktop`）と `opfs.ts`（`describeInsufficientSpaceWeb`）にある。
   - 変換の中身（段階・進捗・キャンセル・内訳）は [変換の中身](./conversion.md)。
2. `ready` で `conversion` があれば、`openFiles` が `formatConversionBreakdown`（`src/datasource/conversion-breakdown.ts`）で内訳テキストを作り、
   `conversion.warnings` を1件ずつ `reportError(..., "conversion")` に流す（CRS が無いファイルを通した、など）。
3. `addOpenedLayer(ctx, path, name, conversion)` — 実際にレイヤーを足す。`conversion` は `{ breakdownText, download } | null`（点群ツールの結果は `null`）。
   1. `source.open(path)`（`DataSource.open`）で `OpenedCloud`（`cloudId`・`info`・`nodes`）を得る。
   2. `deps.nextLayerId()`（`useLayers.ts`）で `layer-N` を採番し、`initialColorModeFor(info)`（`src/state/layers.ts`）で最初の着色（RGB があれば `rgb`、無ければ標高）を決める。
   3. `renderer.addLayer(layerId, { hierarchy: opened.nodes, readNode: (key) => source.readNode(opened.cloudId, key), boundsMin/boundsMax, colorMode, visible, pointShape, pointSizePx })`。
      **renderer は DataSource も cloudId も知らない**。`readNode` が `cloudId` を閉じ込めて渡す。
   4. `ctx.addLayerToList(layer)`（`useCopcViewer.ts` が `commitLayers(addLayerToState(layersStateRef.current, layer))` として渡す）— UI 側の一覧に足し、そのレイヤーを選択中にする（内訳テキストとダウンロードもここでレイヤーに付く）。
   5. CRS の読み取りに失敗していたら `reportError(..., "crs")`（ファイルは開く）。

   開くのに失敗したら、Web の変換で作ったダウンロード用 URL を `URL.revokeObjectURL` で手放してから例外を投げ直す。
4. `renderer.addLayer`（`src/renderer/point-cloud-renderer.ts`）の中で、レイヤー固有の状態（`keyPrefix`・`sceneBounds`・`elevationRange`・`style`・`colorBuffer`）を作り、
   `moveCameraToLayer(layer, immediate)` でカメラを移す。**最初のレイヤーは即座に置き**、二つ目以降は視点移動のアニメーションで飛ぶ。
5. `openFiles` の最後で `setStatus("ready")` と `reportToBackendConsole`。例外は `catch` で `failOpen(String(e))`（`setStatus("error")` とエラーログ）。
6. 次のフレームの `renderOnce` から、新しいレイヤーのノードが選ばれて読み込まれ始める（[毎フレームの描画](./render-frame.md)）。

### 複数ファイル

`openFiles` が 2 件以上を受けたとき: LAS/LAZ 以外が混じっていたら名前を挙げて拒否する。
そうでなければ `rememberConvertingSource(multiDisplayNameFor(...))` で表示名を覚え、`prepareToOpen` が Web は `startMultiConversion`、
デスクトップは `startMultiLasConversion` を呼ぶ。結果の扱いは 1 件のときと同じ（`ready` ならそのまま開く。変換したなら `await` の中で終わってから）。
変換済みキャッシュに当たった場合、レイヤー名は表示名（「〜 ほかNファイル」）になる。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| 開く操作そのもの（`openFiles`・`addOpenedLayer`・`cancelConversion`） | `src/app/open-files.ts` の関数（クラスではない。持ち物は無く、`OpenFilesContext` を引数で受ける） |
| 変換の進捗・変換元の名前 | `useFileOpen` の `useState`（`openFiles` は `ctx.setConversionProgress`・`ctx.setConvertingFileName` で書く）。内訳のコピーは `useCopcViewer.ts` の数行 |
| 「開く処理が走っている」旗（`openLock`） | `useFileOpen` が1回だけ作る `{ busy: boolean }`。`status` ではなく普通のオブジェクトなのは、2つのドロップが、新しい `status` で再描画される前に続けて届きうるため |
| レイヤー一覧・選択（`layersStateRef`・`commitLayers`・`nextLayerId`） | `useLayers`（`openFiles` は `addLayerToList`・`nextLayerId` の形で受け取る） |
| 一時フォルダ（`tempDir`） | `useTempDir`（localStorage に保存） |
| `status`・`error` | `useCopcViewer` |
| ドラッグ中かどうか | `useFileDrop`（戻り値。`AppShell` が案内を重ねる） |

## 関連と落とし穴

- [R1-state-refactor.md](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R1-state-refactor.md)、
  [ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md)（レイヤーから新しいレイヤーを作る）、
  [ADR-0016](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0016-e2e-web-conversion.md)（この流れを実ブラウザで確かめる E2E）、
  [R11](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R11-open-awaits-conversion.md)（変換の完了まで `await` する形にした記録）、
  [R12](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R12-file-opener-outside-react.md)（開く処理を React の外へ出した記録）、
  [R13](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R13-open-files-as-functions.md)（クラスをやめて関数にした・開いている途中の2つ目を断る記録）。
- Web とデスクトップの分岐は `DataSource.prepareToOpen`（R9）に移し、R11 で変換の完了待ちもその中に入れた。`openFiles` は「呼んで、結果で分けるだけ」。R12 で、この処理を React のフックから `src/app/` に出し、R13 でクラスをやめて普通の関数にした（隠れた状態を持たず、UI が直接呼ぶため F12 で実装に着く）。
  まだ `instanceof` が残っているのは `usePointCloudTools.ts`（別の作業）。
- 変換の結果（内訳・ダウンロード）は `PrepareOutcome.ready.conversion` で**値として**返り、`addOpenedLayer` の引数でそのレイヤーに付く。
  以前は完了ハンドラが ref に預けて `openFile(出力, true)` を呼び直していたため、順序を間違えると内訳が消える不具合があった（2026-10-08）。今は預ける場所そのものが無い。
- デスクトップのイベント（`conversion-progress` など）には変換の識別子が付かない。同時に2つの変換を走らせると、最初の完了イベントで両方の待ちが解決してしまう。
  Rust は2つ目を拒まず、キャンセルのフラグを上書きする（`ConversionState`）ので、`openFiles` の中で断る（R13。開くボタンもドロップも同じ関数を通る）。ただしツールの実行（`usePointCloudTools`）は `openLock` を取らない（これまでどおり）。
- E2E が使う `data-testid`（`open-button`・`conversion-breakdown`・`download-link`・`viewer-error`）は、UI を作り直しても付け直すこと。
- ファイル選択は OS のダイアログとドロップだけ（パスを人に打たせない。所有者の要件）。
