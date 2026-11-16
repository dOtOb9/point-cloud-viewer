# 構成レビュー（アプリ全体）2026-11-16

- 書いた人: 監査役エージェント（Auditor）。所有者の依頼「コードベースがかなり汚いと思う。躊躇なくレビューしてほしい」
- 対象: ブランチ `trendpoint-parity` の **HEAD `2ac56ef`**。TP-1（視点）の作業中の差分（`src/renderer/` の 7 ファイル変更と
  `projection.ts`・`view-presets.ts` の追加）は対象外。行数・行番号は原則 `git show HEAD:<path>` で数えた
- このファイル以外は何も変えていない。git の操作もしていない

## 実行したコマンドと結果

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | 通過（エラー 0） |
| `npm run lint` | 通過（警告・エラー 0） |
| `Set-Location C:\workspace\point-cloud-viewer; npx vitest run` | 820 tests passed（`src/` のテストファイルは `git ls-files` で 83） |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通過。警告 5 件は `vendor/laz` の非推奨定数（`std::i32::MIN` など）だけ |
| `cargo test` | **時間の都合で省いた**（未実行） |
| `npx --yes madge@8 --circular --extensions ts,tsx src` | 循環 3 件（A-3） |
| `npx --yes jscpd@4 --min-lines 15 …`（テスト・`tests/`・`src/wasm` を除く） | 完全一致のクローン 37 件・818 行（1.63%）。Rust 572 行（2.12%） |
| `npx --yes knip@5` | 未使用ファイル 19、未使用 export 21、未使用の export 型 35、未使用依存 1（A-13） |
| 自作の集計スクリプト（`git show HEAD:` を読み、コメント行・日本語・タスク ID を数える） | A-7 の数値 |

---

## 要約

1. **土台（Rust の中核、wasm で動く pcv-core、panic を出さない書き方、ADR と記録の文化）は良い。汚いのはその上の「配線」の層。**
2. 一番の問題は **プラットフォームの切り替えが抽象の外に漏れている**こと。`DataSource` は 5 メソッドしか持たず、ツール 11 種は
   `source instanceof WebSource ? source.x() : tauriX()` で `src/app/` に 14 か所書かれている。ツール 1 つ（間引き）を足すのに非テストのファイルを 18 触る
3. **ADR-0021（React は表示だけ）は途中で止まっている。** フックは ecb725f の 2,260 行 → HEAD の 2,035 行（1 か月で −10%）。その間の
   コミットは `feat` 51 に対して `refactor` 6。`useLayerTool`（287 行、ref の使用 46）・`useMeasureTool` は手順をフックに持ったまま
4. **同じ処理の二重実装**: Rust では PLY/PCD/E57 の読み込み・メタデータ書き込みが `pcv-convert` と `pcv-wasm` にコピーされている（意図した重複だが、
   直し方はある）。Rust と TS でも空き容量の係数（11 倍）や変換キャッシュの指紋が二重にある
5. 巨大ファイル: `copc.worker.ts` 1,733 行、`src-tauri/src/conversion.rs` 1,519 行、`point-cloud-renderer.ts` 1,227 行（1,055 行から分割した後に、分割前より大きくなった）、`gpu-resources.ts` 1,226 行
6. 層の規約の CI 検査は grep で、抜け穴がある（`@tauri-apps/plugin-opener` を `tauri.ts` 以外が import しているのに CI は通る）
7. 文書は ROADMAP（687 コミット遅れ）・HANDOFF（231）・ARCHITECTURE（155）が現状とずれている。コメントは非テストのコード 57,976 行のうち 22.9% がコメントで、その 56.6% が日本語、タスク ID が 1,263 個
8. 直す順番: まず安全網（文書・境界の検査・Web のツールの E2E）→ ツールの抽象化 → フックの中身を `src/app/` へ → 重複の解消 → TP の後にレンダラの分割

---

## 指摘の一覧

重さ: **high** = 放っておくと機能追加のたびに負債が増える・規約が守られていないのに守られていると思われている。**medium** = 読みにくさ・壊れやすさが目に見えて大きい。**low** = 片付ければよい。

### A-1 [high] `DataSource` の抽象がツールで破れていて、プラットフォームの分岐が `src/app/` に漏れている

- 場所: `src/app/point-cloud-tools.ts:9-21, 163, 205, 236, 243, 270, 288, 316`、`src/app/raster-window.ts:15, 70, 74, 79, 176, 191`、
  `src/app/section-export.ts:99`、`src/app/section-view.ts:147`、`src/datasource/DataSource.ts:91-127`
- 何が問題か: `DataSource` インターフェースにあるのは `open / prepareToOpen / cancelConversion / readNode / close` の 5 つだけ。
  抽出・結合・間引き・フィルタ・DTM・ラスタ（プレビューの開く・描く・閉じる、GeoTIFF）・断面線・断面図は、Web では `WebSource` のメソッド、
  デスクトップでは `tauri.ts` の**自由関数**として別々の形で生えていて、`src/app/` が両方を import して `instanceof` で振り分けている
- 根拠:
  - `git grep "instanceof WebSource"` → 非テストで **14 か所**、すべて `src/app/` の 4 ファイル
  - `src/datasource/tauri.ts` を import しているファイル: `src/app/` 5 ファイル＋ `src/state/` 3 ファイル
  - 間引きツール 1 つ（`thin_copc|thinCopc|ThinRequest|thin_filter|thinStart|ThinFilter|thinLayer`）に関わる非テストのファイルは **18**:
    `pcv-core`（2）、`pcv-convert`（3、bench 含む）、`pcv-wasm`（2）、`src-tauri`（2）、`src/datasource`（5: `tauri.ts`・`web.ts`・`web-protocol.ts`・`copc.worker.ts`・`thin-filter.ts`）、`src/app`（2）、`src/ui`（2）
  - `DataSource.ts:1-3` の見出しのコメントは「Web版はこれを実装する HttpSource を差し替えるだけで動く想定（M0時点ではまだ存在しない）」のまま
- 放っておくと: ツールを 1 つ足すたびに 7 つの層を手で揃える（TP の土量もこの形で足される見込み）。片方のプラットフォームだけ引数や
  キャンセルの扱いが変わっても型では気付けない。`src/app/` のテストは `vi.mock` でモジュールを差し替えないとデスクトップ側を通れない

### A-2 [high] ADR-0021 の移行が止まり、手順と状態がフックに残っている。状態の持ち方が 3 通りある

