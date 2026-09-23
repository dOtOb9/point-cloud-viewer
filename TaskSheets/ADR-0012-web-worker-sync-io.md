# ADR-0012: Web版はWeb Worker + 同期I/Oでpcv-coreを動かす

- 状態: 採択
- 日付: 2026-09-23
- 前提: [ADR-0001](./ADR-0001-architecture.md)（Tauriを1ファイルに閉じ込めた理由の一つが
  Web版を出せる余地を残すこと）、[ADR-0003](./ADR-0003-copc-crate.md)（COPCリーダーの選定、
  `Read + Seek`ジェネリックな読み方ができること）、[ARCHITECTURE.md](./ARCHITECTURE.md)
  規約1・規約2

## 決定

Web版のCOPC読込は次の3層で構成する。

1. **`crates/pcv-wasm`（新設）** — `pcv-core`をwasm-bindgenで包む層。wasm固有の依存
   （wasm-bindgen/js-sys/web-sys）はここに閉じ込め、`pcv-core`自体には持ち込まない。
   `FileReaderSync`（ローカルファイルの範囲読み）と同期`XMLHttpRequest`（URLのHTTP
   Range読み）の2種類の`Read + Seek`実装を持ち、どちらも`pcv_core::CopcFile<R>`に
   そのまま渡す。
2. **Web Worker（`src/datasource/copc.worker.ts`）** — `pcv-wasm`をロードし、実際の
   COPC読込はすべてこの中で行う。`FileReaderSync`と同期XHRはどちらも**Web Worker
   専用のAPI**（メインスレッドには無いか、非推奨かつUIをブロックする）なので、
   Workerの中でなければ動かせない。
3. **`WebSource`（`src/datasource/web.ts`）** — `DataSource`インターフェースの
   Web版実装。Workerとメインスレッドの間をメッセージ（`src/datasource/web-protocol.ts`）
   で仲介する。

`pcv-core`側は、既存の`CopcFile`を`R: Read + Seek + Send`に対する
ジェネリック型にした（既定型引数`BufReader<File>`で、ネイティブ経路である
`src-tauri`のコードは無変更で動く）。Web版はこの型引数に`pcv-wasm`の
`FileRangeReader`/`HttpRangeReader`を渡す。**ネイティブとWebは同じ`CopcFile`の
コードを共有し、違うのは`R`の実装だけ**という形にした。

並列化はTauri版（ADR-0007、`CopcFile`をプールして複数スレッドで並行読み出し）と違い、
**Web版はまずWorker1本で動かす**。複数Workerでの並列化は、実際にボトルネックが
見えてから検討する（Tauri版もADR-0007で「まず測ってから決める」という失敗を
一度しているため、同じ轍を踏まないよう先に測る）。

## 背景・問題

`pcv-core`の`CopcFile`は、`copc-reader`の`CopcReader<R: Read + Seek + Send>`の上に
建っている。`Read + Seek`は**同期**トレイトで、「今すぐこのバイト範囲をブロッキングで
読んで返せ」という契約になっている。一方でブラウザのファイルAPI（`File.arrayBuffer()`
やメインスレッドの`FileReader`）とネットワークAPI（`fetch`）は、メインスレッドでは
**すべて非同期**である。同期の`Read + Seek`をそのまま非同期APIの上に実装することは
できない（`.await`できる場所が`read()`の中に無い）。

かといって、ファイル全体を一度メモリに読んでから`std::io::Cursor`で包めば同期化
できるが、これは`TaskSheets/TEST-DATA.md`の`sofi.copc.laz`（2.03GB）のようなファイルで
破綻する。COPC + LODアーキテクチャ全体の主張（ADR-0001「開く時間とメモリ使用量は
ファイルサイズに依存しない」）を、Web版だけが裏切ることになる。

## 検討した選択肢

### 採った案: Web Workerの中でだけ使える同期I/O

