# 点の選択・断面・複数レイヤーの結合

この章は「処理の流れ(入口つき)」の1つです。点群ツールは、[ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md) の原則
「**選んだレイヤーから、新しいレイヤーを作る**。元のレイヤーは書き換えない」に沿って作られています。
結果は新しい COPC ファイルで、そのパスを `DataSource.open()` に渡して新しいレイヤーとして開きます。

## 1. 何をするか

| ツール | 入力 | 条件 | 出力 |
|---|---|---|---|
| 点の選択 | 選んだ1レイヤー | 画面に描いた多角形(`ScreenPolygon`)の内側で、カメラの前にある点(奥行きは問わない) | その点だけの COPC |
| 断面 | 選んだ1レイヤー | 3D 上で拾った2点を結ぶ線に厚みをつけた、鉛直の板(`OrientedBox`) | その点だけの COPC |
| 複数レイヤーの結合 | Ctrl か Shift で選んだ2レイヤー以上 | なし | 全点を1つにまとめた COPC |

## 2. 入口

| 操作 | 最初に呼ばれるもの |
|---|---|
| 点の選択(多角形を閉じる) | `src/state/useLayerTool.ts` の `finishPolygon` → `viewer.extractFromLayer(..., "選択")` |
| 断面(厚みと高さを確定) | 同 `confirmSection` → `viewer.extractFromLayer(..., "断面", box.normal)` |
| 結合(ツールバーの「複数レイヤー」) | `src/ui/toolbar/buttons/MergeLayersButton.tsx` の `onClick` → `viewer.mergeSelectedLayers()` |

`viewer.extractFromLayer` / `viewer.mergeSelectedLayers` の実体は `src/state/usePointCloudTools.ts`(`useCopcViewer.ts` が組み立てて公開している)です。

## 3. 流れ

### 3-A. 共通(UI → state → datasource)

1. UI — `src/ui/toolbar/buttons/`（`MeasureButton.tsx`・`SelectPointsButton.tsx`・`SectionButton.tsx`・`MergeLayersButton.tsx`。ボタン）、`src/ui/tools/LayerToolOverlay.tsx`(多角形・断面線の表示)、`src/ui/tools/SectionDialog.tsx`(断面の厚み・高さ)、`src/ui/tools/ToolProgressDialog.tsx`(進捗とキャンセル)。
2. `src/state/useLayerTool.ts` — 3D ビュー上のマウス操作を受ける。
   - 点の選択: `addPolygonVertex` が頂点(画面のピクセル座標)を貯め、最初の頂点のときのカメラの `viewProj` を覚える。カメラが動いたら多角形を捨てて描き直させる(頂点が点群の同じ場所に載らなくなるため)。`finishPolygon` が `pixelToNdc`(`src/state/tool-math.ts`)で NDC に直し、`{ kind: "screenPolygon", viewProj, polygonNdc }` を作る。
   - 断面: `addSectionPoint` が `viewer.pickPoint`(GPU の深度から3D の点を拾う)で2点を貯める。`confirmSection` が `sectionBox`(`tool-math.ts`)で `{ kind: "orientedBox", center, axes, halfExtents }` を作る。2点が同じ鉛直線上なら向きが決まらないので止める。
3. `src/state/usePointCloudTools.ts` `extractFromLayer` / `mergeSelectedLayers` — 対象のレイヤーの `sourcePath`(`open()` に渡したパス)を取り、`runTool` に渡す。結合は `toolSourceLayers`(`src/state/layer-selection.ts`)で測定レイヤーを除き、2つ未満なら案内を出して終わり。
4. 同 `runTool` — 同時に1つだけ(`toolRunningRef`)。進捗を `setToolProgress` に流し、`source` が `WebSource` なら `source.extractToCopc` / `source.mergeCopcs`、そうでなければ `src/datasource/tauri.ts` の `extractToCopc` / `mergeCopcs` を呼ぶ。
5. 成功したら: 警告(`result.warnings`)をエラーログに出し、`addOpenedLayer(result.outputPath, ...)`(`src/app/open-files.ts` の `addOpenedLayer`。ツールは `openLock` を取らない)で新しいレイヤーとして開き、`focusLayer` でそこへ寄る。断面は `sectionYaw` で板を正面から見る向きにする。
   失敗・キャンセル(メッセージに「キャンセル」を含む)は `reportToolMessage` でそのまま出す(ADR-0011 のエラー表示、種別 `"tool"`)。

### 3-B. デスクトップ