- 場所: `src/state/useLayerTool.ts`（287 行）、`src/state/useMeasureTool.ts`（201 行）、`src/state/useLayers.ts`（238 行）、`src/state/useDisplaySettings.ts`（195 行）、`src/ui/shell/AppShell.tsx`（207 行）、`src/state/useDisplayUnit.ts`・`useDtmOutput.ts`
- 何が問題か:
  - 計測・カット・断面の**操作の状態遷移**（クリックの判定、多角形、カメラが動いたら破棄、世代番号、通知のタイマー）がフックの
    `useCallback`・`useRef` の網の中にある。ADR-0021 が消そうとした「最新値の箱（ref）」がそのまま残っている
  - レイヤーの一覧は **3 か所**に持たれている: React の `useState`、`layersStateRef`（コールバックが最新を読むため、`useLayers.ts:4-5` のコメントが明言）、
    レンダラの中のレイヤー表。`src/app/` の関数は `getLayersState()`（ref）を読む
  - 状態の持ち方が 3 通りある: (1) `useState`＋ref の二重持ち、(2) `useDisplayUnit`・`useDtmOutput` のモジュール単位のストア＋`useSyncExternalStore`
    （ADR-0021 の改訂で却下した形に近い）、(3) レンダラ内部のフィールド（`useDisplaySettings` の 9 個の setter は「`setState` してから `renderer.setX`」を繰り返すだけ）
  - `AppShell.tsx` にも手順がある: 計測とレイヤーツールの排他（`toggle` の差し替え、`AppShell.tsx:52-53`）、ダイアログを自動で開く判定（前回値との比較）
- 根拠:
  - フック（`src/state/use*.ts`、非テスト）の行数: ecb725f（ADR-0021 を書いた時点）**2,260 行** → HEAD **2,035 行**
  - 2026-10-19 以降のコミット: `feat` を含む 51、`refactor` を含む 6
  - フックごとの数（HEAD）: `useLayerTool` useCallback 13・useEffect 5・ref 46、`useMeasureTool` 9・4・31、`useLayers` 13・0・25、`useDisplaySettings` 11・2・9
  - `useLayerTool.ts:12-15` のコメント自身が「クリックの扱いは useMeasureTool と同じで、計測ツールを触らないためにもう一度書いた。あとでまとめられる」と書いている
- 放っておくと: 新しいマウス操作（TP の視点・土量の範囲指定など）が同じ形でフックに足され、`useCopcViewer` から始まる配線がさらに伸びる。
  状態遷移のテストが書けない（`useLayerTool`・`useMeasureTool` にテストは無い）

### A-3 [high] 層の規約の検査に抜け穴があり、規約の一部は文書の上だけになっている

- 場所: `.github/workflows/ci.yml:42-70`、`src/datasource/update-check.ts:16`、`src/state/viewer-types.ts:33-51`、`src/ui/` の 18 か所
- 何が問題か:
  - **規約 2**: CLAUDE.md は「`@tauri-apps/` で始まる npm パッケージは `tauri.ts` だけ」と書くが、CI は `grep -rl "@tauri-apps/api"` しか見ない。
    `src/datasource/update-check.ts:16` が `import { openUrl } from "@tauri-apps/plugin-opener"` しているのに CI は緑
    （ファイル内のコメントは「規約2の拡張」と書いているが、CLAUDE.md・ARCHITECTURE.md にはその例外が無い）
  - **規約 3 の後半**（ARCHITECTURE.md「`src/ui/` はレンダラを直接触らず、`src/state/` を経由する」）は検査されておらず、実際には
    `src/ui/` から `src/renderer/`・`src/datasource/` への import が 18 か所ある（`projectPoint`・`drawSection`・`defaultRenderSettings`・`pickFilesToOpen` など）。
    その一方で `viewer-types.ts:33-51` は「規約3のため」型を 5 回、同じ日本語のコメントつきで再 export している。規約が半分だけ守られている
  - **循環**（madge）: `state/viewer-types.ts ⇄ state/useOpfsStorage.ts`、`state/viewer-types.ts ⇄ state/usePointCloudTools.ts`、
    `app/point-cloud-tools.ts → state/viewer-types.ts → state/usePointCloudTools.ts → app/…`。最後のものは型だけの import だが、
    **`src/app/` が `src/state/use*` に（型経由で）依存している**。CI の検査は import 文の文字列を見るだけなので通る
  - `src/app/` は `src/state/` の 19 か所（`layers.ts`・`units.ts`・`tool-math.ts` など）を import し、`src/state/` は `src/app/` を import する。ディレクトリ単位では双方向
  - 検査が文字列検索なので「コメントに書いただけで落ちる」（CLAUDE.md が 2 回落ちたと書いている）。誤検出と見逃しの両方がある
- 放っておくと: 規約があると思って読んだ人が誤解する。Web 版で Tauri のプラグインを読むと実行時に落ちる種類の不具合は、型でも CI でも止まらない

### A-4 [high] 責務が混ざった巨大ファイル

| ファイル（HEAD） | 行数 | 混ざっているもの |
|---|---|---|
| `src/datasource/copc.worker.ts` | 1,733 | wasm の初期化、19 種類のメッセージの振り分け（`handleRequest` の `case`）、開く・ノード読み、単一・複数・点ファイルの変換、並列展開 Worker の管理、抽出・間引き・フィルタ・DTM・ラスタ・断面線。モジュール単位の可変状態 7 つ（`openFiles`・`activeConvertId`・`activeDecompressWorkers` など）。`runConversion`（719 行目から約 185 行）・`runMultiConversion`（920 行目から約 200 行）。**単体テスト無し** |
| `src-tauri/src/conversion.rs` | 1,519 | 名前は「変換」だが、変換コマンドに加えてツールのコマンド 11 個（抽出・結合・ラスタ 4・保存 2・断面線・間引き・フィルタ・DTM）。ARCHITECTURE.md の「src-tauri は薄く保つ。pcv:// の配信と制御コマンドだけ」と合わない |
| `src/renderer/point-cloud-renderer.ts` | 1,227 | メソッド 56・フィールド 28。カメラの移動と注視、ピック、レイヤーの登録と見た目、グリッドの範囲、表示設定の getter/setter（約 20）、GPU エラーの報告、デバイス復旧、リサイズ、フレームループ、統計、アイドル時の加速、点予算の自動調整。**1,055 行で 3 分割した後、本体だけで分割前を超えた** |
| `src/renderer/gpu-resources.ts` | 1,226 | WGSL のソースを文字列で内蔵（104〜363 行、約 260 行）、デバイスの初期化と喪失、パイプライン、ノードのバッファ、`drawFrame`（851 行目から約 305 行の 1 関数）、深度の読み戻し |
| `src/datasource/web.ts` | 901 | Worker との RPC、ファイルの登録、変換 3 種、ツール 9 種、ラスタ |
| `crates/pcv-wasm/src/convert.rs`・`opfs.rs`・`pcv-convert/src/merge.rs`・`pcv-core/src/csf.rs`・`src-tauri/src/copc_state.rs` | 1,117・1,040・1,113・1,204・1,038 | （詳しくは見ていない。行数だけ） |

