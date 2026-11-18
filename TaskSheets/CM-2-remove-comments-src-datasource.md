# CM-2: コメントを消す（`src/datasource/`）

- 共通の決まり・例外・「なぜ」の移し方: [CM-0-no-comments.md](./CM-0-no-comments.md)（CM-0 が先に main に入っていること）
- 範囲: `src/datasource/`。範囲の外のファイルは触らない（並行して別の作業役が消している）
- 方針: 振る舞いは変えない。push しない

## 受け入れ基準

- **AC-1** 範囲のファイルについて `scripts/comment-baseline.json` の項目が無くなり（上限 0）、`npm run check:comments` が通る。例外（CM-0 の「例外」）だけが残る
- **AC-2** 消したコメントが、コードから読めない意図を持っていた所では、CM-0 の順（名前 → テストの名前 → このシートの「移した理由」）で移す。
  名前を変えたら使い手を全部直す（`grep` の数を作業報告に書く）。名前の変更と関数の切り出し以外の変更はしない（振る舞いを変えない）
- **AC-3** コメントだけの行を消した後に、空行が2行以上続く・ブロックの先頭が空行になる、などの跡を残さない（整形ツールが通る）
- **AC-4** `src/code-limits.test.ts` の BASELINE など、行数に依存する検査・文書（ADR-0024 などの `path:line` の参照）を、縮んだ行数に合わせて直す（`npm run check:docs` が通る）
- **AC-5** `npm run check:all` が全部 OK

## 移した理由の記録

