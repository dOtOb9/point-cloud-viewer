# ADR-0002: 描画APIの選定（WebGPU / WebGL2）

- 状態: 採択
- 日付: 2026-09-22
- 前提: [ADR-0001](./ADR-0001-architecture.md)、[M0-feasibility.md](./M0-feasibility.md) の M0-2

## 決定

点群レンダラの描画APIとして **WebGPU を採用する**。WebGL2 へのフォールバックは
実装しない（現時点でフラグなしに動作しているため、フォールバックを維持するコストの方が
高いと判断した。壊れた場合は改めてこの ADR を見直す）。

## 背景

ADR-0001 で「WebView2 で WebGPU が使えるか未確定」というリスクを引き受けた。
M0-2 として、実機で `navigator.gpu` の有無と `requestAdapter()` の成否を計測した。

### 実測結果

| 項目 | 値 |
|---|---|
| 日付 | 2026-09-22 |
| OS | Windows 11 Home 10.0.26200 (build 26200) |
| WebView2 Runtime | 153.0.4234.48 |
| GPU | NVIDIA GeForce RTX 4070（ドライバ 32.0.15.9186） |
| `"gpu" in navigator` | true |
| `requestAdapter()` | 成功（フラグなし、素の状態で取得できた） |
| adapter.info | vendor="nvidia", architecture="lovelace" |
| 三角形描画 | 成功（`src/renderer/webgpu-probe.ts` の `drawWebGpuTriangle` が true を返した） |
| 試したフラグ | なし（素の状態で動作したため `additionalBrowserArguments` への追加は不要だった） |

計測方法: `src/state/useWebGpuProbe.ts` がマウント時にプローブを実行し、結果を
`console.log` と Rust 側 `report_diagnostic` コマンド（`src-tauri/src/lib.rs`）経由で
標準出力の両方に出力する。`npm run tauri dev` の標準出力に以下が実際に出力された。

```
[frontend] [M0-2] WebGPU supported: vendor="nvidia" architecture="lovelace" device="(unknown)" description="(unknown)" drawnWith=webgpu
```

M0-feasibility.md の判断表で言えば「WebGPU が素で使える」に該当する。

### 留意点

- `device` / `description` が `"(unknown)"` になっている。`GPUAdapterInfo` の該当フィールドが
  この WebView2 バージョンでは空文字で返ってきているためで、`vendor` / `architecture` は
  取得できている。プローブの動作そのものには影響しない。
- 計測は開発機（NVIDIA GPU、Windows 11 最新ビルド）1台のみで行った。**古い GPU ドライバや
  Intel/AMD 内蔵GPU、あるいは WebView2 Runtime が古い環境では未検証**。ユーザ環境で
  `requestAdapter()` が失敗するケースが実際に報告された場合は、その時点で WebGL2
  フォールバックの追加を検討する。

## 帰結

**得たもの**
- WebGPU の compute shader が使えるため、点群の可視ノード判定や GPUカリングを
  GPU側に寄せる設計を M1 以降で選べる（ADR-0001 が想定していた「WebGL2ならCPUカリング」
  を回避できる）。
- WebGL2 フォールバック実装・保守のコストを払わずに済む。

**払うもの / リスク**
- フォールバックが無いため、**WebGPU が使えないユーザ環境ではアプリが起動できない**。
  該当報告が来た場合、WebGL2 フォールバックを追加するかどうかを再度判断する必要がある。
- 検証環境が1台のみのため、ドライバ差・GPUベンダー差による未知の不具合が残っている
  可能性がある。

## 却下した案

| 案 | 却下理由 |
|---|---|
| WebGL2 に確定（フラグ探索をせず最初から） | 実測で WebGPU が素で動作したため、CPUカリングに後退する理由が無い |
| WebGPU + WebGL2 フォールバックを両方実装 | 現時点でフラグなしに動作しており、フォールバックを別実装として維持するコストに見合う根拠が無い。壊れたら追加する |
| `--enable-unsafe-webgpu` 等のフラグを先に試す | 素の状態で `requestAdapter()` が成功したため、フラグ付与自体が不要だった |
