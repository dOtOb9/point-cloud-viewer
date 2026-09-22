# M0: 前提の確定

- 状態: 未着手
- 前提: [ADR-0001](./ADR-0001-architecture.md)

## このマイルストーンの目的

ADR-0001 で **2つのリスクを引き受けた**。M0 はそれを実測で潰すためだけに存在する。
点群機能は一切作らない。

1. WebView2 で WebGPU が使えるか（使えなければ WebGL2 に確定させる）
2. `pcv://` カスタムプロトコルのスループットが LOD ストリーミングに耐えるか

**これを先に潰す理由:** どちらも、M1 を作り込んだ後に判明すると描画層の書き直しになる。
逆にここさえ確定すれば、以降の設計が揺れない。

---

## M0-1: リポジトリ雛形が起動する

### やること

Tauri v2 + React + TypeScript + Tailwind + Vite の最小構成を立ち上げ、
`ARCHITECTURE.md` のディレクトリ構成を実際に作る。

- cargo workspace（`crates/pcv-core`, `src-tauri`）
- `crates/pcv-core` は空でよいが、**`tauri` に依存していない**ことを構成として示す
- フロントは `src/{datasource,renderer,state,ui}` の空ディレクトリを切る
- ウィンドウに「Hello」と、`<canvas>` を1枚出すだけ

### 受け入れ条件

- [ ] `npm run tauri dev` でウィンドウが開き、Tailwind のスタイルが効いている
- [ ] `cargo build` が workspace 全体で通る
- [ ] `crates/pcv-core/Cargo.toml` に `tauri` が無い

### 自分で確かめる手順

```bash
npm install
npm run tauri dev     # ウィンドウが開き、Tailwind のスタイルが当たっていること
cargo build           # workspace 全体が通ること
```

### コミット単位

`chore: scaffold tauri v2 + react + tailwind workspace`

---

## M0-2: WebGPU が使えるかを確定させる

### やること

WebView2 上で WebGPU が取得できるかを実測する。**これが M0 の主目的。**

1. `navigator.gpu` の有無、`requestAdapter()` の成否、取れたアダプタの情報を画面に出す
2. 取れなかった場合、`tauri.conf.json` の `additionalBrowserArguments` に
   `--enable-unsafe-webgpu` / `--enable-features=Vulkan` 等を渡して再試行する
3. 結果を**このファイルの「結果」節に書き戻す**（後から理由を追えるようにするため）

### 判断

| 結果 | 決定 |
|---|---|
| WebGPU が素で使える | WebGPU を採用。compute shader による GPU カリングを設計に入れる |
| フラグ付きで使える | 要判断。ユーザ環境で壊れうるため、WebGL2 フォールバックを必ず併設する |
| 使えない | **WebGL2 に確定**。Potree は WebGL2 のみで数十億点を捌いているので死因にならない。CPU カリングに切り替える |

### 受け入れ条件

- [ ] 上の表のどれに該当するかが確定し、下の「結果」節に記録されている
- [ ] 採用する API（WebGPU / WebGL2）で、三角形1枚またはピクセル1点が canvas に描画される
- [ ] `ADR-0002-rendering-api.md` を起こし、決定と根拠を記録した

### 自分で確かめる手順

```bash
npm run tauri dev     # 画面にアダプタ情報か「WebGPU 非対応」が表示される
```

### 結果

- 日付: 2026-09-22
- OS: Windows 11 Home 10.0.26200 (build 26200)
- WebView2 Runtime: 153.0.4234.48
- GPU: NVIDIA GeForce RTX 4070（ドライバ 32.0.15.9186）
- `"gpu" in navigator`: true
- `requestAdapter()`: 成功。フラグなし（`additionalBrowserArguments` は未使用）
- adapter.info: vendor="nvidia", architecture="lovelace"（device / description は空文字で返ってきた）
- 三角形描画: 成功（`drawnWith=webgpu`）
- 試したフラグ: なし（素の状態で動作したため追加不要だった）
- 判断表での該当区分: 「WebGPU が素で使える」
- 最終決定: **WebGPU を採用**（WebGL2 フォールバックは実装しない）。詳細と根拠は
  [ADR-0002](./ADR-0002-rendering-api.md) を参照。

実測は `npm run tauri dev` の標準出力で確認した（`src/state/useWebGpuProbe.ts` が
`report_diagnostic` コマンド経由で Rust 側 stdout にも出力する）:

```
[frontend] [M0-2] WebGPU supported: vendor="nvidia" architecture="lovelace" device="(unknown)" description="(unknown)" drawnWith=webgpu
```

検証は開発機1台のみ。古いGPU/ドライバでの挙動は未検証（ADR-0002の留意点を参照）。

### コミット単位

`feat: add webgpu capability probe` / `docs: record rendering api decision (ADR-0002)`

---

## M0-3: `pcv://` カスタムプロトコルのスループットを計測する

### やること

ADR-0001 で「`invoke` は Windows で約 50MB/s のボトルネックになるのでカスタムプロトコルを
使う」と決めた。**この前提を自分の環境で裏付ける。**

1. `src-tauri` に `pcv://bench/<size>` を実装し、指定サイズのバイナリを返す
2. フロントから 1MB / 10MB / 100MB を取得し、所要時間と実効スループットを測る
3. 比較のため同じデータを `invoke` でも取得し、両者を並べる
4. 結果を下の「結果」節に書き戻す

### 受け入れ条件

- [ ] カスタムプロトコルと `invoke` のスループットが数値で並んでいる
- [ ] カスタムプロトコルが `invoke` より有意に速いことを確認した
      （もし差が無ければ ADR-0001 の当該判断を見直し、ADR に追記する）
- [ ] `DataSource` インターフェースの最初の形が `src/datasource/` に存在する

### 自分で確かめる手順

```bash
npm run tauri dev     # ベンチ画面で計測ボタンを押し、数値が出ること
```

### 結果

> サイズごとの所要時間と MB/s を、カスタムプロトコル / invoke の両方について記録する。

（未計測）

### コミット単位

`feat: add pcv:// custom protocol` / `test: add ipc throughput benchmark`

---

## M0-4: CI を通す

### やること

GitHub Actions で、push ごとに壊れていないことを確認する。
**ループを回す土台なので M0 のうちに入れる。**

- Rust: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`
- TypeScript: `tsc --noEmit`, `eslint`
- ビルド: `tauri build`（Windows）が通ること
- キャッシュ: `Swatinem/rust-cache` と npm キャッシュを入れる（Rust のコールドビルドは長い）

### 受け入れ条件

- [ ] push で CI が走り、全ジョブが緑
- [ ] わざと `clippy` 警告を入れると CI が落ちることを確認した（**ザルでないことの確認**）

### 自分で確かめる手順

```bash
gh run list --limit 3
gh run view --log-failed   # 落ちたとき
```

### コミット単位

`ci: add rust and typescript checks`

---

## M0 完了の定義

- [ ] M0-1 〜 M0-4 がすべて完了している
- [ ] 描画 API（WebGPU か WebGL2 か）が確定し、ADR-0002 に記録されている
- [ ] IPC 方式の判断が実測値で裏付けられている
- [ ] `ARCHITECTURE.md` の「現在の状態」表が更新されている

ここまで終われば、M1（COPC 読込 → octree LOD → 点予算 → EDL → カラーマップ）の設計が
揺れない状態になる。
