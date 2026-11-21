# アーキテクチャ地図

このファイルは**常に最新の全体像**を保つ。実装で構成が変わったら、同じコミットでここも直す。
個々の作業の経緯は各 TaskSheet に、判断の理由は `ADR-*.md` にある。

決定の根拠は [ADR-0001](./ADR-0001-architecture.md) を参照。

## 構成一行まとめ

**Tauri v2 の殻の中で、React + Tailwind の UI と TypeScript の WebGPU レンダラが動き、
重い処理（COPC 読込・octree 走査・解析）だけを Rust のネイティブバックエンドが担う。**

## ディレクトリ

```
point-cloud-viewer/
├─ TaskSheets/            設計判断(ADR)と作業記録
├─ docs/book/             設計書（mdBook。処理の流れ・入口つき）
├─ crates/
│   ├─ pcv-core/          COPC読込・octree走査・解析アルゴリズム（抽出・断面線・DTM・ラスタ・間引きなど）
│   │                     → Tauri を知らない。wasm にもコンパイルできる
│   ├─ pcv-convert/       生LAS/LAZ/E57/PLY/PCD → COPC 変換、結合、DTM、ラスタ、間引き・フィルタ（デスクトップ用）
│   │                     → pcv-core に依存する。読み込みの一部は pcv-wasm に写しがある（A-5。RF-7 で解消予定）
│   └─ pcv-wasm/          pcv-core を wasm-bindgen で包む層(ADR-0012)
│                         → wasm固有の依存(wasm-bindgen/web-sys)はここに閉じる。
│                           ルートのCargoワークスペースには入れていない
├─ vendor/                パッチ済みの上流クレート（copc-reader・copc-writer・laz。それぞれ PATCH.md）
├─ src-tauri/             Tauri アプリの Rust 側
│                         → pcv:// の配信と、変換・ツールのコマンド（conversion.rs は 1,500 行超。RF-11 で分ける予定）
├─ e2e/                   Playwright の E2E（Web 版の変換。ADR-0016）
├─ scripts/               合成 LAS の生成・診断・計測のスクリプト
├─ src/                   フロントエンド (TypeScript)
│   ├─ datasource/        DataSource 抽象と実装(TauriSource / WebSource)。Web の Worker（copc.worker.ts）もここ
│   ├─ wasm/pcv-wasm/     wasm-bindgenの生成物(コミット済み。ADR-0012参照)
│   ├─ renderer/          点群レンダラ (WebGPU。ADR-0002によりWebGL2フォールバックは無し)
│   │                     → node-selection.ts(描画ノードの判定・純粋関数)/
│   │                       gpu-resources.ts(デバイス・パイプライン・drawFrame)/
│   │                       point-cloud-renderer.ts(フレームループ・外部公開API)
│   │                       shaders/*.wgsl(WGSL のシェーダー。各 .ts が ?raw で読む)
│   │                       ほかに projection.ts・view-presets.ts など。責務の詳細は「守る規約」の下の注記参照
│   ├─ app/               手順（開く・変換・レイヤー・ツール・視点）。React を知らない普通の関数と小さなストア（ADR-0021）
│   │                     → tea.ts: TEA の createProgram（ADR-0022。まだ使う機能は無い）
│   ├─ plugin-api/        プラグインが import してよいコアの唯一の入口（型と PLUGIN_API_VERSION だけ。ADR-0023）
│   ├─ core/              plugin-host.ts: プラグインを読み込み、登録された物を React に依存しないストアとして持つホスト
│   ├─ plugins/           builtin.ts: 組み込みプラグインの一覧（PL-0 では空）。1プラグイン = 1フォルダ（PL-1 から）
│   ├─ state/             React のフック（use*.ts）と、フックから出された純粋なモジュール。移行の途中（A-2）
│   └─ ui/                React コンポーネント。役割ごとのフォルダに分かれる(R2。一覧は R2-ui-components.md)
│       ├─ shell/         AppShell(全体の組み立て)・ViewerPanel(canvas)・UnsupportedDeviceScreen
│       ├─ toolbar/       上部のツールバー（Toolbar.tsx、buttons/ に 1 ボタン 1 ファイル、ショートカット）
│       ├─ layers/        左のレイヤー欄(一覧・操作ボタン・情報・変換の内訳)
│       ├─ dialogs/       共通Dialogと、着色・見た目・変換・エラーのダイアログ
│       ├─ settings/      設定の一覧(SettingsModal)と、1ページ1ファイルの設定ページ(pages/)
│       ├─ tools/         計測・抽出・間引き・フィルタ・DTM・視点などの、3Dビュー上のオーバーレイと操作ダイアログ、ラスタの窓
│       ├─ section/       断面線のオーバーレイと断面図のパネル
│       ├─ status/        下部のステータスバーと更新通知
│       ├─ plugins/       ホストに登録された物（リボンの項目・ステータスの項目・ダイアログ）を描く部品と、プラグインの UI ごとの Error Boundary
│       └─ common/        glass.ts・crs-format.ts など、複数のフォルダが使う小さな部品
├─ Cargo.toml             cargo workspace (pcv-wasm と vendor は含まない)
└─ package.json
```

