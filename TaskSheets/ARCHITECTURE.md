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
│   ├─ renderer/          点群レンダラ (WebGPU / WebGL2)
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
  │  src-tauri    │  pcv://node/<key> でノードのバイナリを配信
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
| COPC 読込 | 完了（M1-1）: `copc-core`/`copc-reader`採用。[ADR-0003](./ADR-0003-copc-crate.md) 参照 |
| octree LOD / 点予算 | 未着手（M1-4）: [M1](./M1-point-rendering.md) |
| EDL シェーディング | 未着手（M2 に送った） |
| カラーマップ切替 | 未着手（M2 に送った） |
