# ファイルを開く

## 何をするか

利用者が選んだ（またはドロップした）ファイルを、レイヤーとして画面に出します。
COPC（`.copc.laz`）はそのまま開き、生の LAS/LAZ/E57/PLY/PCD は先に COPC へ**変換**してから同じ道に乗せます。
開いたものは**いつも新しいレイヤーとして足します**（既存のレイヤーは置き換えない）。

## 入口

| きっかけ | 最初に呼ばれるもの |
|---|---|
| 「開く」（全プラットフォーム共通） | `src/ui/toolbar/buttons/OpenFileButton.tsx` の `ToolbarButton`（`data-testid="open-button"`）を押す → `pickFilesToOpen()`（`src/datasource/file-picker.ts`）→ `viewer.openFiles(picked)`。キャンセルは `null` で、何もしない |
| ↳ Web での選択 | `pickFilesToOpen` が、DOM に付けない `<input type="file" multiple>` を作って `click()` する（`accept` は `source-format.ts` の `OPENABLE_EXTENSIONS` から作る）。`click()` は押した瞬間に同期で呼ぶ（`await` の後だとブラウザに止められる）。結果は `File[]` |
| ↳ デスクトップ・Android での選択 | `pickFilesToOpen` が `pickLocalFiles()`（`src/datasource/tauri.ts`）を呼ぶ。ダイアログの絞り込みも `OPENABLE_EXTENSIONS` から作る。結果はパス `string[]` |
| ドラッグ&ドロップ | `src/state/useFileDrop.ts` の `useFileDrop` → `onFilesDroppedToOpen()`（`file-picker.ts`。Web は DOM の `drop`、デスクトップは `onFilesDropped`）→ `openFiles` |

開ける形式の一覧は `src/datasource/source-format.ts` の `OPENABLE_EXTENSIONS`（`las` `laz` `e57` `ply` `pcd`）の1か所です。
Web もデスクトップも同じ形式を開けます。

どれも `src/state/useFileOpen.ts` の `openFiles` に着く。

## 流れ

1. `useFileOpen.ts` の `openFiles(pathsOrFiles)` — 0 件なら何もしない。**1 件なら `openFileRef.current(...)`（= `openFile`）へ回す**。
   2 件以上は「複数 LAS/LAZ を一つの COPC へ結合する」道（下の「複数ファイル」）。
2. `useFileOpen.ts` の `openFile(pathOrFile, isConversionContinuation = false)` — `status` を `"opening"` にし、`error` を消す。
   - **Web で `File` が来たとき**: `src/datasource/copc-header.ts` の `isCopcFile(file)` でヘッダーを見て COPC か判定する（拡張子では判定しない）。
     COPC なら `WebSource.registerFile(file)`（`src/datasource/web.ts`）で `"file:<連番>"` のキーにする。
     COPC でなければ `detectSourceFormatByName`（`src/datasource/source-format.ts`）で形式を決め、
     PCD・PLY・E57 は `WebSource.startPointFileConversion(file, format, ...)`（1本の経路。形式は Worker が Rust のクラスを選ぶのに使う）、
     それ以外（LAS/LAZ）は `WebSource.startConversion`。結果が `"converting"` なら `status = "converting"` にして**ここで return**（続きは 4.）。
     `"cached"` なら変換済みの出力をそのまま開く。容量不足（`"insufficientSpaceWeb"`）はエラーログへ。
   - **デスクトップ・Android のとき**: `startLasConversion(path, tempDir)`（`src/datasource/tauri.ts`）を**必ず先に**呼ぶ。
     COPC なら Rust がヘッダーだけ読んで `alreadyCopc` を返す。生の LAS/LAZ/PCD は `cached`（変換済み）／`insufficientSpace`／
     `converting`（変換開始。ここで return）のどれか。
   - 変換の中身（段階・進捗・キャンセル・内訳）は [変換の中身](./conversion.md)。
