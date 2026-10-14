# L1: 複数レイヤーとレイヤー操作、リボン・設定の整理

所有者の要望（2026-10-14）:

- レイヤー欄の 📄 をチェックボックスにして、表示・非表示に使う
- レイヤーを複数読み込めるようにする。レイヤーごとに表示方法（着色）を変えられる
- レイヤー欄を右クリックすると「削除」を選べる
- 「読み込みは開くだけで良い」— **コーディネーターの解釈**: 「レイヤーを追加」のような別のボタンは作らず、
  「開く」（ファイル選択・D&D・URL）で開いたものが**常に新しいレイヤーとして足される**（今のように置き換えない）
- リボンは常に1列。入りきらなければ横にスクロールする（スクロールバーではなく、左ボタンを押したまま横に引いて動かす）
- 設定ウィンドウの不要な項目は削除してよい
- ダイアログの「閉じる」ボタンは灰色（tertiary）

## 作業の分け方（並行で走らせる）

| 記号 | 中身 | 主に触るファイル | 依存 |
|---|---|---|---|
| L1-A | リボン1列＋ドラッグで横スクロール、閉じるボタンを tertiary、設定の整理 | `src/ui/shell/Ribbon*.tsx`・`ribbon-styles.ts`・`dialog-styles.ts`・`ViewDialogs.tsx`・`SettingsModal.tsx` ほか閉じるボタンのあるダイアログ | なし |
| L1-B | 裏側（DataSource）で複数ファイルを同時に開けるようにする | `src/datasource/`・`src-tauri/src/copc_state.rs`・`crates/pcv-wasm`・`copc.worker.ts` | なし |
| L1-C | 描画（renderer）を複数レイヤー対応にする | `src/renderer/` | なし |
| L1-D | 状態（`useCopcViewer`）とレイヤーパネルの UI | `src/state/useCopcViewer.ts`・`LayerPanel.tsx`・`LayerInfoSection.tsx`・`ViewDialogs.tsx`（着色） | B と C が main に入ってから |

B と C は `useCopcViewer.ts` の呼び出し側を**最小限だけ**直して、main を「1レイヤーで今までどおり動く」状態に保つ。
本格的な状態の作り直しは D がやる。後から push する側が、先に入った側との食い違い（下の取り決め）を直す。

## B と C の間の取り決め（インターフェース）

### DataSource（L1-B が作る）

```ts
interface OpenedCloud { cloudId: number; info: CloudInfo; nodes: HierarchyNodeInfo[] } // cloudId を足す
interface DataSource {
  open(path: string, readerPoolSize?: number): Promise<OpenedCloud>; // 開いても、既に開いているものは閉じない
  readNode(cloudId: number, key: string): Promise<ArrayBuffer>;
  close(cloudId: number): Promise<void>;                              // そのファイルのリーダーを手放す
}
```

- `cloudId` は今の「世代番号（generation）」をそのまま使う（Tauri の `pcv://<generation>/<key>` の URL の形も変えない）
- 裏側は「開いているファイルが1つ」(`Mutex<Option<OpenedFile>>`) を「`cloudId` → ファイル」の表にする（Tauri・Web の Worker の両方）
- 閉じた（または知らない）`cloudId` への `readNode` は、今の `StaleNodeRequestError` と同じ扱い（`NodeLoader` が黙って捨てる）

### Renderer（L1-C が作る）

```ts
interface LayerInput {
  hierarchy: HierarchyNodeInfo[];
  readNode: (key: string) => Promise<ArrayBuffer>; // renderer は DataSource を知らない。呼び出し側が cloudId を閉じ込めて渡す
  boundsMin: [number, number, number];            // CloudInfo.min / max（標高の範囲と視点合わせに使う）
  boundsMax: [number, number, number];
  colorMode: ColorMode;
  visible: boolean;
}
renderer.addLayer(layerId: string, input: LayerInput): void   // 足したら、全レイヤーが入るように視点を合わせる
renderer.removeLayer(layerId: string): void                    // そのレイヤーのノードを GPU・キャッシュから捨てる。視点は動かさない
renderer.setLayerVisible(layerId: string, visible: boolean): void
renderer.setLayerColorMode(layerId: string, mode: ColorMode): void
renderer.resetView(): void                                     // 見えている全レイヤーが入る視点へ
```