- 根拠: `wc -l`（HEAD）。メソッド数は `git show HEAD:… | grep` で数えた
- 放っておくと: 所有者が「上から順に読める」状態から遠ざかる。TP-1 も `point-cloud-renderer.ts`・`gpu-resources.ts` に足している（作業中の差分で 1,308・1,235 行）

### A-5 [high] Rust の読み込み処理がネイティブ用と wasm 用にコピーされ、Rust と TS にも同じ判断が二重にある

- 場所: `crates/pcv-wasm/src/ply_import.rs`（739）⇔ `crates/pcv-convert/src/import/ply.rs`（623）、`pcv-wasm/src/pcd_import.rs`（301）⇔ `pcv-convert/src/import/pcd.rs`（268）、
  `pcv-wasm/src/e57_import.rs`（395）⇔ `import/e57.rs`（139）、`pcv-wasm/src/write_metadata.rs` ⇔ `pcv-convert/src/write_metadata.rs`、`pcv-wasm/src/point_merge.rs` ⇔ `pcv-convert/src/merge.rs`・`dtm.rs`。
  TS 側: `src/datasource/opfs.ts:39`（`SCRATCH_SIZE_FACTOR = 11`）⇔ `crates/pcv-convert/src/disk_space.rs:25`（`TEMP_SIZE_FACTOR = 11.0`）、`opfs.ts` の `cacheKeyFor`・`findCachedOutput` ⇔ `pcv-convert/src/cache.rs`
- 根拠:
  - jscpd の完全一致: `ply_import.rs` ⇔ `import/ply.rs` が 48・26・24・23・22・20 行の 6 か所（計 163 行）、`write_metadata.rs` 同士 42 行、`point_merge.rs:407` ⇔ `pcv-convert/src/dtm.rs:354` 19 行、`pcd_import.rs:95` ⇔ `import/scale.rs:32` 20 行
  - 理由は `crates/pcv-wasm/Cargo.toml` のコメントに書かれている: `pcv-convert` をパス依存にするとワークスペースの二重定義になり、
    `copc-writer` の `parallel-*` フィーチャ経由で wasm に `rayon` が入る。**理由は正しいが、行数がすでに分かれている（739 対 623）**
- 放っておくと: PLY の読み方の修正が片方にだけ入り、デスクトップと Web で同じファイルの読み結果が変わる。
  空き容量の係数を変えたとき、片方だけ変わる

### A-6 [medium] 引き継ぎ・計画・地図の文書が現状とずれている

- 場所と根拠（最後に更新したコミットから HEAD までのコミット数）:
  - `TaskSheets/ROADMAP.md`（2026-09-23、**687 コミット前**）: M1 完了・M2 進行中・M3〜M5 未着手、土台の表は「ピッキング: 無い」「空間クエリ層: 無い」。
    実際にはピック・抽出・断面・DTM・ラスタがある
  - `TaskSheets/HANDOFF.md`（2026-10-17、**231 コミット前**）: 「この後は所有者が自分の手で本格的にリファクタリングする。新しい機能は足さない」「動いているエージェントは無い」。
    その後 G1〜G3・TP が進んでいる。HANDOFF はコーディネーターの担当なので、ここでは指摘だけにする
  - `TaskSheets/ARCHITECTURE.md`（2026-10-18、**155 コミット前**、「常に最新の全体像を保つ」と冒頭に書いてある）:
    ディレクトリの図に `src/app/`・`crates/pcv-convert`・`src/ui/toolbar/`・`src/ui/section/` が無く、無い `ribbon/` がある。
    `Dock.ui`・ui-forge・`npm run ui:check`（I-1）は削除済み（`package.json` に無い）なのに「完了」の行が残る。
    「WebGPU の API を直接叩くのは `gpu-resources.ts` だけ」→ 実際は `edl.ts`・`sky.ts`・`ground-grid.ts`・`depth-pick.ts` も `device.create*` を呼ぶ（5 ファイル）。
    「この4つが崩れると」と書いて規約を 5 つ並べている。状態の表は M4-9 の「Web版へは未配線」のまま（R7 で配線済み）
  - コード中のコメント: `Cargo.toml:4-7` が `pcv-convert` を「M4-1 のスパイク。コストを実測するためだけのもの」と説明（今は本番の変換器）。
    `eslint.config.js` のコメントが ui-forge の生成物を説明。`ci.yml` の「この2つが崩れると」（検査は 3 段・規約 4 つ）
- 放っておくと: 新しいセッションやエージェントが古い地図を正として読む。CLAUDE.md は「ARCHITECTURE は構成が変わったら同じコミットで直す」と決めているが、守られていない

### A-7 [medium] コメントの量・言語・タスク ID がコードを読みにくくしている

- 根拠（HEAD、テストと `vendor/`・`src/wasm/` を除く `.ts/.tsx/.rs/.wgsl`）:

| | 行 | コメント行 | 比率 | うち日本語 | タスク ID |
|---|---|---|---|---|---|
| 全体 | 57,976 | 13,282 | 22.9% | 7,514（56.6%） | 1,263 |
| `src/renderer` | 7,919 | 3,128 | **39%** | 2,391（76%） | 261 |
| `src/datasource` | 6,837 | 1,931 | 28% | 1,137（59%） | 218 |
| `src-tauri` | 3,030 | 803 | 27% | 575（72%） | 82 |
| `crates/pcv-wasm` | 6,615 | 1,481 | 22% | 942（64%） | 140 |
| `crates/pcv-convert` | 10,817 | 1,974 | 18% | 1,297（66%） | 157 |
| `src/app` | 2,127 | 448 | 21% | 5（1%） | 64 |

  - コメントの比率が高いファイル（150 行以上）: `point-budget.ts` 67%、`decompress-partition.ts` 64%、`device-profile.ts` 59%、`edl.ts` 55%、`colormap.ts` 54%
  - タスク ID が多いファイル: `point-cloud-renderer.ts` 71、`gpu-resources.ts` 58、`copc.worker.ts` 46、`pcv-wasm/src/convert.rs` 43
  - 例: `viewer-types.ts:33-51` に同じ日本語の 2 行が 5 回。`gpu-resources.ts:10-13` は「個々のコメントは移動元のコミット履歴どおりそのまま持ってきてある」と、履歴をコメントに残すことを明言している。
    `Cargo.toml` の `[profile.release]` は 1 行の設定に 25 行の経緯