| ファイル:識別子 | 消したコメントの要点 | 移し先（名前／テスト名／ここ） |
|---|---|---|
| `opfs.ts:attempt`・`attemptSync`（`removeOutputFile`・`removeScratchDir`・`removeScratchDirByName`・`cleanupStaleScratchDirs`・`removeCachedConversionEntry`・`clearAllCachedConversions`・`closeHandles`・`createScratchPool`・`openHandlePool` が使う） | 後始末の失敗（既に無い・他のタブが使用中・既に閉じている）は実害が無いので無視し、1件の失敗で残りの後始末を止めない（受け入れ条件「一時ファイルを必ず消す」） | 名前（空の `catch` を `attempt` に置き換えた）＋テスト名 `後始末(closeOne)自体が失敗しても、残りのハンドルを閉じ続ける`＋ここ |
| `opfs.ts:cleanupStaleScratchDirsWithoutStoppingTheJob`（`copc.worker.ts` の 6 か所） | 前回の後始末が走らなかった一時ディレクトリを、変換・ツールの前に掃除する。掃除が失敗しても変換は試みる。ロックの中で呼ぶので、他のタブが作りかけのディレクトリを消すことはない | 名前＋ここ |
| `opfs.ts:SIZE_OF_A_DIR_IN_USE_BY_ANOTHER_TAB` | 他のタブが使用中で大きさを読めない一時ディレクトリも、一覧から消すと「個別に消す」操作の対象にできなくなるので、0 として一覧に残す | 名前＋ここ |
| `opfs.ts:collectReadableCachedConversions` | 索引が壊れている・対応する出力が無い 1 件は飛ばす。`pcv-converted` 自体が無いときは空のまま | 名前 |
| `opfs.ts:SCRATCH_SIZE_FACTOR` | 11 は ADR-0006 の実測（sofi: 入力 2.03GB → 一時ファイルのピーク 21.864GB、約 10.77 倍）。LAZ（圧縮）の実測なので、点数が分かるときは `requiredBytesForPointCount` を使う | ここ（テスト名 `ADR-0006の実測どおり入力サイズの11倍を必要量とする`） |
| `opfs.ts:SCRATCH_BYTES_PER_POINT` | 60 は ADR-0006・M4-1b の実測（一時ファイルのピーク÷点数）beer.laz 49.31〜59.06、sofi.copc.laz 51.06〜60.00 B/点の大きい側 | ここ（テスト名 `M4-1bの実測(60 B/点の一時領域+10 B/点の出力)を根拠にした値を返す`） |
| `opfs.ts:OUTPUT_BYTES_PER_POINT` | 10 は copc-writer の出力 beer 606,308,379 B ÷ 66,848,096 点 = 9.0699、sofi 3,305.84MB ÷ 364,384,576 点 = 9.0724 B/点を切り上げた値。Web（OPFS）の出力がネイティブと SHA-256 で一致する（M4-6a 4 節）のでそのまま使う。M4-7/8/10 の後で圧縮率が変わっていないかは再検証していない | ここ |
| `opfs.ts:SCRATCH_DIR_PREFIX`・`LEGACY_SCRATCH_DIR_NAME` | 一時ファイルの置き場所が固定名 `pcv-scratch` だった頃、別のタブや「準備中」で止まった変換が同じファイルのハンドルを握っていて、`createSyncAccessHandle` が「Access Handles cannot be created if there is another open Access Handle」で失敗した（実機の不具合）。変換ごとに一意な名前にし、古い固定名も掃除の対象に残す | ここ（テスト名 `M4-6bの最初の実装が使っていた固定名も掃除の対象に含める`） |
| `opfs.ts:openHandlePool` | 途中で失敗したら、それまでに開いたハンドルを閉じてから投げ直す（以前は漏れていて、上の Access Handles のエラーの原因だった） | テスト名 `途中で失敗したら、それまでに作ったハンドルをすべて閉じてから投げ直す` |
| `opfs.ts:createScratchPool` | 失敗したら自分が作ったディレクトリを消す。呼び出し元は例外のとき `dirName` を受け取れず、次の掃除任せになるため | ここ |
| `opfs.ts`（ファイルの分け方）・`createOutputHandle` | `createSyncAccessHandle` は Dedicated Worker の中でしか呼べない（WHATWG File System、M4-6a 7 節）。それ以外の OPFS の API はメインスレッドからも呼べるので、`web.ts` と `copc.worker.ts` の両方がこのファイルを import する | ここ |
| `opfs.ts:withConversionLock`・`CONVERSION_LOCK_NAME` | 変換を 1 つに限る。複数のタブが同時に OPFS の一時ファイルを掴み合うと `createSyncAccessHandle` が失敗した（実機の不具合） | ここ（テスト名 `ロックが取れなければ、callbackを一切呼ばずbusyを返す`） |
| `opfs.ts:ensurePersistentStorage` | 既に永続化済みなら `persist()` を呼ばない。Firefox は呼ぶたびに確認のポップアップを出しうる（MDN「Storage quotas and eviction criteria」）。Chrome・Edge・Safari はサイトの利用履歴から自動で決め、確認を出さない | ここ（テスト名 `既に永続化済みなら、persist()を呼ばずにそう報告する`） |
| `opfs.ts:estimateQuota` | `quota`・`usage` が `undefined` の実装があるので 0 で補う（空きが無いと判定されやすい安全側） | ここ |
| `opfs.ts:cacheKeyFor`・`fnv1a32`・`randomJobId` | キーとジョブ ID に暗号学的な強度は要らない（同じ入力から同じキーが出ればよい／衝突しなければよい）ので FNV-1a と簡易な代わりを使う。`crypto.randomUUID` が無い環境の代わり | ここ |
| `copc.worker.ts`（Worker で動かす理由） | `FileReaderSync` と同期の XHR は Worker 専用の API。`pcv-core` の `CopcFile` は同期の `Read + Seek` の上で動くので Worker の中で動かす（ADR-0012）。COPC を開く側は Worker 1 本、変換の LAZ 展開だけ複数の Worker に分ける | ここ |
| `copc.worker.ts:openGeneration`・`stale-node-error.ts:StaleNodeRequestError` | ファイルを切り替える `open` を待つ間も、レンダラの rAF ループは古い hierarchy で `readNode` を送り続ける。Worker に届く頃にはファイルが替わっているので、世代番号で古い要求を見分け、`readNode-stale` で返す。`NodeLoader` 自身の世代カウンタではこの競合の狭い窓を塞ぎきれないので、裏側の判定を無条件に信じて黙って捨てる | ここ |
| `copc.worker.ts:ensureWasmReady`（`init_panic_hook` の呼び出し） | `#[wasm_bindgen(start)]` で `init()` の時点に自動で呼ばれているが、このファイルだけで「panic フックが有効」と分かるように明示的にもう一度呼ぶ。`set_hook` を何度呼んでも害は無い | ここ |
| `copc.worker.ts`（`onmessage` の `convertCancel`） | 応答の無い fire-and-forget で、読み込みループが次のバッチに進む前に立っていないと意味が無いので、`ensureWasmReady` の `await` や `try` の外ですぐ処理する。並列読み込み中は展開 Worker を `terminate()` し、`Promise.all` が永遠に待たないよう対応する `reject` も呼ぶ | ここ |
| `copc.worker.ts`・`laz-decompress.worker.ts`（`bytes.buffer` の transfer） | wasm-bindgen のグルーコードが `Vec<u8>` の戻り値を既に `.slice()` でコピーしているので、`bytes.buffer` は専有。コピーせずに transfer できる | ここ |
| `copc.worker.ts:yieldToEventLoop` | `postMessage` の配送はマクロタスクなので、`Promise.resolve()` だけの `await`（マイクロタスク）では送られた `convertCancel` がまだ処理されないことがある | ここ |
| `copc.worker.ts:describeConversionFailure` | wasm のメモリ確保の失敗は `unreachable` のトラップにしかならず、JS が受け取るメッセージは `"unreachable"` だけ。`lastAllocationFailureMessage()` の詳しい理由で補う | ここ |
| `copc.worker.ts:CONVERT_BATCH_SIZE`・`decompress-partition.ts:DECOMPRESS_BATCH_POINTS` | デスクトップの `READ_BATCH_SIZE` と同じ桁にして、進捗の粒度とキャンセルの反応を揃える。1 点最大約 57 バイトで 64Ki 点 ≈ 3.65MiB が 1 バッチの最大 | ここ |
| `copc.worker.ts:runParallelReadPhase`・`laz-decompress.worker.ts`・`decompress-partition.ts:BoundedBatchFlow` | 以前は展開 Worker が担当範囲全体を 1 回で返し、メモリが点数に比例して wasm32 の 4GiB を超えた（「変換に失敗しました: unreachable」の一因）。バッチ単位の pull 型にして、同時に抱える量を上限で抑える。背圧の待ちはポーリングだが、1 バッチの処理時間に比べて十分短い | テスト名 `総リクエスト数を10倍にしても、同時に抱える量の上限は変わらない`＋ここ |
| `copc.worker.ts:runWorkerLoop`（`batchRequestPending`） | `init` の失敗の `decompress-failed` は `requestBatch` を送る前に届き、`acquire` していないので `release` しない。送った後の失敗では `release` しないと、他の Worker が余裕が無いと誤って判定する | ここ |
| `laz-decompress.worker.ts`（専用の Worker が要る理由） | デスクトップは `rayon` で LAZ 展開を並列にするが、Web では使えない。GitHub Pages は COOP/COEP のヘッダーを設定できず `crossOriginIsolated` にならないので `SharedArrayBuffer` が無い（ADR-0012）。メモリを共有しない Worker を複数立てて分担する | ここ |
| `decompress-partition.ts:PARALLEL_MIN_POINTS` | ネイティブの実測（M4-7、`parallel_read_bench.rs`）で、分担が小さすぎると起動のオーバーヘッドで直列より遅くなった（64Ki 点、20 コアで直列 18.1 秒・並列 30.2 秒）。Worker の起動と `File` の構造化クローンはさらに重いと見て余裕を持たせた | ここ |
| `decompress-partition.ts:MAX_DECOMPRESS_WORKERS` | ADR-0007 の `POOL_SIZE` と同じ考えの決め打ち。各 Worker が wasm のヒープと起動コストを持つので頭打ちにする。実機では測り直していない | ここ |
| `decompress-partition.ts:MAX_DECOMPRESS_WORKERS_MOBILE` | 1（追加の展開 Worker を立てない）。所有者の実機（RAM 4GB）で「準備中のまま止まってタブが落ちる」の調査で、Worker ごとの wasm ヒープを避けた。バッチ化で直接の根拠は弱まったが、実機で確かめるまで変えない（未検証の初期値） | ここ（テスト名 `MAX_DECOMPRESS_WORKERS_MOBILE(=1)で頭打ちになり、追加のWorkerを一切立てない`） |
| `decompress-partition.ts:MAX_IN_FLIGHT_BATCHES_PER_WORKER` | 今の `runWorkerLoop` は厳密な lockstep なので実際には 1 個で頭打ち。先読みにしても値を変えずに済むよう 2。3 以上は同時に抱えるバイト数を増やすのでしない | ここ |
| `copc.worker.ts:runConversion` ほか（`finish()` の後の `converter = null`） | wasm-bindgen の生成コードは `finish()` の本体を走らせる前にポインタを 0 にするので、成否によらず `converter` を null にして、`finally` の `free()` で二重に解放しない。`finish` の間は `convertCancel` を反映できないので、その間のキャンセルは終わった後に無かったことにする | ここ |
| `copc.worker.ts:NO_CRS` | `"Missing"` は `pcv_core::crs::CrsId::Missing` の Debug の表記。CRS の無いファイルは通し（Rust の `finish` が警告を返す）、CRS を持つファイル同士の食い違いだけ止める | ここ |
| `copc.worker.ts:runMultiConversion`（`result.points_read - pointsCompletedBeforeCurrentFile`） | `points_read` はそれまでの全ファイルの点数。差し引かないと前のファイルを二重に数えた（6,250,115 / 3,126,520 と出た） | ここ |
| `copc.worker.ts:WorkerScope` | tsconfig の lib を DOM 向けのままにしたいので、`self` は使う形だけをキャストで与える | ここ |
| `tauri.ts:readNode`（`panicMessageFromBackend`） | 500 の本文には Rust が `catch_unwind` で捕まえた panic のメッセージとノードキーが入っている（ADR-0013）。読み捨てると「500」としか出せない | 名前（`body` から変えた）＋ここ |
| `tauri.ts:readNode`・`tauri-protocol.ts:buildNodeRequestPath` | `convertFileSrc` は文字列全体を 1 回 `encodeURIComponent` するので、区切りの `/` も `%2F` で届く。v0.1.3 では区切りが `:` で、Rust がデコードせずに解析していて全ノードの読み出しが失敗した。今は Rust がデコードしてから解析するので区切りの選び方は動作に影響せず、ベンチ用の `/<size>` と見分けやすい `/` にした | テスト名 `ベンチ用の'/<size>'形式(数字のみ)とは常に区別できる('/'を含む)`＋ここ |
| `file-picker.ts:pickFilesOnWeb` | `input.click()` は呼び出し側のクリックの処理の中で、最初の `await` より前に同期で呼ぶ（そうしないとブラウザがユーザー操作でないとして止める）。そのためこの関数は `async` にしない。`cancel` イベントを出さないブラウザでは Promise が決まらないままだが、クリックの処理以外は待たないので害は無い。input は document に付けていない（R6 の記録） | ここ |
| `point-count-estimate.ts`（点数で見積もる理由） | 旧実装の「ファイルサイズ×11」は LAZ（圧縮）の実測なので、非圧縮・f64 の PCD（sofi.pcd 9.47GB → 約 104GB）で誤って「空き容量不足」になった。一時領域も出力も点数にほぼ比例する | テスト名 `非圧縮PCD(sofi.pcd相当、3.64億点)でも、旧実装のファイルサイズ×11より…`＋ここ |
| `point-count-estimate.ts:peekLasPointCount` | u64 の点数を Number にする。実務の点数は 2^53 を超えない | ここ |
| `source-format.ts:detectSourceFormatByName` | 以前は COPC でないファイルを形式を見ずに LAS/LAZ の変換に回していて、PCD に LAS/LAZ 向けの見積もりが当たり誤って容量不足になった。変換を試みる前に拡張子で形式を決める | ここ |
| `copc-header.ts:isCopcHeader` | COPC の仕様は「COPC info VLR はファイルの最初の VLR」と定め、copc-writer もそう書くので、ヘッダーの直後の VLR だけ見ればよい。Web 側には LAS のパーサーが無いので自前で読む | ここ |
| `copc-dto.ts`（DTO の共有） | Tauri（`open_copc`）と Web（`pcv-wasm`）が同じ形の JSON を返す前提。片方だけ形を変えたら両方直す。値の無い Option は Tauri では null、wasm では undefined で来る | ここ |
| `node-format.ts` | バイナリの並びは `crates/pcv-core/src/node_format.rs` と同じ。変えるときは両方を同じコミットで直す | ここ |
| `web-protocol.ts`（`tool-*` の応答） | ツールの結果は変換（`convert-*`）と別の型で返す。変換の完了はアプリ全体のリスナーが「変換結果を開く」ので、同じ型だとツールの結果が勝手に新しいファイルとして開かれる | ここ |
| `web-protocol.ts:DEFAULT_MAX_POINTS_PER_NODE` | copc-writer の既定（`CopcWriterParams::default`）とデスクトップ（`src-tauri/src/conversion.rs`）に揃える | ここ |
| `web.ts:createRealWorker` | `type: "module"` でないと Worker の中で ESM の import が使えない（pcv-wasm の生成物が ESM） | ここ |
| `web.ts:prepareToOpen`（ダウンロードの URL） | OPFS の中身は外から fetch できないので、ダウンロードの URL もここで作る。開けなかったら呼び出し側が revoke する | ここ |
| `file-system-sync-access-handle.d.ts` | TypeScript の `lib.dom.d.ts` に `FileSystemSyncAccessHandle` の型がまだ無い（2026-09、TypeScript ~6.0.3）。`import`・`export` を書かないので全体がグローバルな宣言になる | ここ |
| `environment.ts:isTauriEnvironment` | Tauri の npm パッケージは import せず（規約 2）、Tauri が起動時に生やす `__TAURI_INTERNALS__` を見る | ここ |
| `update-check.ts:fetchLatestRelease` | 所有者が署名鍵を作らない方針にしたので、tauri-plugin-updater を使わず、GitHub Releases の最新版を fetch で確かめて知らせるだけにした（ADR-0004 追記 4）。オフライン・レート制限（未認証 60 回/時）・HTTP のエラーはすべて null | ここ |
| `version-compare.ts:numericPartsWithoutVPrefixOrPrerelease` | tag の `v0.1.0` とアプリの `0.1.0` の `v` の食い違いを吸収し、プレリリースの識別子は比べない | 名前（`toNumbers` から変えた） |