`FileReaderSync`（`File`/`Blob`の同期読み込み）と、`async: false`を渡した
`XMLHttpRequest`（同期HTTPリクエスト、Rangeヘッダ対応）は、どちらも**Web Worker
専用**のAPIとして仕様に定義されている（前者はメインスレッドに存在しない。後者は
メインスレッドでも動くが非推奨かつUIスレッドをブロックする）。これらをWorkerの中で
使えば、`Read + Seek`を素直に実装でき、`pcv-core`側のコードを一切変えずに済む。

代償は、範囲読みのたびに同期XHR/`FileReaderSync`の呼び出しがWorkerのイベントループを
ブロックすることだが、Workerはメインスレッド（UI）とは別スレッドなので、ブロックの
影響はそのWorker自身のメッセージ処理が遅れることだけに留まる。

### 却下: ファイル全体をメモリに読む

実装は最も簡単（`ArrayBuffer`を1回読んで`Cursor`で包むだけ）だが、`sofi.copc.laz`
（2.03GB）で確実に破綻する。ブラウザタブのメモリ上限（デバイス・ブラウザに依存するが
数百MB〜数GB程度）に加え、`ArrayBuffer.slice`や構造化クローンのコピーが重なると
実効の上限はさらに下がる。「ファイルがどれだけ大きくても開く時間とメモリは一定」という
COPCアーキテクチャそのものの主張を、Web版だけ捨てることになるため却下した。

### 却下: `copc-reader`を非同期に書き直す（`async fn read`/`AsyncRead`）

`Read + Seek`を`AsyncRead + AsyncSeek`に置き換えれば、メインスレッドの`fetch`や
`File.arrayBuffer()`をそのまま使え、Workerも不要になる。しかし:

- `copc-reader`（`vendor/copc-reader`、ADR-0003で1箇所パッチ済み）の内部実装
  （LAZチャンクの伸長、hierarchyページの走査）が同期`Read + Seek`を前提に書かれて
  おり、非同期化は上流のアルゴリズム部分まで踏み込んだ書き直しになる。
  ADR-0003で選定したクレートを選び直すのと同等以上のコストがかかる。
- ネイティブ版（`src-tauri`）は同期`Read + Seek`のままで困っていない
  （ADR-0007で並行性の問題はスレッドプール側で解決済み）。非同期化するメリットが
  Web版のためだけのものになり、ネイティブ側にも影響する変更を正当化しづらい。
- Rustの非同期エコシステム（`tokio`等）はwasm32-unknown-unknown上では制約が多く
  （タイマー・スレッド前提のAPIが使えない）、`AsyncRead`トレイト自体の選定
  （`futures`か`tokio`か独自か）で新たな依存関係の検討が発生する。

「Workerの中でだけ同期I/Oを使う」ほうが、`pcv-core`のアルゴリズム部分を一切変えずに
済み、変更範囲が`pcv-wasm`という新規クレート1つに閉じる。

### 却下: メインスレッドで`fetch`し、結果をpostMessageでWorkerに渡す

同期XHRの代わりにメインスレッドの`fetch`（非同期）でバイト列を取得し、Workerには
読み終えたバイト列だけを渡す案。CORSの都合はfetchでも同期XHRでも変わらないが、
`Read + Seek`の`read()`が呼ばれるたびにメインスレッドとWorkerの間を1往復
（postMessageのラウンドトリップ）することになり、同期I/Oが要求する「今すぐ返す」
という契約と噛み合わない（`read()`の中で`postMessage`の応答を待つことはできない）。
結局Worker側でブロッキング待機の仕組みを自作することになり、素直に同期XHRを
Worker内で直接呼ぶより複雑になる。

## 実装の要点

- `crates/pcv-core/src/copc.rs`: `CopcFile<R: Read + Seek + Send = BufReader<File>>`
  にジェネリック化。`open(path)`（既定の`R`、ネイティブ用）と`from_reader(reader)`
  （任意の`R`、Web版用）の2つのコンストラクタを持つ。既定型引数のおかげで
  `src-tauri`側は無変更。