## データの流れ

```
  COPC ファイル (.laz)
        │  mmap / Range
        ▼
  ┌───────────────┐
  │   pcv-core    │  octree 走査、可視ノード判定、解析
  │   (Rust)      │
  └───────┬───────┘
          │
  ┌───────▼───────┐
  │  src-tauri    │  pcv://<level-x-y-z> でノードのバイナリを配信
  └───────┬───────┘
          │  カスタムプロトコル（invoke ではない → ADR-0001）
          ▼
  ┌───────────────┐      ┌──────────────┐
  │  DataSource   │─────▶│   renderer   │──▶ <canvas>
  └───────────────┘      └──────────────┘
          │                      ▲
          │              ┌───────┴──────┐
          └─────────────▶│  state / ui  │  React + Tailwind
                         └──────────────┘
```

## 守る規約

この5つが崩れると Web 版が出せなくなるか、実装が追えなくなる。規約 1 は CI の `invariants` ジョブが、規約 2・3・5 は ESLint の `no-restricted-imports`（`eslint.config.js`。CI の `frontend` ジョブの `npm run lint`）が検査する（4 は検査の対象外）。import の循環は `npm run check:circular`（madge）が検査する。

1. **`pcv-core` は Tauri を知らない。** `tauri` への依存を足さない。ここが wasm で動く
   ことが、Web 版のバックエンドを成立させる条件。wasm-bindgen/web-sys等の
   wasm固有の依存も`pcv-core`には入れず、`crates/pcv-wasm`（ADR-0012）に閉じる。
2. **Tauri の API（`@tauri-apps/*` の npm パッケージ全部。`plugin-dialog`・`plugin-opener` も）を import してよいのは `src/datasource/tauri.ts` だけ。**
   他のファイルは `DataSource` インターフェースしか見ない。Web 版は
   `src/datasource/web.ts`（`WebSource`）がこれを実装する（ADR-0012）。
3. **`src/renderer/` は React を知らない。** canvas と `DataSource` だけを受け取る。
   逆向き（RF-1 で決め直した）: **`src/ui/` は `PointCloudRenderer` クラスを import しない。** 純粋な関数・定数・型
   （`screen-project.ts`・`colormap.ts`・`view-presets.ts` など）はよい。レンダラへの操作は `src/state/`・`src/app/` を経由する。
   以前の「`src/ui/` はレンダラを直接触らず、`src/state/` を経由する」は、検査されておらず守られていなかったので、実際に守れる形に書き直した。
4. **大きいデータは `pcv://` カスタムプロトコルで運ぶ。`invoke` は制御メッセージ専用。**
   理由と実測値は ADR-0001 を参照。