`setDataSource`・`setHierarchy`・`resetForNewFile`・`setColorMode`・`setElevationRange` はこれで置き換える（消す）。

決めたこと（理由）:

- **点予算は全レイヤーで1つを分け合う**。レイヤーごとに分けると、画面に小さくしか映らないレイヤーにも同じだけ点を割いてしまう。
  ノード選択は全レイヤーのノードを同じ優先度（画面上の大きさ）で比べる
- **標高の色の範囲は、見えている全レイヤーの範囲を合わせたもの**。隣り合うタイルを別レイヤーで開いたとき、境目で色がずれないように
- 強度の範囲はレイヤーごと（計測機が違うと値の幅が違うため）
- 着色はレイヤーごと。EDL・点の形・解像度・背景・グリッドは画面全体の設定のまま（EDL は画面全体にかける処理なので、レイヤーごとにできない）
- レイヤーを足したら全レイヤーが入る視点に合わせる（遠くのファイルを足したとき、見えないままにならないように）。削除では視点を動かさない

## L1-D でやること（B・C の後）

- `useCopcViewer` にレイヤーの一覧 `layers: { id, name, info, nodeCount, visible, colorMode, cloudId, ... }[]` と `selectedLayerId` を持たせる
- 開く（ファイル・複数ファイルの結合・URL・D&D・Web の変換の結果）＝レイヤーを1つ足す。足したレイヤーを選択にする
- レイヤー欄: 📄 の代わりにチェックボックス（表示・非表示）。行をクリックで選択。右クリックでメニュー「削除」
  （削除 = `renderer.removeLayer` と `source.close`。選択中を消したら残りの先頭を選ぶ）
- 着色ダイアログは**選択中のレイヤー**の着色を変える。レイヤー情報の欄も選択中のレイヤーを出す
- 変換の内訳・ダウンロードリンクは、それを作ったレイヤーに付く。E2E の `data-testid`（CLAUDE.md の表）は残す

## 所有者の確認手順（全部入ったあと）

1. ファイルを2つ（例: 渋谷のタイル2枚の COPC）続けて開く → レイヤー欄に2行、両方表示される
2. 片方のチェックを外す → そのレイヤーだけ消える。戻すと出る
3. 片方を選んで「着色」を標高にする → そのレイヤーだけ色が変わる
4. 行を右クリック →「削除」→ 行も点も消える。もう一方は残る
5. ウィンドウを狭くする → リボンは1列のまま、左ボタンで押したまま横に引くと動く。ボタンのクリックは今までどおり効く

## L1-C の記録（描画を複数レイヤー対応にした）

### 何をしたか

`PointCloudRenderer` の公開 API を、取り決めどおり `addLayer / removeLayer / setLayerVisible / setLayerColorMode / resetView` にした。
`setDataSource / setHierarchy / resetForNewFile / setColorMode / setElevationRange` は消した。renderer は DataSource を知らず、レイヤーごとに渡される `readNode(key)` だけを使う。
追加で `getLayerColorMode(id)` を足した。`RenderStats.colorMode`（画面全体の着色）はレイヤーごとになって意味が無くなったので消し、`layerCount` / `visibleLayerCount` に替えた（使い道はログ出力だけだった）。

### 設計と理由（他の案）

- **キーの名前空間**: キャッシュ・ローダーのキーを `"<通し番号>:<ノードキー>"` にした（`layer-key.ts`）。レイヤーの `id` ではなく内部の通し番号なのは、同じ id を消して付け直したとき、前のレイヤー宛ての読み込み結果が後から届いても別物として捨てられるため。
  キャッシュ（`NodeCache`）とローダー（`NodeLoader`）は全レイヤーで1つずつ。レイヤーごとに分ける案は、キャッシュの上限（点数）と同時リクエスト数を全体で守りにくいので採らなかった。`NodeCache.removeByPrefix` でレイヤー単位に捨てる。
- **ノード選択**（`node-selection.ts` の `selectNodesForLayers`）: 見えているレイヤーそれぞれの根から子へたどり、全部の候補を1つのリストに入れて優先度順に並べ、点予算を1つ共有して詰める。
  「根から子へたどる」はレイヤーごとにそのまま使うので、計算量は選ばれる（視錐台に入り LOD A で切られない）ノード数程度のまま。全ノード走査には戻っていない。
  従来の `selectNodesForFrame` は `selectNodesForLayers` を1レイヤー・前置き空で呼ぶ薄い関数にした。既存テスト（旧実装との等価性600ケースを含む）は無修正で通る。
  同順位のときは「レイヤーの並び → hierarchy の添字」。
