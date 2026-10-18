# ファイルを開く（1枚の図）

手順の詳細は [処理の流れ: ファイルを開く](../flows/open-file.md) にあります。
この章では、「開く」ボタンを押してからレイヤーが一覧に出るまでに関わるものを、1枚の図に並べます。

## 全体の図

```text
(1) where the values are born                      src/state/useCopcViewer.ts
|
|   useRendererLifecycle --> rendererRef, sourceRef          (*1)
|   useState             --> status, setStatus
|   useErrorLog          --> reportError
|   useLayers            --> commitLayers, layersStateRef, nextLayerId
|   useDisplaySettings   --> isMobile, pointShape
|   useTempDir           --> tempDir
|   useOpfsStorage       --> refreshOpfsStorageInfo
|   useRef(false)        --> toolRunningRef  (set by the point-cloud tools)
|
|   all of the above, as inputs
v
(2) bundled                                        src/state/useFileOpen.ts
|
|   useState --> conversionProgress, convertingFileName
|   useState --> openLock { busy }                           (*2)
|   => fileOpenContext  (rebuilt on every render)
|
|   viewer.fileOpenContext
v
    OpenFileButton.tsx --+     (the file chooser is shown here, before openFiles)
    useFileDrop ---------+--> openFiles(ctx, items)        src/app/open-files.ts
    ConversionDialog --------> cancelConversion(ctx)
                               |
(3) what openFiles does        v
|
|   ctx.openLock.busy ?  -- yes -->  ctx.reportError, return
|   ctx.setStatus(opening)
|
|   [step A: make it openable]
|   source.prepareToOpen(items)                DataSource
|      onConverting --> ctx.setStatus(converting)     Web:     WebSource
|      onProgress   --> ctx.setConversionProgress              -> copc.worker
|      returns ready | failed | cancelled                      -> pcv-wasm
|              |       failed / cancelled                Desktop: TauriSource
|              |         --> ctx.setStatus, ctx.reportError    -> src-tauri
|              v
|   [step B: open it as a layer]
|   addOpenedLayer(ctx, path, ...)
|      source.open(path)        --> OpenedCloud
|      renderer.addLayer(...)   --> GPU (PointCloudRenderer)
|      ctx.addLayerToList(...)  --> useLayers state
|   ctx.setStatus(ready)
|
|   the setters change React state; React re-renders
v
(4) who shows the result
|
|   status             --> OpenFileButton (disabled / label)
|                          StatusBar, ConversionDialog
|                          AppShell (opens ConversionDialog on "converting")
|                          LayerInfoSection (viewer-error)
|   conversionProgress --> StatusBar, ConversionDialog
|   convertingFileName --> ConversionDialog
|   layers             --> LayerList, LayerInfoSection
|                          (conversion-breakdown, download-link)
```

図の中の英語は、コードの名前そのものです（等幅で桁をそろえるため、図の中は英語にしています）。

## 図の読み方

### (1) 値はどこで生まれるか

`AppShell.tsx` が `useCopcViewer()` を1回だけ呼びます。その中で、開く処理が使う値を、それぞれの持ち主のフックが作ります。
**開く処理のためだけに値を持っているフックは無く**、ほかの機能（レイヤー・表示の設定・エラー表示）の持ち物を借りています。

### (2) どこで束ねられるか

`useFileOpen` が、(1) の値を `OpenFilesContext`（`fileOpenContext`）という1つのオブジェクトに束ねます。
`useFileOpen` 自身が持っているのは、変換の進捗・変換中のファイル名・`openLock` の3つだけです。
UI は `viewer.fileOpenContext` を受け取り、`openFiles` に渡します。

### (3) openFiles が何をするか

`openFiles` は2段階です。