## 記録

（作業エージェントが足す）

### 実装の記録 R1（作業役）

#### やったこと

- `src/datasource/` の 49 ファイル（`git ls-files src/datasource`。うち 46 ファイルが baseline にあった）のコメントを 1,207 個消した（baseline の 46 項目の合計と一致。`node scripts/check-comments.mjs --lower-baseline` → `12261 -> 11054 comments`）。例外の指示（`eslint-disable*` など）は消していない
- 消し方: `scripts/check-comments.mjs` の `findScriptCommentRanges`（数える物と同じ字句の範囲）で範囲を出し、コメントだけの行は行ごと、行末のコメントは前の空白ごと消す一時的なスクリプト（コミットしていない）で消した。その後、ブロックの先頭・末尾の空行と 2 行以上続く空行が残っていないことを `awk` で全ファイル確かめた（出力 0 件）。ファイル末尾の改行が無かった 2 ファイル（`file-system-sync-access-handle.d.ts`・`opfs.test.ts`）は末尾に改行が付いた
- コメントしか中身が無かった空の `catch`（ESLint の `no-empty` で 18 か所落ちた）は、空の `catch` を残さず、名前で意図を表した（振る舞いは同じ）:
  - `opfs.ts` に `attempt`（非同期）・`attemptSync`（同期）を足し、「失敗しても続ける後始末」をこれで呼ぶ。戻り値は成否の boolean（使い手は見ない）
  - `opfs.ts` に `cleanupStaleScratchDirsWithoutStoppingTheJob` を足し、`copc.worker.ts` の 6 か所の `try { await opfs.cleanupStaleScratchDirs(); } catch {}` を置き換えた
  - `getOpfsUsageBreakdown` の 1 件ずつの読み取りを `readCachedConversionEntry`・`collectReadableCachedConversions` に出し、使用中の一時ディレクトリの大きさを `SIZE_OF_A_DIR_IN_USE_BY_ANOTHER_TAB`（0）で表した。途中で列挙が失敗したときに、それまでに集めた分が残るのも元と同じ（`into` の配列に足していく）