- **非表示**: 見えているレイヤーだけを選択に渡す。選ばれないのでロードも要求されず、描画もされない。読み込み済みのキャッシュは残す（再表示がすぐ効く。上限を超えれば LRU で捨てられる）。
- **removeLayer**: キャッシュからそのレイヤーのノードを捨て（GPU バッファ解放）、着色バッファも destroy。読み込み中の結果は、通し番号がもう無いので `handleNodeLoaded` が捨てる。レイヤーが消えた後に始まる読み出しは `StaleNodeRequestError` で黙って捨てる。消えたレイヤー宛ての読み出し失敗は、エラーバナーにも出さない（前のファイル宛ての失敗を報告しないのと同じ）。
- **着色はレイヤーごとに uniform バッファを持つ**（`gpu-resources.ts` の `createColorSettingsBuffer` / `writeColorSettings`）。各ノードの bindGroup（binding 1）が、そのレイヤーのバッファを参照する。毎フレーム、見えているレイヤーのバッファに書く。
  他の案: ノード自身の uniform（binding 0）に色の設定を入れる → WGSL の構造体を変えることになり、GPU で確かめられない今は危険なので採らなかった。**シェーダーは変えていない。** 描画をレイヤーごとに分ける案は、1つの共有バッファを1フレームの途中で書き換えられない（`writeBuffer` は submit 前にまとめて効く）ので成り立たない。
  デバイス復帰時は、キャッシュと同様にレイヤーの着色バッファも作り直す（`ensureColorBuffer`）。
- **標高の範囲**は見えている全レイヤーの `elevationRangeFromCloudBounds` の合併（`mergeValueRanges`）、**強度の範囲**はレイヤーごと（ノードが届くたびに広げる）。
- **視点**: `addLayer` で見えている全レイヤーのノード bounds の和集合（`mergeSceneBounds`）に合わせる（即時、動き中のアニメーションは止める）。`removeLayer` / `setLayerVisible` は視点を動かさず、グリッドの高さ・大きさだけ残りのレイヤーに合わせ直す。`resetView` は見えているレイヤーの和集合へ。ダブルクリックで寄る先の切り取りも、見えているレイヤーの実データ範囲の和集合。
- **呼び出し側（`useCopcViewer.ts`）は最小限**: 開く → 新しい `cloudId` に差し替え → `removeLayer("current")` → `addLayer("current", { readNode: (key) => source.readNode(opened.cloudId, key), ... })` → 前の `cloudId` を `close`。UI は変えていない。着色の変更は `setLayerColorMode("current", ...)`。

### 触ったファイル

`src/renderer/point-cloud-renderer.ts`・`node-selection.ts`・`node-cache.ts`・`gpu-resources.ts`・`scene-bounds.ts`・新規 `layer-key.ts`・新規 `node-selection-layers.test.ts`、`src/state/useCopcViewer.ts`（開く処理・着色・統計ログの数行）。

### 確認したこと（コマンドの出力）

- `npx tsc --noEmit`: エラーなし。`npm run lint`: エラーなし。
- `npx vitest run`: 46 ファイル 415 テスト合格（追加: `node-selection-layers.test.ts`。1レイヤーが従来関数と同じ結果、予算の共有、手前のレイヤー優先、非表示（渡さない）レイヤーが出ない、キーの前置き、`removeByPrefix` がバッファを destroy し他レイヤーは残る）。
- **ノード選択の時間**（ADR-0010 と同じ作りの合成 octree: レベル d に 4^d ノード、各10万点、範囲 4400m、1600x900、点予算 26,843,545、中央優先 4/0.2。1回あたり、vitest 内で20回平均、一時のテストで測り、コミットしていない。視点は真上から高さ h）:

| 構成 | ノード数 | h=3000 | h=8000 |
|---|---|---|---|
| 1レイヤー | 21,845 | 1.015 ms（wanted 261） | 0.032 ms（wanted 21） |
| 2レイヤー（横に並べた同じ形） | 合計 43,690 | 0.805 ms（wanted 268） | 0.074 ms（wanted 42） |

  2レイヤーでも全ノード走査の水準（ADR-0010 の変更前 28.9 ms）には戻っていない。ADR-0010 の 0.06 ms とは視点が違う（その視点は記録に残っていない）ので、h=3000（見えるノードが多い）との直接比較はできない。