5. **React only displays; `src/app/` does not know React** (ADR-0021, owner 2026-10-18, revised after R12). Workflows
   (open/convert, layers, tools, measuring, display settings) are plain functions in `src/app/` that take a context object.
   State stays in React (`useState` in small `src/state/` hooks) and is changed only through setters in the context.
   Classes only for objects that own long-lived resources (`PointCloudRenderer`, `WebSource`). `src/app/` imports neither
   `react` nor `src/state/use*` (not even `import type`); `src/ui/` calls `src/app/` functions directly. Rules 2, 3 and 5 are checked by ESLint
   (`eslint.config.js`, run by `npm run lint`). (2026-11-16: state now goes in small non-class stores; see the RF-5 revision of ADR-0021. The
   "`useState` in small hooks" sentence above is the older form.)

### `src/renderer/` の内部構成（規約3の補足）

`point-cloud-renderer.ts` が1,055行まで肥大化し、性質の違う3つの関心事
（ノード選択・フレームループ・GPUリソース管理）が同居して実装を追いにくく
なっていたため、以下の3ファイルに分割した（振る舞いは変えていない）。

- **`node-selection.ts`** — 「このフレームでどのノードを描くか」の判定
  (`selectNodesForFrame`)。クラスのフィールドに触らない純粋関数で、WebGPU も
  React も知らない。キャッシュへのアクセスは `NodeSelectionCache` インター
  フェース越しに受け取るので、WebGPU を起動せずに vitest で検証できる。
- **`gpu-resources.ts`** — デバイス・パイプライン・テクスチャ（深度・
  オフスクリーン）・sky/grid/EDL の初期化・リサイズ・`drawFrame` のコマンド
  エンコードを持つ。当初は「WebGPU の API を直接叩くのはこのファイルだけ」としたが、実際は
  `edl.ts`・`sky.ts`・`ground-grid.ts`・`depth-pick.ts` も自分のパイプラインとバッファのために `device.create*` を呼ぶ
  （2026-11-16 の REVIEW で確認）。このファイルだけが持つのは、デバイスの初期化と喪失の監視、深度・オフスクリーンのテクスチャ、`drawFrame`。
- **`point-cloud-renderer.ts`**（`PointCloudRenderer` クラス） — rAF・カメラ・
  統計・点予算の自動調整の呼び出し、ローダーとの接続、そして外部公開 API
  (`src/state/useCopcViewer.ts` が使う唯一の入り口)を持つオーケストレーション役。

## 現在の状態