1. `src/datasource/tauri.ts` `extractToCopc` / `mergeCopcs` — `invoke("extract_copc", { path, filter, tempDir })` / `invoke("merge_copcs", { paths, tempDir })`。進捗は変換と同じ `conversion-progress` イベントを `withToolProgress` が `onProgress` に流す。
2. `src-tauri/src/conversion.rs` `extract_copc` / `merge_copcs`(非同期の Tauri コマンド) — `content://` は未対応エラー。出力先は `tool_output_path`(一時フォルダ配下の `pcv-tools/<名前>-<時刻>-<連番>.copc.laz`)。一時ファイルの置き場所は `resolve_spill_dir` + `redirect_os_temp_dir`。
3. 同 `run_tool` — 同時に1つだけ(`ConversionState` にキャンセルフラグを持つ。変換中なら「別の変換またはツールの処理が進行中です」)。`spawn_blocking` で別スレッドに出し、`catch_unwind` で panic を文字列のエラーにする(ADR-0015)。キャンセルは変換と同じ `cancel_las_conversion`。
4. 点の選択・断面: `crates/pcv-convert/src/extract.rs` `extract_path_and_timings`
   1. `ExtractFilter::validate`(頂点が3つ以上・数値が有限、など)。
   2. ヘッダーだけ `las::Reader` で読み、`StreamingLayout` と出力メタデータ(`write_metadata::copc_write_metadata_from_source_header`)を作る(`merge.rs` と同じ関数)。
   3. `pcv_core::extract::ExtractPoints::new` — 元の COPC の hierarchy から、条件と交わりうるノードだけを選ぶ(`ExtractFilter::may_intersect`。**保守的**で、迷ったら読む。最終判定は点ごとの `contains`)。
   4. 最初の1点を、書き出しを始める前に取る。0点なら出力を作らず `ExtractError::EmptySelection`(「選んだ範囲に点がありません」)。
   5. 以降は `write_streaming_with_cancel_and_timings`(copc-writer)にイテレータごと渡す。この先は[変換の中身](./conversion.md)の 3-A step 5 以降と同じ(spill → LOD の分割 → 圧縮 → 書き出し)。
5. 結合: `crates/pcv-convert/src/merge.rs` `merge_paths_and_timings`(複数ファイルの変換と同じ関数。COPC も `las::Reader` が LAZ として読める)。`summarize_headers_lenient` の CRS の扱いは[変換の中身](./conversion.md)の 3-C を見てください。
6. `ToolOutput { output_path, point_count, warnings }` を返す。結合の `point_count` は申告点数の合計(`declared_points_total`)。

### 3-C. Web

1. `src/datasource/web.ts` `WebSource.extractToCopc` / `mergeCopcs` — 入力は `registerFile` 済みのキー(`"file:N"`)だけ(`fileForToolInput`)。OPFS が使えるか、空き容量(`checkInsufficientSpace` / `checkInsufficientSpaceMulti`)を確かめ、`buildExtractStartRequest` / `buildToolMergeStartRequest` を Worker に送る。
2. 点の選択・断面: `src/datasource/copc.worker.ts` `handleExtractStart` → `runExtract`
   1. `opfs.withConversionLock`(変換と同じロック。他のタブで変換中なら失敗)。
   2. 一時ファイルのプールと出力ハンドルを作り、`new WasmExtractor(file, filter, handles, outputHandle, outputName, maxPointsPerNode)`(`crates/pcv-wasm/src/extract.rs`)。
   3. `extractor.feed(CONVERT_BATCH_SIZE)` をバッチごとに呼ぶ(中で `ExtractPoints` から点を取り `SpillWriter::push`)。バッチの間に `yieldToEventLoop` してキャンセルを受け取り、`tool-progress` を返す。
   4. `extractor.finish()` — 0点なら「選んだ範囲に点がありません」で失敗。そうでなければ `write_copc_from_spill_with_fs_and_timings` を `OpfsScratchFs` で呼ぶ。**この間はキャンセルできない。**
   5. `opfs.writeToolOutputMeta` の後 `tool-done`。成功・失敗とも `finally` で一時ファイルを消す(失敗時は出力も消す)。
3. 結合: `toolMergeStart` → `handleConvertMultiStart` → `runMultiConversion`(複数ファイルの変換と同じコード)。結果だけは `toolRequestIds` に入っている id について、`convert-*` を `tool-*` に書き換えて送る(`translateForTool`)。アプリ全体の変換のリスナー(「変換結果を開く」)が反応しないようにするため。
4. `WebSource.runTool` — `tool-done` を待ち、`opfs.getConvertedFile` で OPFS の出力を `File` として取り出し、`registerFile` で新しいキー(`"file:N"`)にして `outputPath` として返す。以降は 3-A の step 5。