### 確認していないこと（未確認）

- **画面（GPU）での動作は一切確認していない。** レイヤーごとの着色バッファが実際に効くか、レイヤー削除で GPU バッファが解放されるか、デバイス消失からの復帰、2レイヤー同時描画は、テストでは確かめられない。
- 複数レイヤーを足す UI は L1-D で入る。今の main は「開くと置き換わる」だけ（レイヤー 1 個）。

### 所有者の確認手順

1. 今までどおり: ファイルを開く → 点が出る（真っ黒・全ノード読み込み失敗になっていないこと）。別のファイルを開く → 置き換わって点が出る。
2. 着色ダイアログで RGB / 標高 / 強度 / 分類を切り替えて、色が変わる。ダブルクリックで寄れる。「全体を表示」で戻る。
3. L1-D が入った後: 2 ファイルを続けて開く → 両方見える。片方のチェックを外す → そのレイヤーだけ消える。片方だけ「標高」にする → そのレイヤーだけ色が変わる。削除 → 点が消え、もう一方が残る。何度か開閉して GPU メモリが増え続けないこと。

## L1-B の記録（裏側で複数の COPC を同時に開く）

### 何をしたか

- `DataSource`: `OpenedCloud.cloudId` を足し、`readNode(cloudId, key)`・`close(cloudId)` にした。`open` は他のファイルを閉じない。
  - 取り決めに無い `NodeReader`（`readNode(key)` だけの型）を `DataSource.ts` に足した。理由は下の「他の案」。
- Tauri（`src-tauri/src/copc_state.rs`）: `Mutex<Option<OpenedFile>>` を `Mutex<HashMap<u64, Arc<CopcPool>>>`（キーは generation = cloudId）にした。
  `pcv://<generation>/<key>` の形は変えていない。`close_copc(generation)` コマンドを足し `lib.rs` に登録。
  表に無い generation（閉じた・知らない）への読み出しは今までの `Stale`（HTTP 409）。閉じるのは冪等（二重に閉じてもエラーにしない）。
  触った関数の `lock().expect(...)` は `Result` に直した（ADR-0015）。
- Web（`copc.worker.ts`）: `let openFile` を `Map<世代番号, WasmCopcFile>` にした。`close` リクエスト（`web-protocol.ts` に追加）で
  表から外して `free()` する（wasm 側のリーダーを手放す）。表に無い世代の `readNode` は `readNode-stale`。
  メモリは開いているファイル数にだけ比例し、閉じれば戻る。wasm（Rust）側の変更は無し（`free()` は wasm-bindgen が元から出している）。
- `StaleNodeRequestError` の説明を「閉じた／知らない cloudId」に直した。
- `useCopcViewer.ts`（最小限）: `currentCloudIdRef` を持ち、renderer には `{ readNode: key => source.readNode(cloudId, key) }` を渡す。
  開く流れは「新しいファイルを開く → cloudId を差し替えて `resetForNewFile` → 前の cloudId を `close`」（置き換え動作のまま）。
  先に閉じず後で閉じるのは、開けなかったときに前のファイルを見せ続けるため。`useNodeConcurrencyBench.ts` も合わせた。

### 他の案と採らなかった理由

- renderer を一切触らない案: `NodeLoader` が型として `DataSource`（`readNode(key)`）を取っているので、`DataSource` を変えると型が通らない。
  アダプタを `as unknown as DataSource` で渡すのは型を嘘にするので避け、renderer 側は型の差し替えだけ
  （`node-loader.ts`・`point-cloud-renderer.ts` の `DataSource` → `NodeReader`、`node-loader.test.ts` の偽物）にした。
  動作は変えていない。L1-C が `addLayer({ readNode })` に作り直すとき、この3行は自然に消える（衝突したら L1-C 側を採ってよい）。
- Tauri で generation を別のカウンタにする案: 取り決めで「世代番号をそのまま cloudId」と決まっているので採らない。
- Worker をファイルごとに起こす案: メモリ・起動コストが増える。表で足りる。

### 触ったファイル