- 何が問題か: 「なぜ」より「いつ・どのタスクで・何が起きたか」の物語が多く、コードの今の姿を追う邪魔になっている。タスク ID は TaskSheets を開かないと意味が無い。
  CLAUDE.md の「触ったところから英語に」は 1 か月たって日本語が 56.6% のままで、触らない古いファイル（renderer）はこのままでは減らない
- 放っておくと: 新しく読む人ほど、コメントとコードの食い違い（A-6 の例）を見分けられない

### A-8 [medium] Web の Worker が落ちたときの回復が無い（ADR-0015 の 2 が未実装）

- 場所: `src/datasource/web.ts:241-244`（コンストラクタ）、`copc.worker.ts:183-200`（`ensureWasmReady`）、`copc.worker.ts:474`（`describeConversionFailure`）
- 何が問題か: `WebSource` は `worker.onmessage` だけを設定し、`onerror`・`onmessageerror` を設定していない。Worker のスクリプト自体が落ちると
  `pending`・`convertPending` の Promise が解決も拒否もされない（**推定**: 画面は「読み込み中」「変換中」のまま）。
  wasm のトラップ（`unreachable`）は文に直して返すが、`wasmReady` や `openFiles` を捨てて作り直す処理は無い。ADR-0015 は「panic した wasm のインスタンスは使えなくなるので、その Worker は作り直す」と決めている
- 根拠: `git grep -n "onerror\|terminate()\|wasmReady = null" HEAD -- src/datasource/web.ts src/datasource/copc.worker.ts` で `web.ts` に該当なし（`terminate` は展開用の子 Worker に対してだけ）
- 放っておくと: 1 回 panic した後の操作が、原因の分からない失敗やハングになる（**未確認**: 実ブラウザで panic を起こして試してはいない）

### A-9 [medium] 生成した wasm のコミットと、それが古いことを検査しない CI

- 場所: `src/wasm/pcv-wasm/`（2.1MB）、`.github/workflows/ci.yml` の `e2e` ジョブ、`.github/workflows/pages.yml:98-107`
- 根拠: `pcv_wasm_bg.wasm` は **37 版**コミットされ、生のサイズの合計 45.8 MiB、パック内 4.9 MiB（リポジトリのパック 9.39 MiB の **約 52%**）。
  `ci.yml` の E2E はコミット済みの wasm でビルドし、`pages.yml` は CI で作り直した wasm で公開する
- 何が問題か: Rust を直して `npm run build:wasm` を忘れると、E2E は古い wasm を検査して緑になり、公開される Pages は新しい wasm になる。両者の一致は人の注意だけで保たれている（G1-T15・T18 ではコミットを分けて手で作り直している）
- 放っておくと: 「緑なのに壊れている」（CLAUDE.md が最も多いと書く失敗）の新しい入口になる。リポジトリも版ごとに太る

### A-10 [medium] テストの穴: 大きいファイルと Tauri の経路、ツールの E2E

- 根拠:
  - テストファイルが無い大きいファイル（HEAD）: `copc.worker.ts` 1,733、`point-cloud-renderer.ts` 1,227、`gpu-resources.ts` 1,226、`tauri.ts` 657、
    `SectionPanel.tsx` 316、`useLayerTool.ts` 287、`RasterWindow.tsx` 248、`useLayers.ts` 238、`useCopcViewer.ts` 220、`AppShell.tsx` 207、`useMeasureTool.ts` 201
  - E2E は 3 ファイル 6 テストで、**すべて Web の変換**（LAS・複数 LAS・LAS+PLY・PLY・E57・PCD）。抽出・結合・間引き・フィルタ・DTM・ラスタ・断面・計測の E2E は無い。デスクトップ（Tauri）の経路は TS 側の自動テストが無い
  - UI のテストは 57 欄ある `CopcViewerState` の偽物を作る必要があり、`as CopcViewerState` などのキャストが 10 か所
  - `src/renderer/node-selection-equivalence.test.ts` は「旧実装をこのファイルに残して比べる」テスト。移行の確認としては正しいが、移行が済んだ今は旧実装の写しを保守し続けている
- 良い点: `src/app` はテスト 2,647 行対コード 2,116 行。`pcv-convert` に「メモリに上限があること」の統合テストがある（`import_memory_is_bounded.rs` など）
- 放っておくと: A-1・A-4 のリファクタリングで Web のツールを壊しても CI は気付かない

### A-11 [medium] 57 欄の `CopcViewerState` を全部品にバケツリレーしている

- 場所: `src/state/useCopcViewer.ts:159-217`、`src/state/viewer-types.ts:85-149`、`src/ui/` 全体
- 根拠: `state` オブジェクトの欄は 57。`viewer: CopcViewerState` を受け取るか `viewer={viewer}` を渡す `src/ui` のファイルは 46、`viewer={viewer}` は 69 か所。
  さらに `OpenFilesContext`（14 欄）・`PointCloudToolsContext`（16 欄）・`RasterContext`・`SectionExportContext`・`SectionViewContext` を描画のたびに作り直す
- 何が問題か: どの部品も何でも呼べるので、ある操作がどこから呼ばれるか追うのに `viewer.` の全 grep が要る。テストの偽物が大きい（A-10）。
  欄を 1 つ足すと `viewer-types.ts` の `Pick` と `useCopcViewer.ts` の `state` の 2 か所を揃える必要がある
- 放っておくと: TP の設定（視点・表示範囲）がさらに欄を足す

### A-12 [medium] デスクトップのツールの進捗が変換のイベントを使い回し、開く処理がツールのロックを読んでいる

- 場所: `src-tauri/src/conversion.rs:849`（「Progress uses the same `conversion-progress` event as conversion」）、`src/datasource/tauri.ts:410`、
  `src/app/open-files.ts:62, 138`（`if (!ctx.isToolRunning()) ctx.setConversionProgress(progress)`）、`src/app/point-cloud-tools.ts:66-71`、`useCopcViewer.ts:65`（`toolLock`）