### 読み側の中身(`ExtractPoints`)

`crates/pcv-core/src/extract.rs`。`pcv-core` に置いてあるのは、デスクトップ(`pcv-convert`)と Web(`pcv-wasm`)の両方が使えるように(wasm32 でビルドでき、Tauri に依存しない)です。書き出しはここでは行いません。

- `ExtractPoints::new` — 対象ノードを `pending`(キー順)に積む。点はまだ読まない。
- `Iterator::next` → `load_next_node` — ノードを1つ `CopcReader::read_node` で読み、`contains` を通った点だけ `current` に入れる。読んだ点は次のノードを読む前に捨てる。
- `set_node_callback` — ノードを読むたびに進捗とキャンセルの確認を行う。一致する点が少ないとき、書き出し側は長く何も受け取らず、書き出し側のキャンセル確認だけでは遅いため。

## 4. データの形・メモリとディスクの上限

- 条件の形(`ExtractFilter`): 画面の多角形は `{ kind: "screenPolygon", viewProj(16要素・列優先), polygonNdc }`、板は `{ kind: "orientedBox", center, axes(単位ベクトル3本), halfExtents }`。座標はファイルの実座標(f64)。TS の型は `src/datasource/tools.ts`、Rust の型は `crates/pcv-core/src/extract.rs`(camelCase の JSON から読む)。
- 読み側が同時に抱える点は**1ノード分**(`max_points_per_node` が上限、既定100,000)。ノード数・点の総数には比例しません。テスト: `crates/pcv-convert/src/extract.rs` の `buffer_is_bounded_by_largest_node`。
- 実測(`TaskSheets/L2-layer-tools.md` の L2-C。**別の重い変換が同時に動いている状態**の数字で、速度として読まないこと):
  - `autzen-classified.copc.laz`(10,653,336点)から 1,156,505 点を抽出: 278ノード中47を読み、1.58秒、メモリ(private)のピーク 30.4 MiB。
  - 渋谷の結合(347,797,138点)から 154,661,111 点を抽出: 6462ノード中2943を読み、421.4秒、メモリ(private)のピーク 274.3 MiB(全点を持てば約6GB の見積もり)。ワーキングセットは 9,577 MiB まで上がったが、これは spill の mmap のページキャッシュと見られる(未検証)。
- 書き出し側の上限は[変換の中身](./conversion.md)の表と同じ(copc-writer を共有)。
- 結果の COPC: デスクトップは一時フォルダ(設定で選んだ場所)の `pcv-tools/` 配下、Web は OPFS。

## 5. 関連する ADR・タスクシートと落とし穴

- ADR: [ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md)(レイヤーから新しいレイヤーを作る)、[ADR-0015](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0015-error-handling-incremental.md)(エラー処理)、[ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md)。
- タスクシート: `TaskSheets/L2-layer-tools.md` の L2-C(抽出エンジン・結合・CRS 無し)、L2-F(UI)、L2-G(Web で大きな COPC を結合できなかった原因)。
- 確かめたこと: 実ブラウザ(Edge、NVIDIA の実 GPU)で、autzen から多角形の選択(3,123,595点)、断面(8,897点)、小さなレイヤーの結合(合計と一致)が動いた(L2-F の記録)。
  autzen を2つ結合する Web の失敗は、`vendor/laz` の seek の修正後に 21,306,672点で動いた(L2-G の記録)。
- 確かめていないこと: **デスクトップの Tauri コマンドを、動いているアプリから呼んだ確認はない**(Rust の単体テストだけ)。Android(`content://` は未対応)。Chrome と Firefox。タッチ操作。
- 落とし穴:
  - 多角形はカメラが動くと捨てられます(頂点が点群の同じ場所に載らなくなるため)。仕様です。
  - 点の選択は奥行きを区別しません。斜めから見ると、多角形の後ろの同じ視線上の点も入ります(設計どおり)。
  - Web の結合は入力の大きさに上限があります。autzen と beer の結合は 77,501,432点で「spill size overflow」になりました(wasm32 の 4 GiB を超える既知の上限。L2-G)。
  - Web では結合の結果が `convert-*` として届くと、アプリが「変換結果を開く」と誤解します。`toolRequestIds` と `translateForTool` はそのためにあります。
  - 結合で CRS が無いファイルを通すと警告が出ます。CRS を持つファイル同士の食い違いは止まります(`CrsId` の比較。`Crs` 列挙型は対応外の CRS を「不明」にしてしまうので、比較には使わない)。