`src/datasource/{DataSource,tauri,web,web-protocol,copc.worker,stale-node-error}.ts`、`src/datasource/web.test.ts`、
`src-tauri/src/{copc_state,lib}.rs`、`src/state/{useCopcViewer,useNodeConcurrencyBench}.ts`、
`src/renderer/{node-loader,point-cloud-renderer}.ts`（型のみ）、`src/renderer/node-loader.test.ts`（偽物の型のみ）。

### 確認手順

1. `cd src-tauri && cargo test --lib` — 新テスト `two_files_open_at_once_and_close_independently`（2つ開いて両方読める／片方を閉じるとそれだけ Stale／二重 close は無害）
2. `npx tsc --noEmit`・`npm run lint`・`npx vitest run`（`WebSource.close` と cloudId の送り返しのテスト）
3. 画面: ファイルを開く → 別のファイルを開く、が今までどおり動くこと（置き換え動作）。Tauri の標準出力に `[pcv] closed generation N` が出る。

## L1-D の記録（状態とレイヤー欄を複数レイヤーにした）

### 何をしたか

- **状態**（`src/state/useCopcViewer.ts`）: `layers: ViewerLayer[]`・`selectedLayerId`・`selectedLayer` と、`selectLayer`・`setLayerVisible`・`setLayerColorMode`・`removeLayer` を持たせた。
  開く経路（ファイル・複数ファイル結合・URL・D&D・サンプル・Web/デスクトップの変換完了後の open）は全部 `openFile` に集まっているので、そこで**常にレイヤーを末尾へ足し、選択にする**（置き換えない）。
  着色の初期値は RGB があれば rgb、無ければ標高（`initialColorModeFor`）。着色の変更は、レイヤーごとに `resolveColorMode`（RGB が無ければ標高）を通してから renderer と一覧に反映する。
  `removeLayer` は renderer.removeLayer → 一覧から削除（選択中を消したら残りの先頭、無ければ null）→ `source.close(cloudId)`。最後の1つを消したら status を idle に戻す。
- **純粋関数**（`src/state/layers.ts`、テスト `layers.test.ts`）: 追加・削除後の選択・選択・表示切替・着色の解決。React にも renderer にも依存しない。
- **変換の内訳・ダウンロード**: 以前は「全体で1つ」の state だった。今は変換完了ハンドラが `pendingConversionRef`（保留中の結果）に置き、続けて呼ぶ `openFile(…, true)` が成功したときだけ**そのとき足すレイヤー**に付ける。
  利用者が自分で別のファイルを開いたとき（第2引数 false）は付けない。レイヤーを消すときはダウンロード URL を revoke する。
  不具合修正（2026-10-08）の `shouldClearConversionResultOnOpen` は、「開くと全体の内訳を消す」動作自体が無くなったので、関数とそのテストごと削除した。
  変換後のレイヤーの名前は変換結果の名前（以前は Web で内部キー `file:N` が名前に出ていた）。
- **削除したもの**: `cloudInfo`・`nodeCount`・`openedFileName`・`colorMode`・`setColorMode`・`downloadReady`・`clearDownload`・`conversionBreakdownText`、および設定画面から使われなくなっていた `isMobile`・`deviceMemoryGiB`・`pointerCoarse`・`pointBudgetMax`（grep で他に使い手が無いことを確認）。
  使う側は選択中のレイヤーから引く: `LayerInfoSection`（名前・点数・CRS・範囲・内訳・ダウンロード）、`LayerStatsDetails`（nodes）、`StatusBar`（CRS）、`AppShell`（変換ダイアログの表示条件）。
  点予算・背景・グリッドの値と setter は名前を変えず残した（L1-E が設定ダイアログへ移す）。
- **レイヤー欄**（`LayerList.tsx` を新規、`LayerPanel.tsx` から使う）: 📄 をやめ、先頭にチェックボックス（表示・非表示）。行クリックで選択（選択中は左の緑線）。右クリックで「削除」だけのメニュー。外側クリック・Esc・スクロール・リサイズで閉じる。
  タッチ・ペンは 500ms の長押しで同じメニュー（8px 以上動いたらスクロールとみなして取り消す。**実機のタッチでは未確認**）。読み込み中は「読み込み中…」の行を末尾に出す。
- **着色ダイアログ**: 選択中のレイヤーの着色を変える。「対象のレイヤー: 名前」を出し、レイヤーが無いときは「着色を変えるレイヤーがありません」と出して全部選べなくする。RGB 無しのレイヤーでは RGB を選べない。

