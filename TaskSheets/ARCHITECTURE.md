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
│   └─ pcv-core/          COPC読込・octree走査・解析アルゴリズム
│                         → Tauri を知らない。wasm にもコンパイルできる
├─ src-tauri/             Tauri アプリの Rust 側
│                         → 薄く保つ。pcv:// の配信と制御コマンドだけ
├─ src/                   フロントエンド (TypeScript)
│   ├─ datasource/        DataSource 抽象と実装
│   ├─ renderer/          点群レンダラ (WebGPU。ADR-0002によりWebGL2フォールバックは無し)
│   ├─ state/             アプリ状態
│   └─ ui/                React コンポーネント
├─ Cargo.toml             cargo workspace
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
   ことが、Web 版のバックエンドを成立させる条件。
2. **Tauri の API を import してよいのは `src/datasource/tauri.ts` だけ。**
   他のファイルは `DataSource` インターフェースしか見ない。Web 版はここを `http.ts` に
   差し替えるだけで動く。
3. **`src/renderer/` は React を知らない。** canvas と `DataSource` だけを受け取る。
   逆に `src/ui/` はレンダラを直接触らず、`src/state/` を経由する。
4. **大きいデータは `pcv://` カスタムプロトコルで運ぶ。`invoke` は制御メッセージ専用。**
   理由と実測値は ADR-0001 を参照。

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
| EDL シェーディング | 実装済み（M2-1）、既定はオン: `src/renderer/edl.ts`。点群だけを描くオフスクリーンの色+深度テクスチャを新設し、`point-cloud-renderer.ts`の`drawFrame()`を2パス化(点群→オフスクリーン、空/グリッド+EDL合成→スワップチェーン)することで、EDLの陰影が空・グリッドに掛からないようにした。強さ・オン/オフをUIから調整可能。`sofi.copc.laz`での実際の見え方・fps実測は所有者の実機待ち。[M2](./M2-shading-and-ui.md) M2-1参照 |
| カラーマップ切替 | 未着手（M2 に送った） |
| WebGPU エラーの可視化 | 完了: `device.onuncapturederror`/`device.lost`の監視、初期化を`pushErrorScope`で区切っての箇所特定、画面への不透明なエラーバナー表示。EDL(M2-1)で「テスト・CIはすべて緑なのに画面は真っ黒になった」事故を受けて新設。[ADR-0011](./ADR-0011-gpu-error-visibility.md)参照 |