3. `useFileOpen.ts` の `addOpenedLayer(path, fallbackName, isConversionContinuation)` — 実際にレイヤーを足す。
   1. `source.open(path)`（`DataSource.open`）で `OpenedCloud`（`cloudId`・`info`・`nodes`）を得る。
   2. `nextLayerId()`（`useLayers.ts`）で `layer-N` を採番し、`initialColorModeFor(info)`（`src/state/layers.ts`）で最初の着色（RGB があれば `rgb`、無ければ標高）を決める。
   3. 変換の続きなら `takePendingConversion()` で内訳テキストとダウンロードを受け取り、このレイヤーに付ける。
   4. `renderer.addLayer(layerId, { hierarchy: opened.nodes, readNode: (key) => source.readNode(opened.cloudId, key), boundsMin/boundsMax, colorMode, visible, pointShape, pointSizePx })`。
      **renderer は DataSource も cloudId も知らない**。`readNode` が `cloudId` を閉じ込めて渡す。
   5. `commitLayers(addLayerToState(...))` — UI 側の一覧に足し、そのレイヤーを選択中にする。
   6. CRS の読み取りに失敗していたら `reportError(..., "crs")`（ファイルは開く）。
4. （変換した場合）変換が終わると、`src/state/useConversionSession.ts` の effect に登録済みの完了ハンドラ
   （Web: `WebSource.onConvertDone`、デスクトップ: `onConversionDone`）が、結果を `setPendingConversion` に預けてから
   `openFileRef.current(出力, true)` を呼ぶ。2. に戻り、今度は COPC として 3. に進む。
   `openFileRef` は `useFileOpen` が毎レンダー後に最新の `openFile` へ向け直している。
5. `renderer.addLayer`（`src/renderer/point-cloud-renderer.ts`）の中で、レイヤー固有の状態（`keyPrefix`・`sceneBounds`・`elevationRange`・`style`・`colorBuffer`）を作り、
   `moveCameraToLayer(layer, immediate)` でカメラを移す。**最初のレイヤーは即座に置き**、二つ目以降は視点移動のアニメーションで飛ぶ。
6. `openFile` の最後で `setStatus("ready")` と `reportToBackendConsole`。失敗は `catch` で `setStatus("error")` と `setError(String(e))`。
7. 次のフレームの `renderOnce` から、新しいレイヤーのノードが選ばれて読み込まれ始める（[毎フレームの描画](./render-frame.md)）。

### 複数ファイル

`openFiles` が 2 件以上を受けたとき: LAS/LAZ 以外が混じっていたら名前を挙げて拒否する。
そうでなければ `rememberConvertingSource(multiDisplayNameFor(...))` で表示名を覚え、Web は `WebSource.startMultiConversion`、
デスクトップは `startMultiLasConversion` を呼ぶ。結果の扱いは `openFile` と同じ（`cached` ならそのまま開く／`converting` なら完了ハンドラが続ける）。

## 状態の持ち場所

| もの | 持ち主 |
|---|---|
| 開く操作そのもの（`openFile`・`openFiles`・`addOpenedLayer`） | `useFileOpen` |
| 変換の進捗・変換元の名前・完了待ちの結果（`PendingConversionResult`）・`openFileRef` | `useConversionSession` |
| レイヤー一覧・選択（`layersStateRef`・`commitLayers`・`nextLayerId`） | `useLayers`（`useFileOpen` は引数で受け取る） |
| 一時フォルダ（`tempDir`） | `useTempDir`（localStorage に保存） |
| `status`・`error` | `useCopcViewer` |
| ドラッグ中かどうか | `useFileDrop`（戻り値。`AppShell` が案内を重ねる） |

## 関連と落とし穴

- [R1-state-refactor.md](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/R1-state-refactor.md)、
  [ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md)（レイヤーから新しいレイヤーを作る）、
  [ADR-0016](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0016-e2e-web-conversion.md)（この流れを実ブラウザで確かめる E2E）。
- **`openFile` は Web 枝とデスクトップ枝が一つの関数に入っている。** 早期 return とエラー処理を共有しているので、
  分けるときは制御の流れが変わる点に注意（R1 では分けなかった）。
- 変換の完了ハンドラは**一度だけ登録**され、`openFileRef` 経由で最新の `openFile` を呼ぶ。`openFile` の引数や
  依存（`tempDir` など）を変えるときは、`useFileOpen.ts` 末尾の `openFileRef.current = openFile` の effect も見ること。
- 変換結果の内訳・ダウンロードは「その変換で作ったレイヤー」に付く。完了ハンドラが先に `openFile` を呼ぶと内訳が消えた不具合が
  あった（2026-10-08。`PendingConversionResult` のコメント）。第二引数 `true` が「変換の続き」の目印。
- E2E が使う `data-testid`（`open-button`・`conversion-breakdown`・`download-link`・`viewer-error`）は、UI を作り直しても付け直すこと。
- ファイル選択は OS のダイアログとドロップだけ（パスを人に打たせない。所有者の要件）。
