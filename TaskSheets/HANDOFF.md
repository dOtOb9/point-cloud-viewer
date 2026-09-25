# 再開時の引き継ぎ

中断して時間をおいてから作業を再開するときに、最初に読むファイル。
「いま何がどこまで終わっていて、どこから読めば全体が分かり、次に何をすればいいか」を書く。
判断の理由や経緯は各 ADR・タスクシートにあるので、ここからは参照するだけにする。

**最終更新: 2026-09-25**（所有者がシステムを読み解く期間に入る前に更新）

---

## 1. 中断時点の状態

- **Release `v0.1.2`**: https://github.com/dOtOb9/point-cloud-viewer/releases/tag/v0.1.2
  （Windows の NSIS / MSI、Android の APK。最新版へのリンクは `.../releases/latest`）
- **Web 版（GitHub Pages）**: https://dotob9.github.io/point-cloud-viewer/
- 動いているエージェントは無い。作業ツリーに未コミットの変更は無い
- **週の使用量が残り少ない**（2026-09-25 時点で 87% を超えていた）。再開はリセットの後にする

ローカルで `npm run tauri dev` する前に `npm install` を実行すること（依存が増えている）。
`src-tauri/Cargo.toml` が改行コードだけ変わった状態になることがあるが、`tauri dev` が書き直すもので中身は同じ。
`git checkout -- src-tauri/Cargo.toml` で戻してよい。

---

## 2. システムを読み解く順番

### まず全体像

1. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — ディレクトリ構成、データの流れ、規約1〜4。**ここから読む**
2. **[ADR-0001](./ADR-0001-architecture.md)** — なぜ Tauri + React + WebGPU + COPC なのか。すべての前提
3. **[ROADMAP.md](./ROADMAP.md)** — マイルストーンの全体と、将来（DTM / TIN、断面線など）に要る土台

### 決定の記録（ADR）を番号順に

| ADR | 内容 | 一言で |
|---|---|---|
| [0002](./ADR-0002-rendering-api.md) | 描画 API | WebGPU のみ。WebGL2 には落とさない |
| [0003](./ADR-0003-copc-crate.md) | COPC を読むクレート | `copc-reader` を `vendor/` に取り込んで修正している |
| [0004](./ADR-0004-distribution-and-update.md) | 配布と更新 | GitHub Releases。**署名鍵は当面作らない** |
| [0005](./ADR-0005-ui-shell.md) | UI の骨組み | 全面ビューア＋浮いたパネル。ガラス面、設定だけ不透明 |
| [0006](./ADR-0006-conversion-strategy.md) | LAS/LAZ → COPC の変換 | `copc-writer` を採用。実測で決めた |
| [0007](./ADR-0007-pcv-protocol-concurrency.md) | `pcv://` と並列読み込み | 1ノードの読み方が遅かった話が一番の教訓 |
| [0008](./ADR-0008-formats-and-crs.md) | 形式と座標参照系 | PROJ を使わず横メルカトルを自前で |
| [0009](./ADR-0009-adaptive-render-settings.md) | 端末に合わせた描画設定 | 静的情報は初期値と上限だけ。実際はフレーム時間で |
| [0010](./ADR-0010-lod-priority-and-point-budget.md) | LOD の優先度と点予算 | 次元の誤り、vsync の取り違え、2つのラチェット |
| [0011](./ADR-0011-gpu-error-visibility.md) | WebGPU のエラーを画面に | 画面が真っ黒でもテストが緑だった事故から |
| [0012](./ADR-0012-web-worker-sync-io.md) | Web 版の読み込み | Worker の中で同期 I/O を使い `pcv-core` をそのまま動かす |
| [0013](./ADR-0013-crash-visibility.md) | Android で落ちたときの原因 | panic をエラーに変え、logcat に出す |

### コードの地図（データが流れる順）

| 場所 | 役割 | まず読むファイル |
|---|---|---|
| `crates/pcv-core/` | COPC の読み込み・ノード形式・座標変換。**wasm でも動く**（規約1） | `src/copc.rs`、`src/node_format.rs`、`src/crs/` |
| `vendor/copc-reader/` | 修正して使っている外部クレート | `PATCH.md`（何を直したか） |
| `crates/pcv-convert/` | LAS/LAZ → COPC の変換、E57/PLY/PCD の取り込み（デスクトップ・Android） | `src/streaming.rs`、`src/import/mod.rs` |
| `crates/pcv-wasm/` | Web 版で `pcv-core` を動かす wasm の層 | `src/lib.rs` |
| `src-tauri/src/` | デスクトップ・Android の裏側。`pcv://` でノードを返す、変換を走らせる | `copc_state.rs`、`conversion.rs`、`lib.rs` |
| `src/datasource/` | データの入口。Tauri 版と Web 版の違いはここに閉じ込める（規約2） | `DataSource.ts`、`tauri.ts`、`web.ts`、`copc.worker.ts` |
| `src/renderer/` | WebGPU の描画。React を知らない（規約3） | `point-cloud-renderer.ts`（全体のまとめ）→ `node-selection.ts`（どのノードを描くか）→ `gpu-resources.ts`（WebGPU） |
| `src/state/` | React とレンダラをつなぐ | `useCopcViewer.ts` |
| `src/ui/shell/` | 画面の部品 | `AppShell.tsx` |