- 何が問題か: 「開く」と「ツール」が、イベント名とグローバルなフラグで隠れて結合している。`toolLock` は React の外の可変オブジェクトで、`useCopcViewer` が作って 2 つのコンテキストに配っている
- 放っておくと: ツールと開く処理を同時に許す・キャンセルを分けるなどの変更で、進捗の取り違えが起きる

### A-13 [low] 使われていないコード・依存・到達しない経路

- 根拠（knip、HEAD に TP-1 の未追跡ファイルが混ざるので、`projection.ts`・`view-presets.ts` の分は除いた）:
  - 未使用依存: `@tauri-apps/plugin-fs`（`package.json`）
  - 未使用 export の例: `tauri.ts` の `startLasConversion`・`startMultiLasConversion`・`onConversionProgress`・`onConversionDone`・`onConversionFailed`（ファイル内でだけ使う。export が要らない）、
    `point-count-estimate.ts` の `parseE57Header`・`stripE57PageCrcs`、`copc-dto.ts` の `toCrsInfo`、`glass.ts` の `GLASS_SURFACE`、`crs-format.ts` の `CRS_READ_FAILED`・`CRS_NONE_LONG` ほか（計 21、型 35）
  - 未使用ファイル: `scripts/diag-sky-ray.ts`（287 行）・`scripts/find-unused-ts.cjs`・`scripts/igpu-bench/bench.mjs` など 6、`docs/video/tools/` 13（動画用の道具なので残す判断もありうる）
  - **URL から開く経路**: HANDOFF は「URL から開く・サンプルは削除」と書くが、`web-protocol.ts:21, 276, 292-297`（`kind: "url"`）・`copc.worker.ts:300`（`WasmCopcFile.openUrl`）・
    `crates/pcv-wasm/src/http_reader.rs`（162 行）・web-sys の `XmlHttpRequest` フィーチャが残る。`src/ui`・`src/app`・`src/state` に URL を渡す呼び出しは無い（**推定: 到達しない**）
  - 互換コード: `opfs.ts:290` の `LEGACY_SCRATCH_DIR_NAME`
- 放っておくと: 読む量が増え、knip のような道具の結果が雑音に埋もれる

### A-14 [low] ダイアログ・オーバーレイの写し

- 根拠: `function rounded(value)` が `DtmDialog.tsx:46`・`FilterDialog.tsx:27`・`SectionDialog.tsx:20`・`ThinDialog.tsx:28` の 4 か所、
  入力欄のクラス文字列 `"h-10 w-full rounded border …"` も同じ 4 ファイル。入力の検査（`positive`・`wholeAtLeast`）が `FilterDialog.tsx:53-59` の部品の中にある。
  jscpd: `LayerToolOverlay.tsx:105` ⇔ `MeasureHud.tsx:23`（21 行）、`SectionLineOverlay.tsx:41` ⇔ `MeasureOverlay.tsx:40`（17 行）、`ground-grid.ts:261` ⇔ `sky.ts:221`（31 行）、`up-axis.ts:32` ⇔ `tool-math.ts:39`（19 行）
- 放っておくと: 入力の検査の規則（UX の「入力の誤りがその場で分かる」）がダイアログごとにずれる

### A-15 [low] 表示設定の二重持ちと、レンダラができる前の設定（推定）

- 場所: `src/state/useDisplaySettings.ts:90-170`
- 何が問題か: setter はどれも `setXState(v); rendererRef.current?.setX(v)`。レンダラがまだ無いとき（初期化中・デバイス復旧中）に変えた値は React にだけ入り、レンダラには届かない（**推定**。初期化後に React の値をレンダラへ流し直す処理は見当たらなかったが、画面では確かめていない）
- 放っておくと: 「設定は ON と表示されるのに効いていない」種類の不具合

### A-16 [low] 画面に出ずコンソールだけに出るエラー

- 根拠: `src/app`・`src/state`・`src/ui` の `console.error` だけの処理が 10 か所。例: `useFileDrop.ts:31`（ドロップで開く準備の失敗。コメントが「viewer の状態に手が届かないのでコンソールだけ」と明言）、
  `point-cloud-tools.ts:247`（キャンセルの失敗）、`useOpfsStorage.ts:52, 62`。中身が空の `catch` は `src/` 全体で 39（多くは localStorage で妥当）
- ADR-0015 の「エラーは黙って捨てず画面へ」から外れる。A-2 の配線の都合で外れている

### A-17 [low] vendor

- `vendor/laz` は 1 か所の修正のためにクレート全体（14,640 行）を持つ。clippy の警告 5 件はここ。`PATCH.md` は 3 クレートとも丁寧（良い点）。上流に直った版が出たら外せるよう、`PATCH.md` に「外す条件」を 1 行足すとよい

### A-18 [low] Rust の panic の書き方はほぼ片付いている（良い点に近い）

- 非テストのコード（`#[cfg(test)]` より前）: `unwrap` 4・`expect` 16・`panic!` 2。`unwrap` 4 件はすべて `src-tauri/src/lib.rs:237-273` の HTTP 応答のビルダー、
  `panic!` は `copc_state.rs:700` のテスト用の注入（`#[cfg(test)]` の中）。`expect` は mutex の poison など
- `catch_unwind` は `src-tauri` の 3 ファイルにある（`pcv://`・変換スレッド・ツール）

---

## リファクタリングの計画

規模は**推定**（S: 半日・差分 300 行程度まで、M: 1〜2 日、L: 3 日以上）。どれも「振る舞いを変えない」が前提で、1 タスク＝AGENTS.md のループ 1 回。
**TP-1〜TP の作業が `src/renderer/` を触っている間は、`src/renderer/` を触るタスク（RF-12）をしない。**

### 順番

```
安全網   RF-0 文書 → RF-1 境界の検査 → RF-10 Web ツールの E2E → RF-15 wasm の鮮度の検査
抽象     RF-2 ツールを DataSource へ → RF-3 進捗イベントを分ける → RF-11 conversion.rs を分ける → RF-9 Worker を分ける＋回復
状態     RF-5 ADR-0021 の見直し（所有者の判断）→ RF-4 マウスツールを src/app へ → RF-6 CopcViewerState を分ける
重複     RF-7 pcv-import クレート → RF-8 係数を 1 か所に → RF-16 ダイアログの部品
片付け   RF-14 使われていないコード（いつでも）、RF-13 コメント（触るたび）
TP の後  RF-12 レンダラの分割
```

