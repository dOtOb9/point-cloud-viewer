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