### 他の案と採らなかった理由

- 内訳・ダウンロードを state のままにして「選択中なら出す」: どのレイヤーの内訳か分からなくなる。レイヤーに付ける形にした。
- メニューをパネル内に描く: パネルは transform で滑るため `position: fixed` がパネル基準になってしまう。`document.body` へ portal で出した。
- 一覧の状態を `useReducer` にする: 非同期の open から最新の一覧を読むのに ref が要り、結局 ref + 純粋関数の今の形のほうが短く読める。

### 触ったファイル

`src/state/{useCopcViewer.ts,layers.ts,layers.test.ts}`（`useCopcViewer.test.ts` は削除）、`src/ui/shell/{LayerList.tsx,LayerList.test.tsx,LayerPanel.tsx,LayerInfoSection.tsx,LayerStatsDetails.tsx,StatusBar.tsx,AppShell.tsx,ViewDialogs.tsx,ViewDialogs.test.tsx}`。

### 確認したこと

- `npx tsc --noEmit`・`npm run lint` エラーなし。`npx vitest run`: 48 ファイル 434 テスト合格。
- E2E: `PCV_E2E_PORT=47311 npx playwright test` → 2 passed（web-conversion・web-multi-conversion。`conversion-breakdown`・`download-link`・`viewer-error` の流れは変わっていない）。
- 実 GPU の画面確認（ヘッドありの Edge、Playwright、`navigator.gpu.requestAdapter().info` = vendor nvidia / architecture lovelace、SwiftShader ではない）。データ `data/autzen-classified.copc.laz`（10,653,336 点）を `setInputFiles` で開いた:
  (a) 1回開く: 点が出る（色付きの地形）、エラー表示なし、レイヤー1行。
  (b) 同じファイルをもう1回: 2行。ステータスバーの表示点数が約 1.32M → 約 2.65M（2レイヤー分描いている）。
  (c) 2行目のチェックを外す／戻す: 操作は効いた。ただし2つは同じファイルで完全に重なるため、画面の見た目の差は分からない（表示点数は 2.65M → 1.32M → 戻すと増える、はスクリーンショットのステータスバーで確認）。
  (d) 1行目を非表示にして2行目を選び着色を標高にする: 2行目だけ青〜緑〜黄〜赤の標高の色になった。1行目だけ表示にして2行目を隠すと RGB（写真の色）のままだった。
  (e) 2行目を右クリック: 「削除」メニューが出て、押すと1行になり、点は残った。
  スクリーンショットは scratchpad の `l1d-*.png`。

### 確認していないこと（未確認）

- タッチ端末の長押しメニュー、Android、デスクトップ（Tauri）版の複数同時オープン。
- 別々のファイル（位置のずれたもの）を2つ開いたときの見え方・視点合わせ。
- 削除を繰り返したときの GPU メモリの推移。

### 所有者の確認手順

1. ファイルを2つ続けて開く → レイヤー欄に2行、両方表示される。
2. 片方のチェックを外す → そのレイヤーだけ消える。戻すと出る。
3. 片方を行クリックで選び、リボンの「着色」で標高 → そのレイヤーだけ色が変わる。ダイアログに対象のレイヤー名が出る。
4. 行を右クリック →「削除」→ 行も点も消え、もう一方は残る。Esc や外側クリックでメニューが閉じる。
5. Web 版で LAS を開く → 変換の内訳・ダウンロードは、その変換で作ったレイヤーを選んでいるときだけ出る。

## 訂正（2026-10-14、コーディネーター）: 「読み込みは開くだけで良い」の意味

上の「コーディネーターの解釈」は外れていた。所有者の意図は**リボンの読み込みのボタンを「開く」だけにする**こと。
「URLから開く」「サンプル」のボタンと `src/ui/shell/UrlDialog.tsx` を削除した（`RibbonFileGroup.tsx`・`Ribbon.tsx`・`AppShell.tsx`）。
`viewer.openFile(url)` 自体は残っている（URL を渡す経路が UI から無くなっただけ）。
確認: `npx tsc --noEmit`・`npx vitest run`（50 ファイル 442 テスト通過）。所有者の確認手順: Web 版のリボンの「ファイル」に「開く」だけがあること。