### RF-0 文書を現状に合わせる（S）

- 対象: `TaskSheets/ARCHITECTURE.md`（ディレクトリの図・規約の数・「WebGPU は gpu-resources だけ」・I-1 の行・M4-9 の行）、`TaskSheets/ROADMAP.md`（マイルストーンと土台の表）、
  `Cargo.toml`・`eslint.config.js`・`ci.yml`・`DataSource.ts:1-3` の古いコメント。HANDOFF はコーディネーターが更新する
- AC-1: ARCHITECTURE.md に書かれた `src/`・`crates/`・`src-tauri/` のパスがすべて存在する（`grep -o` で抜き出して `test -e` するワンライナーをタスクシートに残す）
- AC-2: ROADMAP の表の「状態」が、実装済みの機能（ピック・抽出・断面・DTM・ラスタ・間引き）と一致する
- AC-3: 規約の番号と数が CLAUDE.md・ARCHITECTURE.md・ci.yml で一致する
- 危険: 少ない。HANDOFF に手を出さない

### RF-1 層の規約を ESLint と madge で検査し、循環をなくす（S〜M）

- 内容: `eslint.config.js` に `no-restricted-imports`（パターン）を足す: `@tauri-apps/*` は `src/datasource/tauri.ts` 以外禁止、`react*` は `src/renderer`・`src/app` で禁止、
  `**/state/use*` は `src/app` で禁止（`import type` も含める）。CI の grep 3 段を置き換える。`madge --circular` を CI に足す（devDependency を足すかは所有者に聞く）
- `update-check.ts` の `openUrl` は `tauri.ts` に移す（または CLAUDE.md に例外として明記する。どちらかを所有者が選ぶ）
- 規約 3 の後半を決め直す: 「`src/ui` は `PointCloudRenderer` クラスを import しない。純粋な関数・定数（`screen-project.ts`・`colormap.ts` など）はよい」と書き換え、`viewer-types.ts` の型の再 export を消す
- 循環 3 件を消す: `ToolProgressState`・`OpfsStorageInfo` を、それを作るモジュール（`src/app/point-cloud-tools.ts`・`useOpfsStorage.ts`）側に置く
- AC-1: `npx madge --circular` が 0 件
- AC-2: わざと違反する 1 行（`src/app` に `import { useState } from "react"`、`src/ui` に `@tauri-apps/plugin-dialog`）を入れると `npm run lint` が落ちることを確かめ、その出力をタスクシートに貼る（コミットはしない）
- AC-3: コメントに `@tauri-apps/api` と書いても落ちない
- 危険: lint のルールが既存のコードで大量に落ちる場合は、先に違反の一覧を出して所有者に見せる

### RF-10 Web のツールの E2E を足す（M）

- 内容: `e2e/` に、合成 LAS を変換して開く → 間引きを実行 → 新しいレイヤーができて点数が元より少ない、を確かめるテスト。可能なら抽出（多角形はキャンバスの座標で入力）も
- AC-1: CI の `e2e` ジョブで緑。わざと `copc.worker.ts` の `thinStart` の振り分けを壊すと落ちることを一度確かめる
- AC-2: 新しい `data-testid` は CLAUDE.md の表に足す
- 危険: ヘッドレスの Chromium で WebGPU が出ないときの扱い（ADR-0016 の方法に合わせる）。RF-2・RF-9 の前に済ませる

### RF-15 コミットした wasm が古いことを CI で検出する（S）

- 内容: `pages.yml` で wasm を作り直した直後に `git diff --exit-code src/wasm/pcv-wasm/*.js *.d.ts`（JS の糊とその型）を見る。`.wasm` 本体はビルドの揺れで一致しない可能性があるので、まず JS/型だけ（**推定**: 再現ビルドか確かめていない）
- 将来: コミットをやめて CI とローカルで作る案（ADR-0012 の見直し）。開発機に wasm-bindgen が要るので、所有者の判断
- AC-1: Rust の `#[wasm_bindgen]` の関数を 1 つ足して作り直さないと、CI が落ちる
- 危険: wasm-bindgen の版がずれると誤検出。`Cargo.lock` の版を使っている既存の手順に合わせる

### RF-2 ツールを `DataSource` に入れ、`instanceof WebSource` をなくす（M）

- 内容: `DataSource` に `tools: PointCloudToolBackend`（`extract`・`merge`・`thin`・`filter`・`dtm`・`openRasterPreview`・`renderRasterPreview`・`closeRasterPreview`・`exportGeoTiff`・`computeSectionLine`・`readSectionProfile`・保存）を足す。
  `TauriSource` は今の `tauri.ts` の自由関数を呼ぶだけ、`WebSource` は今のメソッドを呼ぶだけ。プラットフォームだけが知っている引数（Web の `isMobile`、デスクトップの `tempDir`）は `ToolOptions` にまとめ、それぞれ使う側だけが読む
- 保存先の選択（`chooseGeoTiffDestination` など）は「Web ならダウンロード、デスクトップならダイアログ」をバックエンドの中に入れる
- AC-1: `git grep "instanceof WebSource\|instanceof TauriSource" -- src/app src/state src/ui` が 0
- AC-2: `src/app/` が `datasource/tauri` も `datasource/web` も import しない（型を除く）。RF-1 の lint ルールに足す
- AC-3: `src/app/*.test.ts` が `vi.mock("../datasource/tauri")` を使わずに偽の `DataSource` で書ける
- AC-4: RF-10 の E2E と、デスクトップでの手動確認（抽出・間引き・DTM・ラスタを 1 回ずつ）。デスクトップは**未確認**として所有者の確認手順を残す
- 危険: キャンセルの扱いがデスクトップ（`cancel_las_conversion` を共用）と Web（`convertCancel`）で違う。進捗の単位（`showAsPercent`）。
  1 ツールずつ移し、ツールごとにコミットを分ける

### RF-3 デスクトップのツールの進捗を専用のイベントにする（S）

- 内容: `src-tauri` に `tool-progress` イベントを足し、ツールはそれを使う。`OpenFilesContext.isToolRunning` を消す。`toolLock` はツール同士の排他だけに使う
- AC-1: `git grep isToolRunning -- src/app/open-files.ts` が 0
- AC-2: `open-files.test.ts` から「ツール中は変換の進捗を無視する」テストが消え、代わりにツールの進捗が開く処理の状態に入らないことを `point-cloud-tools.test.ts` で確かめる
- 危険: デスクトップでしか確かめられない（**未確認**になる）。Rust 側は `cargo test -p pcv-tauri`

