# M0: 前提の確定

- 状態: 完了
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

- [x] `npm run tauri dev` でウィンドウが開き、Tailwind のスタイルが効いている
      （ウィンドウを目視できない環境で実装したため、プロセスがクラッシュせず起動すること・
      `vite build` が Tailwind 由来の CSS を生成すること・後続のM0-2/M0-3で同じ画面上の
      React コンポーネントが正しく動作していることまでを間接的な根拠として確認した。
      実際に色/フォントが期待通り出ているかは所有者の目視確認が必要）
- [x] `cargo build` が workspace 全体で通る
- [x] `crates/pcv-core/Cargo.toml` に `tauri` が無い（wasm32-unknown-unknown ターゲットでも
      ビルドできることを確認済み）

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

- [x] 上の表のどれに該当するかが確定し、下の「結果」節に記録されている
- [x] 採用する API（WebGPU / WebGL2）で、三角形1枚またはピクセル1点が canvas に描画される
      （`report_diagnostic` 経由の stdout ログで `drawnWith=webgpu` を確認。canvas の見た目
      そのものは所有者の目視確認が必要）
- [x] `ADR-0002-rendering-api.md` を起こし、決定と根拠を記録した

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

- [x] カスタムプロトコルと `invoke` のスループットが数値で並んでいる
- [x] カスタムプロトコルが `invoke` より有意に速いことを確認した
      （差は明確にあったため ADR-0001 の見直しは不要だった）
- [x] `DataSource` インターフェースの最初の形が `src/datasource/DataSource.ts` に存在する
      （`TauriSource` が実装。`src/datasource/tauri.ts`）

### 自分で確かめる手順

```bash
npm run tauri dev     # ベンチ画面で計測ボタンを押し、数値が出ること
```

### 結果

- 日付: 2026-09-22
- 環境: `npm run tauri dev`（devURL 経由、dev/debugビルド。`cargo build --release` の
  最適化ビルドではない点に注意）
- 計測方法: `src/state/useIpcBench.ts` が起動時に自動計測し、`console.log` と
  `report_diagnostic` コマンド経由で Rust 側 stdout に出力する

| method | size | time | throughput |
|---|---|---|---|
| pcv:// | 1MiB | 24.3ms | 41.2MB/s |
| pcv:// | 10MiB | 113.4ms | 88.2MB/s |
| pcv:// | 100MiB | 1079.3ms | 92.7MB/s |
| invoke | 1MiB | 782.1ms | 1.3MB/s |
| invoke | 10MiB | 7827.8ms | 1.3MB/s |
| invoke | 100MiB | 9771.1ms | 10.2MB/s |

`npm run tauri dev` の標準出力の実測行:

```
[frontend] [M0-3] IPC bench: pcv:// 1MiB: 24.3ms 41.2MB/s | pcv:// 10MiB: 113.4ms 88.2MB/s | pcv:// 100MiB: 1079.3ms 92.7MB/s | invoke 1MiB: 782.1ms 1.3MB/s | invoke 10MiB: 7827.8ms 1.3MB/s | invoke 100MiB: 9771.1ms 10.2MB/s
```

**結論: カスタムプロトコルが `invoke` より有意に速いことを確認した**（サイズによるが約8倍〜60倍）。
ADR-0001 の「`invoke` を制御メッセージ専用にし、ノードデータは `pcv://` で運ぶ」という判断を
実測で裏付けた。ADR-0001 の見直しは不要。

留意点:
- 数値は dev/debugビルドでの計測であり、`tauri build`（release）とは絶対値が異なりうる。
  ただし相対的な差（pcv:// が有意に速い）は序盤の実装段階から明確だった。
- `invoke` の初回呼び出し時、devtoolsに
  `IPC custom protocol failed, Tauri will now use the postMessage interface instead` という
  警告が出ることがある。これは Tauri 自身の invoke 実装が内部で使う独自プロトコルが
  devURL（Vite dev server）環境で failed し、`postMessage` にフォールバックするという
  Tauri 側の既知の挙動で、今回追加した `pcv://` ベンチ用プロトコルとは別物。invoke の
  数値がサイズに対して非単調（10MiBより100MiBの方が高スループット）なのはこのフォール
  バック経路の影響を受けている可能性がある。相対比較の結論には影響しない。
- 100MB× invoke はタイムアウト（60秒）以内に完了したが、10秒近くかかっており、実運用の
  LODストリーミングには到底耐えない値。

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

- [x] push で CI が走り、全ジョブが緑
      （2026-09-22 に public リポジトリ https://github.com/dOtOb9/point-cloud-viewer へ push し、
      run 35721042805 で frontend 13s / rust 5m30s / build 7m36s の3ジョブすべて success を確認）
- [x] わざと `clippy` 警告を入れると CI が落ちることを確認した（**ザルでないことの確認**）
      （ローカルで `&Vec<i32>` 引数を追加し `cargo clippy -- -D warnings` が
      `clippy::ptr_arg` で失敗することを確認してから元に戻した。GitHub Actions 上での
      再現はpush不可のため未検証）

### 自分で確かめる手順

```bash
gh run list --limit 3
gh run view --log-failed   # 落ちたとき
```

### コミット単位

`ci: add rust and typescript checks`

---

## M0 完了の定義

- [x] M0-1 〜 M0-4 がすべて完了している
- [x] 描画 API（WebGPU か WebGL2 か）が確定し、ADR-0002 に記録されている
- [x] IPC 方式の判断が実測値で裏付けられている
- [x] `ARCHITECTURE.md` の「現在の状態」表が更新されている

ここまで終われば、M1（COPC 読込 → octree LOD → 点予算 → EDL → カラーマップ）の設計が
揺れない状態になる。
