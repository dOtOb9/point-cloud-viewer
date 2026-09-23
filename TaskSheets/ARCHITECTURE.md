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
├─ crates/
│   ├─ pcv-core/          COPC読込・octree走査・解析アルゴリズム
│   │                     → Tauri を知らない。wasm にもコンパイルできる
│   └─ pcv-wasm/          pcv-core を wasm-bindgen で包む層(ADR-0012)
│                         → wasm固有の依存(wasm-bindgen/web-sys)はここに閉じる。
│                           ルートのCargoワークスペースには入れていない
├─ src-tauri/             Tauri アプリの Rust 側
│                         → 薄く保つ。pcv:// の配信と制御コマンドだけ
├─ src/                   フロントエンド (TypeScript)
│   ├─ datasource/        DataSource 抽象と実装(TauriSource / WebSource)
│   ├─ wasm/pcv-wasm/     wasm-bindgenの生成物(コミット済み。ADR-0012参照)
│   ├─ renderer/          点群レンダラ (WebGPU。ADR-0002によりWebGL2フォールバックは無し)
│   │                     → node-selection.ts(描画ノードの判定・純粋関数)/
│   │                       gpu-resources.ts(WebGPU API はここだけ)/
│   │                       point-cloud-renderer.ts(フレームループ・外部公開API)
│   │                       に分割。責務の詳細は「守る規約」の下の注記参照
│   ├─ state/             アプリ状態
│   └─ ui/                React コンポーネント
├─ Cargo.toml             cargo workspace (pcv-wasmは含まない)
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

この4つが崩れると Web 版が出せなくなるか、実装が追えなくなる。

1. **`pcv-core` は Tauri を知らない。** `tauri` への依存を足さない。ここが wasm で動く
   ことが、Web 版のバックエンドを成立させる条件。wasm-bindgen/web-sys等の
   wasm固有の依存も`pcv-core`には入れず、`crates/pcv-wasm`（ADR-0012）に閉じる。
2. **Tauri の API を import してよいのは `src/datasource/tauri.ts` だけ。**
   他のファイルは `DataSource` インターフェースしか見ない。Web 版は
   `src/datasource/web.ts`（`WebSource`）がこれを実装する（ADR-0012）。
3. **`src/renderer/` は React を知らない。** canvas と `DataSource` だけを受け取る。
   逆に `src/ui/` はレンダラを直接触らず、`src/state/` を経由する。
4. **大きいデータは `pcv://` カスタムプロトコルで運ぶ。`invoke` は制御メッセージ専用。**
   理由と実測値は ADR-0001 を参照。

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
  エンコードを持つ。**`src/renderer/` の中でも WebGPU の API を直接叩くのは
  このファイルだけ**にする。
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
| カラーマップ切替 | 実装済み（M2-2）: 色計算の純粋関数(`src/renderer/colormap.ts`、標高/強度は共通の青→緑→黄→赤ランプ(CloudCompare風)・分類はASPRS標準コード表)、`LayerPanel`の着色モード選択、`gpu-resources.ts`の頂点シェーダでの結線(RGB/標高/強度/分類の4モード)まで完了。RGB無しファイルでの標高への自動フォールバックあり。標高の正規化レンジはLASヘッダーの実データ範囲(`CloudInfo.min`/`max`、`src/renderer/scene-bounds.ts`)から取る(ノードのoctreeセル(立方体)を使うと標高が一色に潰れる実機不具合があったため分離した)。色のランプはTS側(`colormap.ts`)の制御点からWGSLを生成し(`rampToWgslFunction`)、食い違いを防いでいる。`sofi.copc.laz`/`autzen-classified.copc.laz`等での実際の見え方は所有者の実機待ち。[M2](./M2-shading-and-ui.md) M2-2参照 |
| WebGPU エラーの可視化 | 完了: `device.onuncapturederror`/`device.lost`の監視、初期化を`pushErrorScope`で区切っての箇所特定、画面への不透明なエラーバナー表示。EDL(M2-1)で「テスト・CIはすべて緑なのに画面は真っ黒になった」事故を受けて新設。[ADR-0011](./ADR-0011-gpu-error-visibility.md)参照 |
| `point-cloud-renderer.ts` の分割 | 完了: 1,055行あったファイルを`node-selection.ts`（ノード選択、純粋関数）・`gpu-resources.ts`（WebGPU API はここだけ）・`point-cloud-renderer.ts`（フレームループ・外部公開API）に分割。詳細は「守る規約」の下の`src/renderer/`の内部構成を参照。`selectNodesForFrame`の単体テストを新設。公開APIは変更なし（`src/state/useCopcViewer.ts`に差分無し）。typecheck/lint/vitest/build 確認済み。実際の画面描画が分割前と同じに見えるかは所有者の目視待ち |
| Web版（GitHub Pages） | 実装済み: `crates/pcv-wasm`が`pcv-core`をwasm-bindgenで包み、Web Worker（`src/datasource/copc.worker.ts`）内の同期I/O（`FileReaderSync`/同期XHR）で`Read + Seek`を実装。`WebSource`が`DataSource`を実装し、`useCopcViewer.ts`が実行環境（Tauri/ブラウザ）で`TauriSource`/`WebSource`を切り替える。並列化はまずWorker1本（複数化は必要が見えてから）。`.github/workflows/pages.yml`でCI上にwasmビルド・静的ビルドを追加済み。`sofi.copc.laz`（2.03GB）を実際にブラウザで開く確認は未実施。[ADR-0012](./ADR-0012-web-worker-sync-io.md)参照 |