- 名前を変えた識別子（どちらもファイルの中だけの名前）:
  - `tauri.ts` の `readNode` の中の `body` → `panicMessageFromBackend`（使い手 1、同じ関数の中）
  - `version-compare.ts` の `toNumbers` → `numericPartsWithoutVPrefixOrPrerelease`（`git grep -n toNumbers -- src` の当たりは名前を変える前に `version-compare.ts` の 3 行だけ。変えた後は 0）
- 新しい識別子の使い手: `cleanupStaleScratchDirsWithoutStoppingTheJob` は `copc.worker.ts` の 6 か所。`cleanupStaleScratchDirs` 自体は `src/state/useOpfsStorage.ts:102` も使っていて、そちらは変えていない（範囲の外）
- コードから読めなくなる「なぜ」は、上の「移した理由の記録」に 51 行書いた（移し先に名前を含むもの 6、既存のテスト名を示したもの 11。重なりあり。残りは表だけ）。経緯だけのコメント（タスク ID・「M4-xx 追記」）、型や名前を言い直しただけの JSDoc、区切りの `// --- G1 ---`・import の行末の `// G1-T15` は移していない
- `src/code-limits.test.ts` の BASELINE: `copc.worker.ts` を 1733 → 1376 に下げ、800 行以下になった `opfs.ts`（534 行）・`web.ts`（708 行）の項目を消した。各コミットで通るよう、そのファイルを縮めたコミットの中で直した
- ADR の `path:line` 参照: `git grep -nE "src/datasource/[a-z.-]+\.ts:[0-9]+" -- TaskSheets/ADR-00{24..29}*.md docs` の当たりは 0 件で、直す所は無かった。`npm run check:docs` は OK

