# カット・断面・合成・ラスタ化

この章は「処理の流れ(入口つき)」の1つです。点群ツールは、[ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md) の原則
「**選んだレイヤーから、新しいレイヤーを作る**。元のレイヤーは書き換えない」に沿って作られています。
結果は新しい COPC ファイルで、そのパスを `DataSource.open()` に渡して新しいレイヤーとして開きます。

## 1. 何をするか

| ツール | 入力 | 条件 | 出力 |
|---|---|---|---|
| カット | 選んだ1レイヤー | 画面に描いた多角形(`ScreenPolygon`)の内側で、カメラの前にある点(奥行きは問わない) | その点だけの COPC |
| 断面 | 選んだ1レイヤー | 3D 上で拾った2点を結ぶ線に厚みをつけた、鉛直の板(`OrientedBox`) | その点だけの COPC |
| 合成 | Ctrl か Shift で選んだ2レイヤー以上 | なし | 全点を1つにまとめた COPC |
| ラスタ化 | 選んだ1レイヤー | セルの大きさ・セルの値(Z の最小/最大/平均、点数、強度の平均、色の平均)・数える分類(すべて/地表のみ) | **GeoTIFF**(成果物)と、1セル1点の COPC(確認用の新しいレイヤー)。詳しくは「6. ラスタ化」 |

## 2. 入口