### RF-11 `src-tauri/src/conversion.rs` を変換とツールに分ける（S）

- 内容: ツールのコマンド 11 個を `src-tauri/src/tools.rs` へ移す（中身は変えない）。共通の `run_tool`・`tool_output_path`・`tool_progress` も移す
- AC-1: `conversion.rs` が変換のコマンドとスレッドだけになる（目安 800 行以下）
- AC-2: `cargo clippy -p pcv-tauri -- -D warnings`・`cargo test -p pcv-tauri` が通る。`lib.rs` の `invoke_handler` の一覧が変わらない（コマンド名を変えない）

### RF-9 `copc.worker.ts` を関心ごとに分け、Worker の回復を入れる（M）

- 内容: `src/datasource/worker/`（`open-read.ts`・`convert.ts`・`tools.ts`・`raster.ts`・`state.ts`）に分け、`copc.worker.ts` は振り分け表だけにする。
  `WebSource` に `worker.onerror` を足し、待っている Promise をすべて拒否してエラーを画面へ出す。wasm のトラップの後は `wasmReady` と開いたファイルの表を捨てて作り直す（ADR-0015 の 2）
- AC-1: 各ファイル 500 行以下。`copc.worker.ts` は 200 行以下
- AC-2: `web.test.ts` に「Worker が `error` を出したら `open()` が拒否される」テスト（偽の `WorkerLike`）
- AC-3: RF-10 の E2E と既存の E2E 6 本が通る
- 危険: Worker の中のモジュール単位の状態（`activeConvertId`・キャンセルのフラグ）を分けるときに取り違える。状態は `state.ts` の 1 つのオブジェクトにまとめてから分割する

### RF-5 ADR-0021 の見直し（判断タスク。コードは書かない）（S）

- 背景: 「状態は React の `useState`、手順は普通の関数」を守ると、非同期の手順が最新の状態を読むために ref の箱（`layersStateRef`・`viewerRef`）が要り、
  実際にそうなっている（A-2）。一方で `useDisplayUnit` は ADR が退けた「外部のストア＋`useSyncExternalStore`」に近い形を使っていて、読みやすい
- 案: (a) 今の形を正式とし、「`useState`＋ref の二重持ちは `useLatest` という 1 つの小さな関数でだけ作る」と決める。
  (b) 関心ごとに**クラスでない**小さなストア（`{ get, set, subscribe }` を返す関数。`useDisplayUnit.ts` と同じ形）を `src/app/` に置き、React は `useSyncExternalStore` で読むだけにする。
  手順の関数は `store.get()` で最新を読めるので ref が要らない
- 推奨は (b)（理由: すでにコードベースにあり、所有者が嫌った「クラスに隠れた状態」ではなく、状態の置き場所が 1 つになる）。ただし ADR-0021 の改訂を戻す話なので、所有者の判断が要る
- AC: 所有者の決定を ADR-0021 に追記する

### RF-4 計測・カット・断面のマウス操作を `src/app/` へ移す（M。RF-5 の決定の後）

- 内容: `src/app/layer-tool.ts`・`src/app/measure-tool.ts` に、状態と出来事から次の状態を返す関数（`onPointerDown`・`onPointerUp`・`onCameraMoved`・`finish`）を置く。
  クリックの判定（5px・ダブルクリックの 2 回目を無視）は 1 つの関数にまとめる。計測とレイヤーツールの排他も `AppShell.tsx` から移す
- AC-1: `useLayerTool.ts`・`useMeasureTool.ts` がそれぞれ 80 行以下で、`useCallback` は 0（ポインタのリスナーの登録の `useEffect` だけ残る）
- AC-2: 状態遷移のテスト（カメラが動いたら多角形を捨てる、3 点未満では確定しない、断面の 2 点目でダイアログ）を `src/app/*.test.ts` に置く
- AC-3: 画面での操作（多角形のカット・断面・距離・面積）を所有者が確かめる手順を残す（**未確認**）
- 危険: タッチ（長押し・ダブルタップ）とカメラ操作の取り合い。TP の視点操作と衝突しないよう、TP-1 の後に

### RF-6 `CopcViewerState` を関心ごとの塊に分ける（M）

- 内容: `viewer.layers`・`viewer.display`・`viewer.storage`・`viewer.errors`・`viewer.tools` のように塊で渡し、部品は必要な塊だけを props で受け取る。`viewer-types.ts` の `Pick` の列挙をなくす
- AC-1: `AppShell.tsx` 以外で `CopcViewerState` 全体を受け取る部品が 0
- AC-2: UI テストの偽物が、その部品が使う塊だけになる（`as CopcViewerState` が 0）
- 危険: 機械的だが差分が大きい。新機能の作業と並行しない。1 塊ずつコミットする

### RF-7 読み込みの Rust を `pcv-import` クレートにまとめる（L）

- 内容: `rayon` に依存しない `crates/pcv-import`（PLY・PCD・E57・LAS の `PointSource`、`write_metadata`、スケール選び）を作り、`pcv-convert` と `pcv-wasm` の両方がそれを使う。
  `pcv-import` は `copc-writer` に依存しないか、依存してもフィーチャを要求しない形にする（ここが二重実装の理由だったので、最初に `cargo tree -e features` で確かめる）
- AC-1: `crates/pcv-wasm/src/{ply_import,pcd_import,e57_import,write_metadata}.rs` が消える（または `pcv-import` を呼ぶ数十行になる）
- AC-2: `cargo tree --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown -i rayon` が「見つからない」
- AC-3: 同じ入力（合成の PLY・PCD・E57、`data/` の実ファイル数個）の変換結果が、移す前と**バイト一致**する（ハッシュを記録する）。E2E の点ファイル変換 3 本が通る
- 危険: ワークスペースの二重定義（`pcv-wasm` はワークスペースの外）。`pcv-import` はどちらのワークスペースにも属さないパス依存にするか、ルートのワークスペースに入れて `pcv-wasm` からは `path` で参照できるか、を最初の 1 時間で試し、ダメなら止まって報告

### RF-8 Rust と TS で二重の定数・判断を 1 か所にする（S）