| 領域 | 状態 |
|---|---|
| リポジトリ雛形 | 完了（M0-1） |
| WebGPU 可否の確定 | 完了（M0-2）: WebGPU 採用。[ADR-0002](./ADR-0002-rendering-api.md) 参照 |
| カスタムプロトコル | 完了（M0-3）: `pcv://` が `invoke` より有意に高速なことを実測済み。[M0-feasibility.md](./M0-feasibility.md) 参照 |
| CI | 完了（M0-4）: 全ジョブ緑を実測。規約1/規約2 をCIで機械的に強制している |
| COPC 読込 | 完了（M1-1）。`copc-reader` は vendor/ でパッチ済み（[ADR-0003](./ADR-0003-copc-crate.md)） |
| 点群のWebGPU描画 | 完了（M1-3）: point spriteパイプライン・orbitカメラ。[M1](./M1-point-rendering.md) |
| octree LOD / 点予算 | 完了（M1-4）。3.6億点を 13MB / 32ms で開けることを実測。**優先度の式は次元が合っておらず深いレベルが事実上ロードされない不具合があったため直した。点予算もADR-0009に沿ってフレーム時間の閉ループで自動調整するようにした（手動設定も従来どおり可能）。**[ADR-0010](./ADR-0010-lod-priority-and-point-budget.md) 参照 |
| `pcv://` 並行リクエストの直列化解消 | 完了（M2先頭）: 非同期プロトコルハンドラ + `CopcFile`のリーダープールに変更。並行数8でスループットが改修前比4.2〜10倍。[ADR-0007](./ADR-0007-pcv-protocol-concurrency.md) 参照 |
| カーソル位置へのズーム | 完了（M1-5）: octreeのノードAABBへの粗いレイキャストでカーソル下の点を求め、そこへ`target`を寄せながらズームする。パン速度にシーンスケール由来の下限を追加。カメラの数式部分はvitestで確認済みだが、実際の画面での操作感はGUI目視待ち。[M1](./M1-point-rendering.md) M1-5参照 |
| 上方向(up軸)の集約 | 完了（M2-0b）: `src/renderer/up-axis.ts`にupAxisを1箇所へ集約し、既定をZ-up（`[0, 0, 1]`）に変更。カメラ(`eye()`/`viewMatrix()`)・パンがすべて同じ値を参照する。`pitch=0`が水平になることと`setUpAxis()`への追従はvitestで確認済み。実機での「地面が水平に見える」目視確認は所有者待ち。[M2](./M2-shading-and-ui.md) M2-0b参照 |
| 空の背景・地面グリッド | 実装済み（M2-0c）、既定はオフ: `src/renderer/sky.ts`（手続き的グラデーション+地平線の線）と`src/renderer/ground-grid.ts`（スケール自動追従のグリッド）。どちらも深度を書かず点群より奥に描かれる。UIから「空/単色(暗)/単色(明)」とグリッドのon/offを切り替え可能。地平線の見え方・fps実測は所有者の実機待ち。[M2](./M2-shading-and-ui.md) M2-0c参照 |
| EDL シェーディング | 実装済み（M2-1）、既定はオン: `src/renderer/edl.ts`。点群だけを描くオフスクリーンの色+深度テクスチャを新設し、`point-cloud-renderer.ts`の`drawFrame()`を2パス化(点群→オフスクリーン、空/グリッド+EDL合成→スワップチェーン)することで、EDLの陰影が空・グリッドに掛からないようにした。オン/オフのみUIから調整可能。強さは所有者が実機で確認して`0.05`に固定した(UIのスライダーは削除済み)。`sofi.copc.laz`での実際の見え方・fps実測は所有者の実機待ち。[M2](./M2-shading-and-ui.md) M2-1参照 |
| カラーマップ切替 | 実装済み（M2-2）: 色計算の純粋関数(`src/renderer/colormap.ts`、標高/強度は共通の青→緑→黄→赤ランプ(CloudCompare風)・分類はASPRS標準コード表)、`LayerPanel`の着色モード選択、`shaders/points.wgsl`の頂点シェーダでの結線(RGB/標高/強度/分類の4モード)まで完了。RGB無しファイルでの標高への自動フォールバックあり。標高の正規化レンジはLASヘッダーの実データ範囲(`CloudInfo.min`/`max`、`src/renderer/scene-bounds.ts`)から取る(ノードのoctreeセル(立方体)を使うと標高が一色に潰れる実機不具合があったため分離した)。色のランプはTS側(`colormap.ts`)の制御点からWGSLを生成し(`rampToWgslFunction`)、食い違いを防いでいる。`sofi.copc.laz`/`autzen-classified.copc.laz`等での実際の見え方は所有者の実機待ち。[M2](./M2-shading-and-ui.md) M2-2参照 |
| WebGPU エラーの可視化 | 完了: `device.onuncapturederror`/`device.lost`の監視、初期化を`pushErrorScope`で区切っての箇所特定、画面への不透明なエラーバナー表示。EDL(M2-1)で「テスト・CIはすべて緑なのに画面は真っ黒になった」事故を受けて新設。[ADR-0011](./ADR-0011-gpu-error-visibility.md)参照 |
| `point-cloud-renderer.ts` の分割 | 完了: 1,055行あったファイルを`node-selection.ts`（ノード選択、純粋関数）・`gpu-resources.ts`（デバイス・パイプライン・`drawFrame`）・`point-cloud-renderer.ts`（フレームループ・外部公開API）に分割。詳細は「守る規約」の下の`src/renderer/`の内部構成を参照。`selectNodesForFrame`の単体テストを新設。公開APIは変更なし（`src/state/useCopcViewer.ts`に差分無し）。typecheck/lint/vitest/build 確認済み。実際の画面描画が分割前と同じに見えるかは所有者の目視待ち |
| Web版（GitHub Pages） | 実装済み: `crates/pcv-wasm`が`pcv-core`をwasm-bindgenで包み、Web Worker（`src/datasource/copc.worker.ts`）内の同期I/O（`FileReaderSync`/同期XHR）で`Read + Seek`を実装。`WebSource`が`DataSource`を実装し、`useCopcViewer.ts`が実行環境（Tauri/ブラウザ）で`TauriSource`/`WebSource`を切り替える。並列化はまずWorker1本（複数化は必要が見えてから）。`.github/workflows/pages.yml`でCI上にwasmビルド・静的ビルドを追加済み。`sofi.copc.laz`（2.03GB）を実際にブラウザで開く確認は未実施。[ADR-0012](./ADR-0012-web-worker-sync-io.md)参照 |
| 生LAS/LAZ→COPC変換（M4-3） | 実装済み: `crates/pcv-convert`（`streaming.rs`が`copc-writer`の低水準API`write_streaming_with_cancel`を呼ぶ本体。`cache.rs`/`output_path.rs`/`disk_space.rs`/`copc_detect.rs`/`crs_override.rs`/`write_metadata.rs`が判定・付随処理）と`src-tauri/src/conversion.rs`（Tauriコマンド・イベントの薄い配線）で構成する。デスクトップ・**Android**（`content://`経由）の両方で、同じプロセス内の別スレッド＋`CancelCheck`で変換しキャンセルできる（別プロセスは使わない。ADR-0006追記）。読み込み段階の進捗（点数ベース、正確な割合）とその後の段階名を`conversion-progress`イベントで通知し、`LayerPanel`が表示する。既にCOPCなら即座に開き（ヘッダー判定）、変換済みキャッシュ（指紋サイドカー）があれば再変換しない。空き容量は変換前に確認する（Windows: `GetDiskFreeSpaceExW`、Unix系/Android: `statvfs`）。CRSはWKTのVLRをそのまま運び、GeoTIFFキーのみの入力は`pcv-core`（M4-5）の検証済みパラメータからWKTを組み立てて補う。Android実機・GUIでの目視確認は未実施。[M4](./M4-import-and-conversion.md) M4-3参照 |
| 生LAS/LAZ→COPC変換・Web版（M4-6b） | 実装済み: `vendor/copc-writer`をScratchFsトレイト越しに改修（`vendor/copc-writer/PATCH.md`）し、OPFS(Origin Private File System)向けの実装(`crates/pcv-wasm/src/opfs.rs`の`OpfsScratchFs`)を追加した。事前に開いたOPFS一時ファイルのプール(既定600、`OPFS_SCRATCH_POOL_SIZE`)を使い回すことで、非同期なOPFSハンドル取得と同期のScratchFsアルゴリズムの食い違いを埋めている。読み込みは`WasmConverter::feed`をTypeScript側(`copc.worker.ts`)からバッチ単位で駆動し、バッチの合間にWorkerのイベントループへ制御を返すことでキャンセルを受け取れるようにした(後処理段階(`finish`)は1回の同期呼び出しで割り込めない。GitHub PagesがCOOP/COEPヘッダーを設定できずSharedArrayBufferが使えないための制約。ADR-0006参照)。空き容量の事前確認(`navigator.storage.estimate()`、入力の11倍が必要、デスクトップと同じ係数)・同じファイルの再変換防止(指紋サイドカーをOPFSに保存)・ダウンロード(`URL.createObjectURL`)を実装した。OPFSが使えないブラウザでは案内を出す。OPFSの`as_bytes`(spillのランダムアクセス読み出し)はメモリマップ相当のAPIが無いため`Vec<u8>`へ丸ごと読み込む実装で、**大きい入力(sofi級)はWeb版では変換できない**制約がある。新規テストは`crates/pcv-wasm/tests/memory_scratch_conversion.rs`(ネイティブ、MemoryScratchFs)と`src/datasource/opfs.test.ts`(純粋関数)。ブラウザでの実機確認は未実施。[M4](./M4-import-and-conversion.md) M4-6/M4-6a/M4-6b、[ADR-0006](./ADR-0006-conversion-strategy.md)参照 |
| E57/PLY/PCD → COPC変換（M4-9） | 実装済み: `crates/pcv-convert/src/import/`。各形式の読み込みを`PointSource`トレイト（1点読むたびにコールバックへ渡す、全点を`Vec`に貯めない）に統一し、`SpillWriter`へ直接push→`finalize`でboundsを得てからスケール・オフセットを選ぶ→`write_copc_from_spill_with_fs`、という1パスの経路で直接COPCへ書き出す（中間LASを作らない。M4-4時点は「E57/PLY/PCD→LAS→既存のLAS/LAZ経路」の2段階かつ全点メモリ保持だった）。PCDの`binary_compressed`のみ、フォーマットの仕様上メモリが点数に比例する（展開後サイズの上限512MiBを超える入力は展開前に拒否する）。デスクトップ・Androidのファイル選択（`src/datasource/tauri.ts`）から開け、進捗・キャンセル・キャッシュ・空き容量チェックはM4-3のLAS/LAZ向けの仕組みをそのまま使う（`src-tauri/src/conversion.rs`が拡張子で経路を振り分けるだけ）。CRSは推測せず「不明」のまま`pcv-core`で開ける。Web版へは R7 で配線済み（`crates/pcv-wasm` の `ply_import.rs`・`pcd_import.rs`・`e57_import.rs`。デスクトップ側の写しで、二重実装は A-5）。Android実機・GUIでの目視確認は未実施。[M4](./M4-import-and-conversion.md) M4-9、[ADR-0008](./ADR-0008-formats-and-crs.md)参照 |
| Web版変換のE2E(ヘッドレスChromium) | 実装済み: `playwright.config.ts`・`e2e/web-conversion.spec.ts`。本番(GitHub Pages)と同じサブパスで`vite build`→`vite preview`したものを、`channel: "chromium"`（フルChromiumバイナリ、`chrome-headless-shell`では`navigator.gpu.requestAdapter()`が常に`null`になることを確認した）でheadless起動し、テストごとに`scripts/make-test-las.ts`が生成する合成LAS(2,000点、色・強度付き、コミットしない)を選択→変換→「変換の内訳」とダウンロードリンクの表示→エラー無し→Console panic無し→開いた点群の点数>0、を確認する。`.github/workflows/ci.yml`に独立ジョブ`e2e`として追加済み。M4-12の内訳パネルが変換直後に消える不具合（修正前）で実際にこのテストが落ちることを確認済み。デスクトップ・Android・実GPU・Safari/Firefoxは対象外。[ADR-0016](./ADR-0016-e2e-web-conversion.md)参照 |
| ピッキング・計測・点の選択・抽出・結合 | 実装済み: 深度ピック（`src/renderer/depth-pick.ts`）、計測、多角形での抽出、レイヤーの結合。結果は新しいレイヤーとして作る（[ADR-0018](./ADR-0018-layer-centric-operations.md)）。ツールの呼び出しは `src/app/point-cloud-tools.ts` が`instanceof WebSource`で Web とデスクトップに振り分けている（[REVIEW](./REVIEW-architecture-2026-11.md) A-1。RF-2 で `DataSource` に入れる予定） |
| 断面線・断面図 | 実装済み（G2）: `crates/pcv-core/src/section_line*`・`profile*`、`src/app/section-*.ts`、`src/ui/section/`。CSV・DXF の書き出しまで |
| ラスタ・DTM・間引き・フィルタ | 実装済み（G1）: 点群をラスタ（GeoTIFF）にする、布シミュレーション（CSF）の DTM と LandXML、LOD の間引き・外れ値のフィルタ。`crates/pcv-core`（`raster/`・`dtm/`・`csf.rs`・`thin.rs`・`outlier.rs`）と、`pcv-convert`・`pcv-wasm`・`src-tauri/src/conversion.rs` |
| 視点（TP-1） | 実装済み: 平行投影・定位置の視点（`src/renderer/projection.ts`・`view-presets.ts`）。画面・キー・状態は組み込みプラグイン `pcv.view`（`src/plugins/view/`、PL-1）、レンダラへ渡す手順とビューアごとの文脈は `src/app/view.ts`。[TP-trendpoint-parity.md](./TP-trendpoint-parity.md) |