| 操作 | 最初に呼ばれるもの |
|---|---|
| カット(多角形を閉じる) | `src/state/useLayerTool.ts` の `finishPolygon` → `extractFromLayer(viewer.toolContext, ..., "カット")` |
| 断面(厚みと高さを確定) | 同 `confirmSection` → `extractFromLayer(viewer.toolContext, ..., "断面", box.normal, section)`。成功すると右下に[断面図のパネル](#3-d-断面図2d-のパネルg2-3)が開く |
| 合成(ツールバーの「合成」) | `src/ui/toolbar/buttons/MergeLayersButton.tsx` の `onClick` → `mergeSelectedLayers(viewer.toolContext)` |

`extractFromLayer` / `mergeSelectedLayers` / `cancelTool` の実体は `src/app/point-cloud-tools.ts` の普通の関数です(R13 の `openFiles` と同じ形。F12 で飛べる)。
読む物・変える物は全部、第1引数のコンテキスト(`PointCloudToolsContext`)で受け取ります。コンテキストは `src/state/usePointCloudTools.ts`(進捗の `useState` を持つ橋渡しのフック)が作り、`useCopcViewer.ts` が `viewer.toolContext` として公開しています。

## 3. 流れ

### 3-A. 共通(UI → state → datasource)

1. UI — `src/ui/toolbar/buttons/`（`MeasureButton.tsx`・`SelectPointsButton.tsx`・`SectionButton.tsx`・`MergeLayersButton.tsx`。ボタン）、`src/ui/tools/LayerToolOverlay.tsx`(多角形・断面線の表示)、`src/ui/tools/SectionDialog.tsx`(断面の厚み・高さ)、`src/ui/tools/ToolProgressDialog.tsx`(進捗とキャンセル)。
2. `src/state/useLayerTool.ts` — 3D ビュー上のマウス操作を受ける。
   - カット: `addPolygonVertex` が頂点(画面のピクセル座標)を貯め、最初の頂点のときのカメラの `viewProj` を覚える。カメラが動いたら多角形を捨てて描き直させる(頂点が点群の同じ場所に載らなくなるため)。`finishPolygon` が `pixelToNdc`(`src/state/tool-math.ts`)で NDC に直し、`{ kind: "screenPolygon", viewProj, polygonNdc }` を作る。
   - 断面: `addSectionPoint` が `viewer.pickPoint`(GPU の深度から3D の点を拾う)で2点を貯める。`confirmSection` が `sectionBox`(`tool-math.ts`)で `{ kind: "orientedBox", center, axes, halfExtents }` を作る。2点が同じ鉛直線上なら向きが決まらないので止める。
3. `src/app/point-cloud-tools.ts` `extractFromLayer` / `mergeSelectedLayers` — 対象のレイヤーの `sourcePath`(`open()` に渡したパス)を取り、`runTool` に渡す。合成は `toolSourceLayers`(`src/state/layer-selection.ts`)で測定レイヤーを除き、2つ未満なら案内を出して終わり。
4. 同 `runTool` — 同時に1つだけ(`ctx.toolLock.running`。`openLock` と同じ、アプリの間ずっと同じ素のオブジェクト)。進捗を `ctx.setToolProgress` に流し、`source` が `WebSource` なら `source.extractToCopc` / `source.mergeCopcs`、そうでなければ `src/datasource/tauri.ts` の `extractToCopc` / `mergeCopcs` を呼ぶ。
5. 成功したら: 警告(`result.warnings`)をエラーログに出し、`ctx.addOpenedLayer(result.outputPath, ...)`(中身は `src/app/open-files.ts` の `addOpenedLayer`。ツールは `openLock` を取らない)で新しいレイヤーとして開き、`hideSourceLayers` で元のレイヤーを非表示にし(レイヤー欄のチェックを外すのと同じ `setLayerVisible`。消さず、書き換えない。失敗・キャンセルのときは表示のまま)、`focusLayer` でそこへ寄る。断面は `sectionYaw` で板を正面から見る向きにする。
   失敗・キャンセル(メッセージに「キャンセル」を含む)は `reportToolMessage` でそのまま出す(ADR-0011 のエラー表示、種別 `"tool"`)。

### 3-B. デスクトップ

1. `src/datasource/tauri.ts` `extractToCopc` / `mergeCopcs` — `invoke("extract_copc", { path, filter, tempDir })` / `invoke("merge_copcs", { paths, tempDir })`。進捗は変換と同じ `conversion-progress` イベントを `withToolProgress` が `onProgress` に流す。
2. `src-tauri/src/conversion.rs` `extract_copc` / `merge_copcs`(非同期の Tauri コマンド) — `content://` は未対応エラー。出力先は `tool_output_path`(一時フォルダ配下の `pcv-tools/<名前>-<時刻>-<連番>.copc.laz`)。一時ファイルの置き場所は `resolve_spill_dir` + `redirect_os_temp_dir`。
3. 同 `run_tool` — 同時に1つだけ(`ConversionState` にキャンセルフラグを持つ。変換中なら「別の変換またはツールの処理が進行中です」)。`spawn_blocking` で別スレッドに出し、`catch_unwind` で panic を文字列のエラーにする(ADR-0015)。キャンセルは変換と同じ `cancel_las_conversion`。
4. カット・断面: `crates/pcv-convert/src/extract.rs` `extract_path_and_timings`
   1. `ExtractFilter::validate`(頂点が3つ以上・数値が有限、など)。
   2. ヘッダーだけ `las::Reader` で読み、`StreamingLayout` と出力メタデータ(`write_metadata::copc_write_metadata_from_source_header`)を作る(`merge.rs` と同じ関数)。
   3. `pcv_core::extract::ExtractPoints::new` — 元の COPC の hierarchy から、条件と交わりうるノードだけを選ぶ(`ExtractFilter::may_intersect`。**保守的**で、迷ったら読む。最終判定は点ごとの `contains`)。
   4. 最初の1点を、書き出しを始める前に取る。0点なら出力を作らず `ExtractError::EmptySelection`(「選んだ範囲に点がありません」)。
   5. 以降は `write_streaming_with_cancel_and_timings`(copc-writer)にイテレータごと渡す。この先は[変換の中身](./conversion.md)の 3-A step 5 以降と同じ(spill → LOD の分割 → 圧縮 → 書き出し)。
5. 合成: `crates/pcv-convert/src/merge.rs` `merge_paths_and_timings`(複数ファイルの変換と同じ関数。COPC も `las::Reader` が LAZ として読める)。`summarize_headers_lenient` の CRS の扱いは[変換の中身](./conversion.md)の 3-C を見てください。
6. `ToolOutput { output_path, point_count, warnings }` を返す。合成の `point_count` は申告点数の合計(`declared_points_total`)。

### 3-C. Web

1. `src/datasource/web.ts` `WebSource.extractToCopc` / `mergeCopcs` — 入力は `registerFile` 済みのキー(`"file:N"`)だけ(`fileForToolInput`)。OPFS が使えるか、空き容量(`checkInsufficientSpace` / `checkInsufficientSpaceMulti`)を確かめ、`buildExtractStartRequest` / `buildToolMergeStartRequest` を Worker に送る。
2. カット・断面: `src/datasource/copc.worker.ts` `handleExtractStart` → `runExtract`
   1. `opfs.withConversionLock`(変換と同じロック。他のタブで変換中なら失敗)。
   2. 一時ファイルのプールと出力ハンドルを作り、`new WasmExtractor(file, filter, handles, outputHandle, outputName, maxPointsPerNode)`(`crates/pcv-wasm/src/extract.rs`)。
   3. `extractor.feed(CONVERT_BATCH_SIZE)` をバッチごとに呼ぶ(中で `ExtractPoints` から点を取り `SpillWriter::push`)。バッチの間に `yieldToEventLoop` してキャンセルを受け取り、`tool-progress` を返す。
   4. `extractor.finish()` — 0点なら「選んだ範囲に点がありません」で失敗。そうでなければ `write_copc_from_spill_with_fs_and_timings` を `OpfsScratchFs` で呼ぶ。**この間はキャンセルできない。**
   5. `opfs.writeToolOutputMeta` の後 `tool-done`。成功・失敗とも `finally` で一時ファイルを消す(失敗時は出力も消す)。
3. 合成: `toolMergeStart` → `handleConvertMultiStart` → `runMultiConversion`(複数ファイルの変換と同じコード)。結果だけは `toolRequestIds` に入っている id について、`convert-*` を `tool-*` に書き換えて送る(`translateForTool`)。アプリ全体の変換のリスナー(「変換結果を開く」)が反応しないようにするため。
4. `WebSource.runTool` — `tool-done` を待ち、`opfs.getConvertedFile` で OPFS の出力を `File` として取り出し、`registerFile` で新しいキー(`"file:N"`)にして `outputPath` として返す。以降は 3-A の step 5。

### 3-D. 断面図(2D のパネル。G2-3)

断面が成功すると、新しいレイヤーに断面の情報(`ViewerLayer.section` = A・B・上方向・厚み。`src/state/layers.ts` の `SectionInfo`)を持たせ、
画面の右下に **2D の断面図**を出します(狭い画面では下に横幅いっぱい)。元のレイヤーは 3-A step 5 のとおり非表示のままで、パネルを閉じても戻しません。

1. `useLayerTool.ts` の `confirmSection` が A・B・`up`・厚みを `extractFromLayer(..., "断面", box.normal, section)` に渡す。`runTool` は `addOpenedLayer(..., section)` でレイヤーに持たせ、最後に `ctx.openSectionView(layerId)` を呼ぶ。
2. `src/app/section-view.ts` `openSectionPanel` — レイヤーの点を `(s, z)` で読む。`s` = A から A→B の水平方向への距離、`z` = 上方向の高さ(どちらもファイルの単位)。
   - デスクトップ: `src/datasource/tauri.ts` `readSectionProfile` → Tauri コマンド `read_section_profile`(`src-tauri/src/copc_state.rs`。開いているファイルの世代番号で読む。`spawn_blocking` + `catch_unwind`)。バイナリをそのまま返す。
   - Web: `WebSource.readSectionProfile` → Worker の `sectionProfile` メッセージ → `WasmCopcFile.readSectionProfile`(`crates/pcv-wasm/src/lib.rs`)。`ArrayBuffer` を転送で返す。
   - Rust の本体は `crates/pcv-core/src/profile.rs` `read_section_profile`。ノードを1つずつ読み、**返す点は最大 200 万点**(既定)。点数が上限以下なら全部、超えるなら `(s, z)` の細かい格子(セルは上限以下)の1セルに最初の1点だけ残す。メモリは上限×12 B(約 24 MB)で、点数に比例しません(テスト: `never_returns_more_than_the_cap_and_still_covers_the_whole_section`)。
   - バッファの形は `src/datasource/section-profile.ts`(24 B のヘッダー + 1点 12 B: f32 s, f32 z, u8 r, g, b, 分類)。RGB があれば RGB、無ければ分類の色(`classificationToColor`)で塗る。
3. 状態は `src/state/useSectionView.ts`(`useState` だけ。開いているレイヤー・点・表示(拡大と位置)・パネルの大きさ)。表示が `null` の間は「全部が入るように自動で合わせる」(`effectiveSectionView`)。
4. 描画は `src/renderer/section-2d.ts`(React を使わない)。点を `ImageData` に直接書き(`fillSectionPixels`)、軸・目盛り・単位(m / ft。計測と同じ換算)を Canvas 2D で重ねる。縦と横の倍率は同じ(縦の強調は無い)。
5. 操作は `src/ui/section/SectionPanel.tsx` が `section-view.ts` の関数に渡すだけ。ホイールとピンチは `zoomAt`、右ボタンのドラッグ・右ボタンの長押し・2本指のドラッグは `panBy`(計算は `src/app/section-math.ts`)。ブラウザの右クリックメニューは出さない。
   右クリック(動かさず短く)・1本指の長押しは GL と傾斜角を出す予定の場所(G2-6)で、今は何もしません。線の編集は G2-5 です。
6. **断面線(地表の線。G2-4)**。断面のレイヤーが開いたあと、`extractFromLayer` が続けて `src/app/point-cloud-tools.ts` の `computeSectionLine` を呼びます。
   - なぜ元のレイヤーから読むか: 断面の板は薄く、CSF の布を落とすには周りの地形が要るから。`SectionInfo.sourceLayerId` の元レイヤー（非表示のまま開いている）から、A→B の左右 20 m(ファイルの単位に換算)の帯だけを読みます。
   - 断面ダイアログに CSF のプリセット(標準 / 急勾配。既定は標準)の選択がある(`SectionDialog.tsx`。`sectionLineRequestFor` が m をファイルの単位に換算)。
   - Rust の本体は `crates/pcv-core/src/section_line.rs` の `SectionLineJob`。帯の座標系 `(s, t, 高さ)`(`t` は線の左右)に布を置き(布の格子が断面に揃う)、1回目の読みで IHV、`Cloth::step` を10回ずつ、2回目の読みで `is_ground`。**各セルについてセルの中心に最も近い地表の点だけ**を残し(メモリは点数でなくセル数。上限 200 万粒子を超える帯は断る)、その点で Delaunay の TIN(クレート `spade`)を作って、`t = 0` に沿って布の解像度ごとに高さを読みます。建物の下は三角形がつなぎます(辺の長さの上限なし)。凸包の外は線が出ません(凸包は直線を1区間でしか切らないので、途中で切れることはなく、端が短くなるだけです)。
   - 小さな手順(`advance`)に分けてあり、デスクトップは Tauri コマンド `compute_section_line`(`conversion.rs`。進捗は千分率、キャンセルは既存のツールのキャンセルと同じ旗)、Web は `WasmSectionLine` を Worker の `sectionLineStart` から `advance` で回し、30 ms ごとにイベントループへ戻ってキャンセルを受けます。進捗は既存の `ToolProgressDialog`(`showAsPercent`)。
   - 結果は `ViewerLayer.section.line`(`original` と `current`。G2-5 の「元に戻す」のため元の線は別に持つ)に入り、`section-2d.ts` の `drawGroundLine` が二次色(オレンジ)の 2 px の線で点の上に描きます。計算に失敗・キャンセルしたら、エラーログに出し、パネルは点だけのままです。

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
  - 渋谷の合成(347,797,138点)から 154,661,111 点を抽出: 6462ノード中2943を読み、421.4秒、メモリ(private)のピーク 274.3 MiB(全点を持てば約6GB の見積もり)。ワーキングセットは 9,577 MiB まで上がったが、これは spill の mmap のページキャッシュと見られる(未検証)。
- 書き出し側の上限は[変換の中身](./conversion.md)の表と同じ(copc-writer を共有)。
- 結果の COPC: デスクトップは一時フォルダ(設定で選んだ場所)の `pcv-tools/` 配下、Web は OPFS。

## 5. 関連する ADR・タスクシートと落とし穴

- ADR: [ADR-0018](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0018-layer-centric-operations.md)(レイヤーから新しいレイヤーを作る)、[ADR-0015](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0015-error-handling-incremental.md)(エラー処理)、[ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md)。
- タスクシート: `TaskSheets/L2-layer-tools.md` の L2-C(抽出エンジン・合成・CRS 無し)、L2-F(UI)、L2-G(Web で大きな COPC を合成できなかった原因)。
- 確かめたこと: 実ブラウザ(Edge、NVIDIA の実 GPU)で、autzen から多角形の選択(3,123,595点)、断面(8,897点)、小さなレイヤーの合成(合計と一致)が動いた(L2-F の記録)。
  autzen を2つ合成する Web の失敗は、`vendor/laz` の seek の修正後に 21,306,672点で動いた(L2-G の記録)。
- 確かめていないこと: **デスクトップの Tauri コマンドを、動いているアプリから呼んだ確認はない**(Rust の単体テストだけ)。Android(`content://` は未対応)。Chrome と Firefox。タッチ操作。
- 落とし穴:
  - 多角形はカメラが動くと捨てられます(頂点が点群の同じ場所に載らなくなるため)。仕様です。
  - カットは奥行きを区別しません。斜めから見ると、多角形の後ろの同じ視線上の点も入ります(設計どおり)。
  - Web の合成は入力の大きさに上限があります。autzen と beer の合成は 77,501,432点で「spill size overflow」になりました(wasm32 の 4 GiB を超える既知の上限。L2-G)。
  - Web では合成の結果が `convert-*` として届くと、アプリが「変換結果を開く」と誤解します。`toolRequestIds` と `translateForTool` はそのためにあります。
  - 合成で CRS が無いファイルを通すと警告が出ます。CRS を持つファイル同士の食い違いは止まります(`CrsId` の比較。`Crs` 列挙型は対応外の CRS を「不明」にしてしまうので、比較には使わない)。