- `crates/pcv-wasm/src/file_reader.rs`: `FileRangeReader`。`File.slice(start, end)`で
  範囲を切り出してから`FileReaderSync`で読む。**ファイル全体を読まない**ことの
  裏付けとして、実際に読んだバイト数を`Stats`（`Rc<Cell<u64>>`）に積算し、
  `WasmCopcFile::bytesRead()`/`totalSize()`から取り出せる。
- `crates/pcv-wasm/src/http_reader.rs`: `HttpRangeReader`。コンストラクタで
  `bytes=0-0`のRangeリクエストを送り、`Content-Range`レスポンスヘッダから
  ファイル全体のサイズを得る。以降の`read()`は`Range: bytes=<start>-<end>`付きの
  同期XHRで、`status`が206（Partial Content）であることを確認する
  （200が返る＝サーバーがRangeを無視して全体を返した場合はエラーにする。
  黙って全体取得にフォールバックすると、この節の前提が崩れる）。
- どちらも`unsafe impl Send`を書いている。理由はコード中のコメント参照:
  wasm32-unknown-unknownはatomics無効時はシングルスレッドで、`web_sys`の型
  （内部は`JsValue`）を実際に複数スレッドで共有することは無い。`pcv_core::CopcFile<R>`
  が`R: Send`を要求するのは、ネイティブ版がスレッドプールでリーダーを共有する設計
  （ADR-0007）と型を揃えているためで、Web版では実質的に形式要件でしかない。
- `crates/pcv-wasm/src/range_math.rs`: 範囲読みのバイト位置計算（`clamp_range`等）を
  Web APIから切り離した純粋関数にしてあり、ネイティブターゲットで`cargo test`できる。
- 2つの入力源（ファイル/URL）は`Box<dyn ReadSeek>`（`ReadSeek: Read + Seek + Send`）で
  型消去し、`WasmCopcFile`という1つのwasm-bindgen型にまとめている。

## 分かっている制約

- **URLを開くにはサーバーがCORSとHTTP Rangeの両方に対応している必要がある。**
  対応していない場合、`HttpRangeReader::new`が最初のRangeプローブの時点で
  エラーになる（黙って全体取得にフォールバックしない）。CORSは単純ヘッダでは
  済まない（`Range`ヘッダを送るとpreflightが必要）ため、`Access-Control-Allow-Headers`
  に`Range`（または`*`）が含まれている必要もある。
  `https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz`
  （`TaskSheets/TEST-DATA.md`のautzen）で実際に確認した:
  ```bash
  curl -sI -H "Origin: https://example.com" -H "Range: bytes=0-1" <URL>
  # => Access-Control-Allow-Origin: *, Accept-Ranges: bytes, 206 Partial Content
  curl -sI -X OPTIONS -H "Origin: https://example.com" \
    -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" <URL>
  # => Access-Control-Allow-Headers: range
  ```
  `sofi.copc.laz`（`hobu-lidar`バケットの別ファイル、2.03GB）も同じバケットなので
  同じCORS設定のはずだが、**実際にブラウザから2.03GBを開く動作は確認していない**
  （後述「未確認の項目」）。
- **ブラウザはWebGPUに対応している必要がある**（ADR-0002。WebGL2フォールバックは
  無い方針のまま、Web版もこれを引き継ぐ）。
- Web版は**Worker1本**。Tauri版のようなリーダープールによる並列読み出し
  （ADR-0007）は無い。複数ノードの読み出しは1本のWorkerの中で順番に処理される。