- **段階 A（`source.prepareToOpen`）: 開ける形にする。** COPC ならそのまま、LAS/LAZ などなら COPC へ変換します。変換が始まると `onConverting` が呼ばれ、それを見て `AppShell` が変換ダイアログを開きます。この `await` は変換が終わるまで返りません
- **段階 B（`addOpenedLayer`）: 実際に開いてレイヤーにする。** COPC を読み（`source.open`）、レンダラに渡し、一覧に足します

Web とデスクトップの違いは段階 A の `prepareToOpen` の中にあり、`openFiles` 自身は分岐しません。
詳しくは [処理の流れ: ファイルを開く](../flows/open-file.md) の「流れ」。

### (4) 結果はどこへ戻るか

setter が React の state を変えると、React が `AppShell` から下を描画し直し、各部品が新しい値を表示します。
`openFiles` は画面の部品を1つも知りません。**値を変えるだけで、表示は React に任せています**。

## 「ダイアログ」は2つある

読み違えやすいので分けておきます。

| ダイアログ | いつ・どこで開くか |
|---|---|
| ファイルを選ぶダイアログ（OS のもの） | `openFiles` より**前**。`OpenFileButton.tsx` の `pickFilesToOpen()`。選び終わってから `openFiles` が呼ばれる |
| 変換ダイアログ（`ConversionDialog`） | 段階 A の途中。`onConverting` → `setStatus(converting)` → 再描画で `AppShell` が開く。`openFiles` は直接開かない |

## コンテキストの中身が4種類ある理由

図の (2) で束ねている `OpenFilesContext` には、形の違うものが混ざっています。どれも React の描画のタイミングが理由です。

| 形 | 例 | なぜこの形か |
|---|---|---|
| 取り出す関数（ゲッター） | `getSource()`・`getRenderer()`・`isToolRunning()` | (*1) renderer と DataSource は `useEffect` の中で作られ、ref に入るのは**最初の描画の後**。コンテキストを作る時点では空かもしれないので、使うときに ref を読む |
| setter | `setStatus`・`setConversionProgress`・`addLayerToList` | React の state を変える口 |
| その時の値 | `tempDir`・`isMobile`・`pointShape` | コンテキストは描画のたびに作り直されるので、押した時点の最新の値が入っている |
| 書き換えるオブジェクト | `openLock: { busy }` | (*2) 2つのドロップが、新しい `status` で描き直される前に続けて届くことがある。state では間に合わないので、アプリが動いている間ずっと同じ1つのオブジェクトを使う |

コードを読んでいて「なぜここだけ関数なのか」と迷ったら、この表に戻ってください。

## コードの入口

| 見たいもの | 場所 |
|---|---|
| 値を集めているところ | `src/state/useCopcViewer.ts` の `useFileOpen({ ... })` の呼び出し |
| 束ねているところ | `src/state/useFileOpen.ts` の `fileOpenContext` |
| コンテキストの型（各項目の説明） | `src/app/open-files.ts` の `OpenFilesContext` |
| 手順 | `src/app/open-files.ts` の `openFiles` → `runOpen` → `addOpenedLayer` |
| 呼ぶ側 | `src/ui/toolbar/buttons/OpenFileButton.tsx`・`src/ui/shell/AppShell.tsx`（`useFileDrop`）・`src/ui/dialogs/ConversionDialog.tsx` |
| Web とデスクトップの違い | `src/datasource/web.ts` の `WebSource.prepareToOpen`・`src/datasource/tauri.ts` の `TauriSource.prepareToOpen` |

`openFiles` の中の `source.prepareToOpen` の上で F12（定義へ移動）を押すと、実装ではなく `src/datasource/DataSource.ts` の
`interface DataSource`（型だけ）に飛びます。`source` の型がインターフェースで、どちらの実装が動くかは起動時に
`src/state/useRendererLifecycle.ts` の1行（`isTauriEnvironment() ? new TauriSource() : new WebSource()`）で決まるためです。
実装を見るには **Ctrl+F12（実装へ移動）** を使うと、`WebSource` と `TauriSource` の2つが候補に出ます。