- 内容: 空き容量の係数（11）・点あたりのバイト数などを `pcv-wasm` から関数として出し、`opfs.ts` はそれを読む。または、TS 側を正としてテストで両者の一致を確かめる
- AC-1: 係数の数値リテラルが 1 か所（またはテストで照合される 2 か所）
- 危険: 少ない

### RF-16 ダイアログの入力欄と検査を共通にする（S）

- 内容: `NumberField` 部品（ラベル・単位・誤りの表示）と、`src/app/` の検査関数（`parsePositive`・`parseWholeAtLeast`）。`rounded` を 1 つに
- AC-1: `function rounded` と入力欄のクラス文字列が 1 か所
- AC-2: 幅 375px・1280px のスクリーンショットで 4 つのダイアログの見た目が変わらない

### RF-14 使われていないコードを消す（S、いつでも）

- 内容: knip の結果を 1 件ずつ確かめて消す。`@tauri-apps/plugin-fs` を外す（`src-tauri` の Rust 側のプラグイン登録も見る）。URL から開く経路（`http_reader.rs`・`openUrl`・`kind: "url"`）は**所有者に聞いてから**（将来使う予定があるかもしれない）
- AC-1: knip の未使用 export が 0、または残すものを `knip.json` の許可リストに理由つきで書く
- 危険: `src/wasm/` の生成物の export（`initSync`）は消さない。テストだけが使う export は「テスト用」と分かる名前にするか残す

### RF-13 コメントの整理（触るたび。一括ではしない）

- 決まりの提案（CLAUDE.md に足す。所有者の判断）:
  - 触った関数のコメントは英語にするだけでなく、**経緯（いつ・どのタスクで・何が壊れたか）は TaskSheets に移し、コードには「なぜこうするか」だけを残す**
  - タスク ID は、その TaskSheet を読まないと理解できない判断の所にだけ残す（目安: 1 ファイル 3 個まで）
  - コメントの比率が 40% を超えるファイルを触ったら、その関数は比率を下げる
- 測り方: 本レビューの集計スクリプト（`git show HEAD:` でコメント行・日本語・タスク ID を数える）を `scripts/` に置き、CI ではなく報告用に使う
- AC（タスクごと）: 触ったファイルの日本語のコメント行とタスク ID の数を、前と後で作業報告に書く

### RF-12 レンダラを分ける（L。TP の作業が終わってから）

- 内容:
  - WGSL を `src/renderer/shaders/*.wgsl` に出し、Vite の `?raw` で読む（`rampToWgslFunction` で作る部分は文字列の結合のまま）
  - `drawFrame`（約 305 行）をパスごとの関数（点群→オフスクリーン、空・グリッド、EDL の合成）に分ける
  - `PointCloudRenderer` から、カメラの移動・注視・ピック（`view-controller.ts`）、レイヤーの登録と見た目（`layer-registry.ts`）、表示設定（1 つの `RenderSettings` を `applySettings(partial)` で受け取る。A-15 も直る）を出す
- AC-1: 各ファイル 600 行以下。公開 API（`src/state` から呼ばれるメソッド）の名前は変えない、または同じコミットで呼び出し側も直す
- AC-2: typecheck・lint・vitest・E2E が通る
- AC-3: 画面: 実 GPU の Edge で、渋谷のデータを同じ視点（TP-1 の視点の保存を使う）で分割前と後に撮り、所有者が見比べる。CI では確かめられない（**未確認**になる）
- 危険: EDL の `depthStencil` の事故（ADR-0011）のように、緑のまま真っ黒になる種類の失敗。パスを 1 つ分けるごとにコミットし、画面で見る

### やらない方がよいこと

- **コメントを一括で英訳する・一括で削る。** 差分が数千行になり、所有者がレビューできず、作業中の TP と衝突する（CLAUDE.md・ADR-0015 の「触ったところから」と同じ理由）
- **TP の作業中に `src/renderer/` を分割する。** 同じファイルを両方が書き換える
- **状態管理のライブラリ（Redux・Zustand など）を入れる。** ADR-0021 が理由つきで退けている。RF-5 の (b) は依存を足さずに同じ効果が得られる
- **`pcv-wasm` をルートのワークスペースに入れて重複を解こうとする。** Windows の CI の clippy・test が壊れることを `Cargo.toml` のコメントが記録している。RF-7 のように「両方から使える小さなクレート」を作る
- **vendor のクレートを上流の最新へまとめて上げる。** 変換結果のバイト一致が崩れたとき原因を切り分けられない。上げるなら 1 クレートずつ、RF-7 の AC-3 と同じ比較で
- **リファクタリングと機能追加を同じコミット・同じタスクに混ぜる。** 1 コミット 1 関心事（CLAUDE.md）
- **実装の写しのテストを足して「テストがある」ことにする。** 状態遷移・境界・入出力で書く

---

## 良い点（残すべき設計）

- **`pcv-core` が Tauri を知らず wasm でビルドできる**ことを CI（規約 1）が実際にビルドして確かめている。Web 版とデスクトップ版が同じ Rust の中核を使う構成は正しい
- **Rust の panic を出さない書き方がほぼ実現している**（非テストの `unwrap` 4・`panic!` 2、どちらも理由がある）。`catch_unwind` で境界を守り、wasm でのメモリ確保の失敗を `alloc_guard.rs` でコンソールに出す、など ADR-0013/0015 が形になっている
- **メモリが点数に比例しないことをテストで確かめている**（`import_memory_is_bounded.rs`・`import_merge_memory_is_bounded.rs`・`sequential_lod_open_files_bounded.rs`）
- **`src/app/open-files.ts` は ADR-0021 の手本になっている**（コンテキストを受け取る普通の関数、偽の `DataSource` で 300 行のテスト）。`src/app` 全体でテストがコードより多い
- **純粋な関数への切り出し**（`node-selection.ts`・`layers.ts`・`measure.ts`・`viewer-status.ts`・`section-math.ts`）と、それぞれのテスト
- **vendor の改変の記録**（`PATCH.md` が 3 クレートとも、何を・なぜ・どう確かめたかを書いている）
- **「緑でも動くとは限らない」を前提にした文化**: 実ブラウザで変換を通す E2E、CI でのクラッシュの診断の記録、測っていないことを「未確認」と書く決まり
- **mdBook の「処理の流れ（入口つき）」**は、上の文書（A-6）と違って更新が続いている（`frontend/state.md` は 2026-10-22）
- typecheck・lint・vitest（820）・clippy がすべて通る状態を保っている
