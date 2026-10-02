# 規約1〜4

[`TaskSheets/ARCHITECTURE.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ARCHITECTURE.md)
はこう書いています。

> この4つが崩れると Web 版が出せなくなるか、実装が追えなくなる。

4つとも「崩れても普通のビルドは通ってしまう」種類の約束です。だからこそ明文化され、
うち2つは CI の `invariants` ジョブ（[`.github/workflows/ci.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/ci.yml)）で機械的に検査されています。

## 規約1: `pcv-core` は Tauri を知らない

`crates/pcv-core` は `tauri` に依存せず、`wasm32-unknown-unknown` ターゲットでビルドできます。

**なぜ**: Web 版のバックエンド（COPC の読み込み・octree 走査・座標変換）は、
`pcv-core` をそのまま wasm にコンパイルして成立させています（[pcv-wasm の章](./rust/pcv-wasm.md)）。
ここに Tauri や wasm 固有の依存（`wasm-bindgen`/`web-sys` など）が混ざると、
デスクトップ版はビルドできても Web 版が成立しなくなります。wasm 固有の依存は
`crates/pcv-wasm` 側に閉じ込め、`pcv-core` には持ち込みません。

**CI での検査**: `invariants` ジョブの「規約1」ステップ。

```yaml
- name: "規約1: pcv-core が wasm32 でビルドできる"
  run: cargo build -p pcv-core --target wasm32-unknown-unknown
```

さらに `.github/workflows/pages.yml` では、`crates/pcv-wasm` を実際にビルドし直して
Pages へ配信するため、規約1が壊れていれば Pages のデプロイ自体が失敗します。

## 規約2: Tauri の API を import してよいのは `src/datasource/tauri.ts` だけ

他のファイルは `DataSource` インターフェース（[`src/datasource/DataSource.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/datasource/DataSource.ts)）
しか見ません。Web 版は `src/datasource/web.ts`（`WebSource`）がこれを実装します。

**なぜ**: Tauri の API が他のファイルに散らばると、Web 版を出すときにそのファイルも
書き直す必要が生まれます。1ファイルに閉じ込めておけば、`WebSource` を差し替えるだけで
Web 版が成立します（[ADR-0001](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0001-architecture.md)）。

**CI での検査**: `invariants` ジョブの「規約2」ステップ。

```yaml
- name: "規約2: Tauri API の import が datasource に閉じている"
  run: |
    allowed="src/datasource/tauri.ts"
    found=$(grep -rl "@tauri-apps/api" src/ || true)
    if [ "$found" != "$allowed" ]; then
      exit 1
    fi
```

`@tauri-apps/plugin-dialog`（ファイル選択）・`@tauri-apps/plugin-opener`（更新通知で
リリースページを開く）も同様に `src/datasource/tauri.ts` と
`src/datasource/update-check.ts` に閉じていますが、この自動検査の対象は
`@tauri-apps/api` だけです（他プラグインへの違反は人のレビューに委ねられています）。

## 規約3: `src/renderer/` は React を知らない

`src/renderer/` 配下のコードは `<canvas>` と `DataSource` だけを受け取ります。
逆に `src/ui/` はレンダラを直接触らず、`src/state/` を経由します。

**なぜ**: レンダラを React から独立させておくことで、WebGPU を一切起動せずに
`vitest` でロジック（どのノードを描くか、点予算をどう調整するか等）を検証できます。
`src/renderer/` の内部はさらに3つに分かれています（[renderer の章](./frontend/renderer.md)参照）。

- `node-selection.ts` — どのノードを描くかの判定（純粋関数）
- `gpu-resources.ts` — WebGPU の API を直接叩くのはここだけ
- `point-cloud-renderer.ts` — フレームループ・カメラ・統計のオーケストレーション

**CI での検査**: 自動検査はありません。`src/renderer/*.ts` に `import "react"` や
`.tsx` ファイルが増えていないかは、レビューで保つ約束です。

## 規約4: 大きいデータは `pcv://` カスタムプロトコルで運ぶ

`invoke` は制御メッセージ（ファイルを開く、変換を始める、といった指示）専用です。
ノードのバイナリ（数百 KB〜数 MB）は `pcv://` カスタムプロトコルで運びます。

**なぜ**: [M0-3](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M0-feasibility.md) の実測で、`invoke` は Windows で `pcv://` の約1/8〜1/60 のスループット
しか出ないことを確認しています（100MiB で `invoke` は約10秒、`pcv://` は約1秒）。
LOD ストリーミングのように継続的にノードを流し込む用途では、この差が直接体感に出ます。

Web 版では `invoke` 自体が存在しないため、この規約は「大きいデータは
`postMessage` 1往復あたりを小さく保つ」という形で引き継がれています
（COPC のノードは1チャンクぶんだけを読む。変換の進捗も点数カウンタだけを送る）。

**CI での検査**: 自動検査はありません。新しい重いデータ経路を `invoke` で足していないかは
レビューで保つ約束です。

## まず読むファイル

- [`TaskSheets/ARCHITECTURE.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ARCHITECTURE.md) の「守る規約」節
- [`.github/workflows/ci.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/ci.yml) の `invariants` ジョブ
