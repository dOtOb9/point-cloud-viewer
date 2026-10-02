# 全体像

## 一行でいうと

**Tauri v2 の殻の中で、React + Tailwind の UI と TypeScript の WebGPU レンダラが動き、
重い処理（COPC 読み込み・octree 走査・座標変換・形式変換）は Rust が担う。**

この構成を選んだ理由は [ADR-0001](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0001-architecture.md) にあります。
要点だけ書くと、3D ビューはこのアプリの一部分であり、属性テーブルや計測、断面図のような
UI の比重が大きい**解析ツール**だと判断したため、ゲームエンジン（Bevy）ではなく
Tauri + React を選びました。

## 3つの形態

同じコードベースから、3つの形で動きます。

| 形態 | 殻 | COPC を読む場所 | 変換 |
|---|---|---|---|
| デスクトップ（Windows） | Tauri（ネイティブ） | `pcv-core`（ネイティブ） | `pcv-convert` + `copc-writer`（別スレッド） |
| Android | Tauri（ネイティブ、WebView） | `pcv-core`（ネイティブ） | 同上（`content://` 経由） |
| Web（GitHub Pages） | ブラウザ | `pcv-core`（wasm、Web Worker 内） | `pcv-wasm` + `copc-writer`（Worker 内、OPFS） |

`pcv-core`（COPC の読み込み・octree 走査・座標変換）は3形態すべてで**同じ Rust のコード**
が動きます。これが成立する条件は[規約1](./conventions.md)です。

## デスクトップ・Android（Tauri）

```
  COPCファイル(.copc.laz)
        │ mmap(デスクトップ) / tauri-plugin-fs 経由の File(Android, content://)
        ▼
  ┌───────────────┐
  │   pcv-core    │  octree走査・可視ノード判定・座標変換（Rust、ネイティブ）
  └───────┬───────┘
          │
  ┌───────▼───────┐
  │  src-tauri    │  pcv://<level-x-y-z> でノードのバイナリを配信
  │ (CopcPool)    │  複数のCopcFileをプールし並行読み出し(ADR-0007)
  └───────┬───────┘
          │ カスタムプロトコル(invokeではない。ADR-0001)
          ▼
  ┌───────────────┐      ┌──────────────┐
  │ TauriSource   │─────▶│   renderer   │──▶ <canvas>(WebGPU)
  │(DataSource実装)│      └──────────────┘
  └───────────────┘              ▲
          │                ┌─────┴──────┐
          └───────────────▶│ state / ui │  React + Tailwind
                            └────────────┘
```

生の LAS/LAZ を開いた場合は、上の図の手前に変換が挟まります。

```
  生LAS/LAZ
      │ std::fs::File (デスクトップ) / tauri-plugin-fs (Android, content://)
      ▼
┌──────────────────┐     ┌──────────────┐
│  pcv-convert      │────▶│ copc-writer  │ octree構築・LAZ圧縮・書き出し
│ (streaming.rs)    │     │ (vendor/)    │ 別スレッド、Arc<AtomicBool>でキャンセル
└──────────────────┘     └──────────────┘
      │ 進捗イベント(読み込み点数)
      ▼
  src-tauriがeventで通知 → LayerPanelが表示 → 完了後そのままCOPCとして開く
```

Android 特有の点は、ファイルの入手経路だけです。デスクトップは `std::fs::File::open`
で開けますが、Android の `content://` URI は `tauri-plugin-fs` 経由で得たファイル
ディスクリプタを `Read + Seek` として使います（詳細は
[src-tauri の章](./rust/tauri-backend.md)）。`pcv://` でのノード配信そのものは
どちらも同じコードです。

## Web（GitHub Pages）

Web 版にはサーバー側の処理がありません。`pcv-core` を wasm にコンパイルし、
Web Worker の中で動かします。

```
  COPCファイル                              URL(COPCを静的ホスティング)
   (ローカル選択)                                  │
      │ File                                        │ fetch (同期XHR, Range)
      ▼                                              ▼
┌─────────────────────────────────────────────────────────┐
│                      Web Worker                          │
│  copc.worker.ts ロード → pcv-wasm(wasm-bindgen) を初期化  │
│  FileRangeReader / HttpRangeReader (Read+Seek実装)        │
│         ↓                                                │
│  pcv-core (wasm) の WasmCopcFile が hierarchy・ノードを返す│
└───────────────────────┬───────────────────────────────────┘
                         │ postMessage (構造化クローン)
                         ▼
                  ┌───────────────┐      ┌──────────────┐
                  │  WebSource    │─────▶│   renderer   │──▶ <canvas>(WebGPU)
                  │(DataSource実装)│      └──────────────┘
                  └───────────────┘              ▲
                         │                  ┌─────┴──────┐
                         └─────────────────▶│ state / ui │
                                             └────────────┘
```

`FileReaderSync` と同期 `XMLHttpRequest` はどちらも**Web Worker 専用の API**で、
メインスレッドには無いか使うべきではないため、COPC の読み込みはすべて Worker の中で
行います（[ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md)）。
並列化は今のところ Worker 1本です。

生の LAS/LAZ を Web で開いた場合は、同じ Worker の中で変換も行います。
一時ファイルの置き場所は OPFS（Origin Private File System）で、`copc-writer` を
`ScratchFs` トレイト越しに改修して差し替えています（[vendor/copc-writer の章](./rust/copc-writer.md)）。

```
  生LAS/LAZ(File)
      │ FileRangeReader(BufReaderで包む)
      ▼
┌──────────────────┐     ┌──────────────┐      ┌─────────┐
│ WasmConverter     │────▶│ copc-writer  │─────▶│  OPFS   │ 一時ファイル
│ (feed: バッチ単位) │     │ (OpfsScratchFs)    └─────────┘
└──────────────────┘     └──────────────┘
      │ バッチの合間にWorkerのイベントループへ制御を返す(キャンセルを受け取るため)
      ▼
  変換完了 → OPFSから結果を読み、URL.createObjectURLでダウンロードを提示
```

## データが流れる単位

どの形態でも、Rust とフロントエンドの間を流れる重いデータは**ノード単位の
バイナリ**（ヘッダ32バイト + 点ごと20バイト、[データの流れの章](./data-flow.md)参照）
だけです。ファイルパスを開く・変換を始める、といった軽い指示は Tauri では
`invoke`、Web では `postMessage` のメッセージで送りますが、**点群そのもの（数百万点）
はここを通りません**。これが [ADR-0001](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0001-architecture.md) の実測（`invoke` は Windows で遅い）に基づく設計です。

## まず読むファイル

- [`TaskSheets/ARCHITECTURE.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ARCHITECTURE.md) — この章のもとになった、常に最新のディレクトリ構成図
- [`TaskSheets/ADR-0001-architecture.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0001-architecture.md) — なぜこの構成なのか、すべての前提