#### 採らなかった案

- ESLint の `no-empty` に `allowEmptyCatch` を足す: `eslint.config.js` は CM-3 の範囲で、空の `catch` は「なぜ無視するか」がコードから読めない
- `catch { return; }`・`catch { continue; }` で空でなくする: 振る舞いは同じだが、無視する理由が名前に出ない
- `readNode` の 500 の扱いや `finish()` の後の `converter = null` を関数に出す: 名前の変更と関数の切り出しは認められているが、範囲が広い Worker のコードの形を変えると振る舞いの同値を目で確かめる量が増えるので、ここの表に書くに留めた

#### 確かめ方

- `npm run check:comments` → `comments OK (361 files with 11054 comments left in scripts/comment-baseline.json)`、`src/datasource` の項目は 0（`grep -c src/datasource scripts/comment-baseline.json` → 0）
- `npx vitest run src/datasource`（`C:\` から）→ 19 files、195 tests passed。全体は 97 files、1113 tests passed
- `npm run check:all` → typecheck・lint・check:circular・check:docs・check:comments・vitest・cargo fmt (workspace)・cargo clippy (workspace)・cargo fmt (vendor/copc-writer) がすべて OK
- 振る舞い: 名前の変更と `attempt` などへの置き換え以外の差分はコメントと空行だけ（`git diff d05c858..HEAD -- src/datasource` の `+` 行を見た）。OPFS の I/O（`attempt` を使う所）はブラウザでしか動かず、テストは無い。所有者の確認手順は M4-6b と同じ（Web 版で LAS を変換し、設定の「保存領域」で一時ファイル・キャッシュの一覧と「消す」「すべて消す」が前と同じに動くこと）