## TEA とプラグインの土台（PL-0 で入った物）

- **TEA（Model / Msg / update / view）**（[ADR-0022](./ADR-0022-tea-architecture.md)）: `src/app/tea.ts` の `createProgram(init, update, { effectFailed, report })` が
  `getModel`・`dispatch`・`subscribe` を返す。`update` は純粋な関数で、I/O は `Effect` だけが行う。`update` が投げたら、その Msg を捨てて `report` に流し、残りの Msg は同じ `dispatch` の中で続ける（PL-1）。効果の例外（同期の throw・Promise の reject）は
  `effectFailed` で Msg に変えて `update` に戻す。その失敗の Msg の処理中にまた効果が失敗したら、`update` に戻さず `report` に流す（同期の無限ループを作らない。ADR-0022 の改訂）。ライブラリは入れていない。テストは `src/app/tea.test.ts`。
- **プラグインの API**（[ADR-0023](./ADR-0023-plugins.md)）: `src/plugin-api/index.ts` に `PcvPlugin`・`PluginHost` の型。口は
  `ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`layers`・`view`・`program`（`layers`・`view` は PL-1 で足した読む側と視点の操作だけ。ADR-0023 の改訂（PL-1））。React を import しないので、描く物は `ViewNode`（ReactNode と互換の型）で受け取る。
- **ホスト**: `src/core/plugin-host.ts` の `createPluginHost` が、プラグインを順に `activate` し、登録された物を React に依存しないストアとして持つ。
  `activate` の例外・知らない `apiVersion`・同じ id・同じキーのショートカット・アプリが使っているキー（`APP_SHORTCUT_KEYS`。PL-1 から Delete・Enter・Escape・Tab）・プラグインのプログラムの効果の失敗は、既存の `reportError`（`ErrorDialog` とログ）に流す。
  ショートカットの「入力欄では効かない」判定は、登録の種類（`harmless` → `isTypingTarget`、`irreversible` → `isFormControl`）でホストが行う。テストは `src/core/plugin-host.test.ts`。
- **描画**: `src/ui/plugins/` が `useSyncExternalStore` でホストを読み、リボンの項目を `Toolbar.tsx` の「開く」の次の区切りの後（グループ `view`）に、
  ステータスの項目を `StatusBar.tsx` の fps の後に、ダイアログを既存の `Dialog` の枠で描く。プラグインの UI ごとに Error Boundary がある。`window` の `keydown` は `usePluginHost` が1つだけ登録する。
- **組み込み**: `src/plugins/builtin.ts` に `pcv.view`（PL-1）。視点の文脈（`createViewContext`）は `useCopcViewer` がビューアごとに作り、レンダラの付け外し（`useRendererLifecycle`）とホストに渡す。
- **層の規約**（`eslint.config.js`、テストは `src/layer-rules.test.ts`）: `src/plugin-api/**` は React・`src/ui`・`src/state`・`src/renderer`・`src/datasource` を、
  `src/core/**` は React・`src/ui`・`src/state` を import しない（JSX も書かない）。`src/plugins/**` が import してよいのは `src/plugin-api`・自分のフォルダ・`react`・`lucide-react`・`src/ui/kit` だけ（RF-1 で先に入れた）。

## これから（まだ無い。決まっただけ）

次は決定済みの**将来の形**で、今のコードにはまだ無い。無いものを「ある」と読まないこと。

- 既存の `{ get, set, subscribe }` のストア（ADR-0021 の RF-5 の改訂）は、プラグイン化のときに TEA の形へ移す
- TS 側の機能（視点・計測・断面・結合・ラスタ・間引き・フィルタ・DTM）を、`src/plugins/<id>/` の 1 機能 1 フォルダに分ける（PL-1 の視点 `pcv.view` から）。
  コアが残すのは WebGPU のレンダラ・データの読み込み・レイヤーの一覧・殻（リボン・ダイアログの枠・ステータスバー）。組み込みも同じ API で書く。
  API の `layers`・`tools`・`view`・`units`・`settings` は、使う機能を移すときに足す。`src/ui/kit` もまだ無い
- 外部のプラグインは `sandbox="allow-scripts"` の iframe の中で動かし、権限は利用者に許可を求める（PL-9a・PL-9b）。段階は ADR-0023 の表