- `pcv-wasm`はルートのCargoワークスペースに入れていない（`crates/pcv-wasm`は
  ルート`Cargo.toml`の`exclude`、かつ自身に空の`[workspace]`を持つ独立した
  1クレートのワークスペース）。wasm-bindgen/web-sys系の依存をネイティブの
  `cargo test --workspace`/`cargo clippy --workspace`（`ci.yml`の`rust`ジョブ、
  windows-latest）に巻き込まないため。ビルドは
  `cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown`
  のように明示的な`--manifest-path`で行う。同じ理由で`[patch.crates-io]`
  （`vendor/copc-reader`、ADR-0003参照）もルートとは別に`crates/pcv-wasm/Cargo.toml`
  に持たせている。忘れると、Web版だけ「大きいCOPCファイルが開けない」という
  ADR-0003で一度踏んだ罠に再び落ちる。
- wasm-bindgenが生成するJSグルー・`.wasm`本体（`src/wasm/pcv-wasm/`）は
  **コミットしてある**。既存の`ci.yml`（`frontend`/`build`ジョブ）はRustのwasm32
  ターゲットや`wasm-bindgen-cli`を前提にしておらず、`npm run typecheck`/
  `npm run build`（`tsc && vite build`）や、それを内部で呼ぶ`npm run tauri build`
  がこの生成物を素朴にimportできる必要がある。新設した`.github/workflows/pages.yml`
  は実際にRustソースからビルドし直してこのコミット済みの生成物を上書きするので、
  「コミット済みの生成物が古くて実体と食い違う」という事故はデプロイのたびに
  検出できる（ビルドし直した内容がそのままPagesへ配信される）。ローカルで
  Rust側を変更した場合は`npm run build:wasm`（`package.json`）で再生成すること。

## 所有者の確認手順

1. リポジトリ設定 → Settings → Pages → "Build and deployment" の Source を
   **"GitHub Actions"** にする（1回だけ。これをしないと`pages.yml`が成功しても
   実際には公開されない）。
2. `main`にpushすると`.github/workflows/pages.yml`が走り、成功すれば
   `https://<GitHubユーザー名>.github.io/point-cloud-viewer/` で開けるはず
   （実際のURLは`deploy`ジョブの出力（`steps.deployment.outputs.page_url`）を
   Actionsの実行結果から確認できる）。
3. ブラウザ（WebGPU対応: 最近のChrome/Edge等）で開き、devtoolsのconsoleに
   赤いエラーが出ていないことを確認する。
4. LayerPanelの「サンプル(autzen)を開く」ボタン、または`<input type="file">`で
   手元の`.copc.laz`を選んで、点群が表示されることを確認する。
5. devtoolsのNetworkタブで、ローカルファイル選択時は追加のネットワークリクエストが
   飛ばないこと、URL指定時は`Range`ヘッダ付きの206レスポンスが**ファイルサイズより
   ずっと少ない回数・バイト数**だけ発生していることを確認する（全体を1回で
   取得していないことの直接証拠）。

## 未確認の項目（実際に試せていない）

- **`sofi.copc.laz`（2.03GB）を実際にブラウザから開けるかは未確認。** 設計上は
  範囲読みなので開けるはずだが、確かめていないことを「確認した」と書かないという
  約束のとおり、ここは「設計上は可能・未確認」のまま報告する。ブラウザタブの
  メモリ上限に対する余裕、大きいhierarchy（sofiは13,163ノード）をJSONへ変換して
  Worker→メインスレッドへ渡すコストなどは実測していない。
- 実際のブラウザでの動作確認（Worker起動、`FileReaderSync`/同期XHRの実際の挙動、
  画面への描画）はGUIを目視できない環境で作業したため行っていない。
  `npm run build`でのバンドル成功、`npm test`でのユニットテスト、および
  `curl`によるCORS/Rangeの応答確認までは行った。
- GitHub Pagesへの実際のデプロイ・公開URLでの動作確認は、`main`へのpush後に
  Actionsの実行結果を所有者に確認してもらう必要がある。
- 複数Workerによる並列化が実際に必要になるかどうか（ノード読み込みが体感で
  遅いかどうか）は、実機・実データでの確認待ち。