**レンダラの中で特に読んでほしいもの**: `screen-space-error.ts`（どのノードを優先するか）、
`point-budget.ts`（点予算の自動調整）、`device-profile.ts`（モバイル判定と既定値）。
どれも純粋関数に切り出してあり、同じ名前の `.test.ts` を読むと振る舞いが分かる。

### 画面のどこに何があるか

- **左パネル**: ファイルを開く、点予算、背景、グリッド、着色モード
- **右パネル**: 点数、描画中のノード数、fps、カメラ
- **設定画面**: モバイル向けの最適化（レンダースケール、点の形、**EDL**、ガラス、点予算の上限）と、
  モバイル判定の結果。**EDL の切り替えはここ**にある（左パネルではない）
- **赤いバナー**: WebGPU のエラーと、ノード読み込みの失敗

---

## 3. 確かめてあること、まだのこと

### 所有者が画面・実機で確かめたもの

- デスクトップ: 描画、EDL（強度 0.05 に固定）、UI シェル、点予算の開始値、エラーバナーが出ないこと
- OPPO Pad Air: `v0.1.0` で `VK_ERROR_DEVICE_LOST`（GPU のハング）が起きることを確認。これを受けて `v0.1.1` を出した

### まだ画面・実機で確かめていないもの

| 何を | どこで | 関連 |
|---|---|---|
| **モバイル最適化で OPPO Pad Air が落ちなくなったか** | タブレット | M3-8。設定を1つずつ戻して、どれで落ちるかを見る手順がタスクシートにある |
| デバイスが失われたときの自動復帰 | タブレット | M3-8 |
| **生の LAS/LAZ の変換**（進捗・キャンセル・再変換しない・容量不足の警告） | デスクトップ・タブレット | M4-3 の節末「所有者が確かめる手順」 |
| 標高・強度の配色（青>緑>黄>赤） | デスクトップ | M2-2 |
| Web 版でサンプル（autzen）を開く | Chrome / Edge | ADR-0012 |
| エラーバナーが実際に出るところ | どこでも | ADR-0011 に意図的にエラーを起こす手順 |

---

## 4. 次の作業の入り口

- **M4-6 Web での変換**: `copc-writer` はそのままではブラウザで動かない（一時ファイルとメモリマップ）。
  OPFS を使う改修が要る。**まず実現できるかの調査（20万〜30万トークン程度）から**。ADR-0006 の追記参照
- **M4-5 の残り**: 画面での座標表示。計算は済んでいる
- **標高・強度の範囲を外れ値に強くする**: 今は最小〜最大で正規化しており、ノイズ1点で全体が一色に寄る
- **M3-7 / M3-8**: 実機で WebGPU を確定させ、閉ループで描画設定を自動で下げる仕組み
- **M2-4**: ガラス面・2パス構成の描画コストの計測
- UI のレイアウト（粗いと所有者のコメント）
- デスクトップの実行ファイルが `panic = "unwind"` とログのクレートで 4.3MB → 11.4MB に増えた。
  `env_logger` の既定の機能（正規表現）を外せば戻る見込み（ADR-0013）
- wasm-bindgen の生成物（約350KB）をコミットしている。いずれ CI でビルドする形に

---

## 5. 決めたこと

- **署名鍵は当面作らない**（ADR-0004 追記4）。Android はデバッグ鍵で署名しており、CI のキャッシュが
  7日使われないと鍵が変わる。そのときは古い版をアンインストールしてから入れる
- **Web 版は GitHub Pages**（ADR-0012）
- **言語は TypeScript のまま**。肥大化の実体は1ファイルへの同居だったので、レンダラを3つに割った
- **変換は `copc-writer`**（ADR-0006）。デスクトップ・Android は完了、Web は M4-6
- **配色は CloudCompare の既定（青>緑>黄>赤）**、**EDL の強度は 0.05**

---

## 6. 繰り返し踏んだ落とし穴

**一方向にしか動けず、回復経路を持たない設計**（3回）。ノードの読み方、点予算、リフレッシュ周期の推定。
新しく制御ループや推定を書くときは「この値は下がったあと戻れるか」を必ず確認する（ADR-0007、0010）。

**すべて緑なのに壊れている**（4回）。EDL の `depthStencil` 欠落で画面が真っ黒、インストーラ抜きの Release、
全点が紫の配色、レンダースケールがタブレットで効いていない。**緑は「確かめた」の代わりにならない。**

**測り方の誤り**（2回）。判断表の基準を 1億点に置いた（実データは数億点）。ピークメモリをワーキングセットで
測った（メモリマップしたファイルのページを含み、落ちるかどうかの指標にならない）。
**エージェントの計測値は再現しないことがある**（M4-1b の時間は2〜4倍ずれた）。判断に使う数値は再実行して確かめる。

---

## 7. 守り続けている制約

- 秘密鍵・キーストア・パスワード、点群データ（`*.laz`、`*.copc.laz`、`/data`）はコミットしない
- コミットの著者は GitHub の noreply アドレス
- 規約1〜4（ARCHITECTURE.md）は CI の `invariants` ジョブが検査する
- 実装は Sonnet に委譲し、計画・診断・検証を上位モデルが持つ
- 測っていないことを「実測した」と書かない
- エージェント用の worktree は `.claude/` にでき、git・vitest・eslint の対象外。
  **各 worktree に Rust のビルド結果（`target/`）が溜まり、数 GB になる。** 不要なら
  `git worktree list` で確かめてから `git worktree remove` で消してよい（どれも作業は push 済み）
