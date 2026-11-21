# CM-F2: wasm にビルドした場所のパスを入れない／変換済みキャッシュの削除も変換のロックの中で（F2・F9・F10）

- 元: `PLAN-2026-11.md` の「CM で見つかった後のタスク」F2・F9・F10
- 方針: 3つは別の関心事なので、コミットを分ける（F2 で1つ以上、F9 で1つ以上、F10 で1つ以上）。コードにコメントを書かない。push しない
- 並行: PL-1 と同時に走る。PL-1 が触るファイル（`src/plugin-api/`・`src/core/plugin-host.ts`・`src/ui/plugins/`・`src/plugins/`・`src/app/tea.ts`・`src/app/view.ts`・`src/ui/shell/`・`src/ui/toolbar/`・`src/ui/status/`・`src/ui/tools/`・ADR-0022・ADR-0023）は触らない

## いまの形（メインが読んで確かめたこと、2026-11-21 の `23c51a7`）

- **F2**: コミットしてある `src/wasm/pcv-wasm/pcv_wasm_bg.wasm` に、`grep -aoE "[A-Za-z]:[\\/][A-Za-z0-9_./\\-]{3,60}"` で `C:\Users\Masa1\.cargo\registry\src\index.crates.io-…`（40 か所）・`C:\Users\Masa1\.rustup\toolchains\stable-x86_64-pc-windows-msvc`（28 か所）・`C:\workspace\pcv-wt-CM-4\vendor\laz\src\…`（3 か所）が出る。
  ビルドした PC・場所ごとに中身が変わり、ユーザー名が公開のリポジトリと Pages に出る。`npm run build:wasm`（`package.json` 16 行）は `cargo build … --release` と `wasm-bindgen` だけで、パスを付け替える指定が無い。
  CI の `pages.yml` は wasm を作り直して `npm run check:wasm-glue`（JS と型だけを `git diff`。`.wasm` 本体は比べない）で古さを見る
- **F9**: 設定の「保存領域」の変換済みキャッシュの「消す」「すべて消す」（`src/state/useOpfsStorage.ts` の `removeOpfsCachedConversion`・`clearOpfsCachedConversions`、`useCallback` の手順）は、変換のロック（`withConversionLock`）を取らずに消す。一時ファイルの削除は CM-F1 で `src/app/scratch-cleanup.ts` の `removeScratchDirsUnlessConverting` に移してロックの中にした
- **F10**: `scratch-cleanup.ts` の `removeScratchDirsUnlessConverting` は、消すのに失敗したエラーを `reportError(…, "conversion")` に流すので、エラーの見出しが「変換エラー」になる

## 範囲

触ってよい: `package.json` の `build:wasm`（と、要るなら新しいスクリプト・`crates/pcv-wasm/` のビルドの設定）、`src/wasm/pcv-wasm/`（作り直した生成物）、CI の wasm の検査（`.github/workflows/pages.yml`・`ci.yml` の該当の段）、
`src/state/useOpfsStorage.ts`、`src/app/scratch-cleanup.ts` とテスト（または新しい `src/app/` の関数とテスト）、`src/ui/settings/` の保存領域の部品、`src/renderer/gpu-error-log.ts` の `GpuErrorSource` とその見出しの表（使い手を数えて全部直す）、このシートの記録

## 受け入れ基準

- **AC-1（F2）** `npm run build:wasm` で作った `pcv_wasm_bg.wasm` に、ビルドした PC の絶対パス（ユーザー名・`.cargo`・`.rustup`・作業フォルダ）が入らない。`Masa1`・`.rustup`・`.cargo`・`/Users/`・`/home/` が 0 件で、ドライブ名で始まるパス（前の文字が英字でない `X:\` か `X:/`。`http://` の末尾は数えない）も 0 件であることを、作り直してコミットした wasm で示す。
  Pages に出す wasm（`pages.yml` が作る物）も同じ作り方にする。作業フォルダが違っても同じ wasm になること（再現できるビルド）は求めない（下の「メインの決定」）。wasm が動くこと（`npx vitest run` の wasm を使うテスト、E2E の `web-conversion.spec.ts` を手元で）も確かめる
- **AC-2（F2 の再発防止の芽）** コミットした wasm に絶対パスが入っていたら落ちる検査を、手元（`npm run check:all` に入るもの）か CI に置く
- **AC-3（F9）** 変換済みキャッシュの「消す」「すべて消す」も、変換と同じロック（`withConversionLock`）を取れたときだけ消し、取れなかったら何も消さず、押した場所の近くに一時ファイルと同じ「実行中なので消せません」の文を出す。
  手順は `src/app/` の普通の関数（ADR-0021。フックに手順を残さない）。文がいつ消えるかは CM-F1 と同じ（AGENTS.md の「案内・警告の表示」: 画面を開き直した・一覧を読み直した・対象が無くなった・次に消せた）で、消える時ごとにテストを置く
- **AC-4（F10）** 保存領域の削除の失敗は「変換エラー」でない見出し（保存領域の失敗と分かる日本語）で出る。`GpuErrorSource` を広げたら、使い手（`grep -rn "GpuErrorSource" src`）を数えて記録に書く
- **AC-5** `npm run check:all` が全部 OK。`node scripts/check-task-sheet.mjs <base>` の出力を作業報告に貼る。画面（AC-3 の文）は CM-F1 と同じやり方で 375px・1280px で撮り、見た所見を書く（撮れなければ「未確認」）

## メインの決定（R1 の途中、2026-11-21）

- 最初の AC-1 には「同じソースなら作業フォルダが違っても同じ wasm」があった。作業役が調べた結果、パスを付け替えても wasm は同じにならなかった。`crates/pcv-wasm` の独立したワークスペースの外にある path 依存（`../pcv-core`・`../../vendor/*`）では、Cargo がクレートの識別の値を絶対パスから作る。そのため関数の名前とまとめ方が変わる（作業役の実測: 2 つの作業フォルダで sha256 と関数の数が違い、codegen-units=1 でも同じだった）
- 同じにする案は2つあった。`pcv-wasm` をルートのワークスペースに入れる案は、ADR-0012 の「wasm 用の依存をネイティブの `--workspace` に巻き込まない」に反する。決まった場所に写してビルドする案は、並行するビルドがぶつかる。
  どちらも、F2 の元の問題（ユーザー名とパスが公開物に出る）を直すのには要らない。そのため、この条件を外した（ADR を覆さない側）。再現できるビルドが要るようになったら、ADR-0012 の改訂として所有者に上げる

## 確かめ方

- 上のテストの名前、`npm run check:all` の一覧、`grep` の件数
- 所有者の確認手順: Web 版で大きな LAS の変換を始め、別のタブで 設定 → 保存領域 → 変換済みの「すべて消す」を押し、消せない旨が出て、変換が最後まで終わること

## 記録

（作業役が足す）

### 実装の記録 R1（2026-11-21、作業役）

コミット: `e4819e2`（F2）、`f28726d`（F10）、`710f528`（F9）。

#### F2（AC-1・AC-2）

- `scripts/build-wasm.mjs`（`npm run build:wasm`）: 作業フォルダ・`CARGO_HOME`（無ければ `~/.cargo`）・`rustc --print sysroot` を `--remap-path-prefix` で `/pcv`・`/cargo`・`/rustc-sysroot` に付け替えて `cargo build --release` し、`wasm-bindgen` を走らせる。
  フラグは `CARGO_ENCODED_RUSTFLAGS` で渡す（空白を含むパスでも割れないため）。Windows のパスはドライブ名の大文字・小文字と `\`・`/` の 4 通りを渡す（`npm` から走らせると作業フォルダが `c:\` の小文字で来ることがあった）。`CARGO_TARGET_DIR` に従う（前の `build:wasm` は `crates/pcv-wasm/target` を決め打ちしていた）
- `pages.yml` は `cargo build` と `wasm-bindgen` を直に書いていたのを `npm run build:wasm` にし、続けて Pages に出す wasm を `npm run check:wasm-paths` で見る（setup-node を前に動かした。どちらも node の組み込みだけを使うので `npm ci` の前でよい）
- `scripts/check-wasm-paths.mjs`（`npm run check:wasm-paths`）: 前の文字が英字でないドライブ名のパス（`http://` の末尾は数えない）・`/home/…`・`/Users/…`・`.cargo`・`.rustup`・検査を走らせた利用者の名前（`os.userInfo()`。3 文字以上のとき）を探し、あれば落ちる。名前は書かず、走らせた PC の利用者名を使う（私的な名前をリポジトリに書かないため）。
  `check:all`・`ci.yml` の frontend（コミットした wasm）・`pages.yml`（作った wasm）で走る
- 再現できるビルドは求めない（上の「メインの決定」）。同じフォルダ・同じ共有の target で作り直すと同じ sha256 だった（`b570a9d42de071031d7311a580f0cb9968aac8b31dc7b7a0a2ebb8e02327c441`、2 回）

確かめたこと（コミットした wasm、`e4819e2`）:

| 見たもの | 件数 | コマンド |
|---|---|---|
| `Masa1`・`.rustup`・`.cargo`・`/Users/`・`/home/` | 各 0 | `grep -aoF "<語>" src/wasm/pcv-wasm/pcv_wasm_bg.wasm \| wc -l` |
| 前の文字が英字でないドライブ名のパス | 0 | `LC_ALL=C.UTF-8 grep -aoP "(?<![A-Za-z])[A-Za-z]:[\\\\/][A-Za-z0-9_./\\\\-]{3,60}" … \| wc -l` |
| （参考）元のシートの grep の形 | 4 | 4 件とも `http://` の末尾（`p://laszip.orgCOPC`・`p://www.landxml.org/…`・`p://www.w3.org/…` 2 件） |
| `npm run check:wasm-paths` | OK | 終了コード 0 |
| 前の wasm（`git show e0ff21b:src/wasm/pcv-wasm/pcv_wasm_bg.wasm`）に同じ検査 | 59 件で落ちる | `node scripts/check-wasm-paths.mjs <前の wasm>` が終了コード 1 |

- 付け替えた後の wasm に残る形: `/cargo\registry\src\…` 40、`/rustc-sysroot\lib/rustlib\…` 28、`/pcv\vendor\laz\…` 20、`/pcv\crates\pcv-core\…` 11、`/pcv\vendor\copc-writer\…` 6（パニックの場所の文字列）
- CI の Linux で作る wasm: 付け替えは `CARGO_HOME`・sysroot・作業フォルダを実行時に読むので、`/home/runner/.cargo`・`/home/runner/.rustup/toolchains/…`・`/home/runner/work/…` も付け替わる見込み（推定、CI では未実行）。
  付け替えが漏れても `pages.yml` の検査が `/home/…`・`.cargo`・`.rustup`・利用者名（`runner`）で落ちる。この 3 つの形の文字列で落ちることは `scripts/check-wasm-paths.test.mjs` の "finds the paths of a Linux CI build under /home/runner" で固定した。今の wasm に `runner` の語は 0 件（`grep -aic runner`）で、利用者名の検査が誤って落ちることは無い
- wasm が動くこと: `PCV_E2E_PORT=4391 npx playwright test e2e/web-conversion.spec.ts` → `1 passed`（作り直した wasm を `npm run build` で取り込んだ preview で変換が通る）。
  vitest には wasm 本体を読むテストが無い（`grep -rln "wasm/pcv-wasm\|pcv_wasm" src e2e` は Worker 2 つと `layer-rules.test.ts` の文字列だけ）。`npx vitest run` は全部通る（下）

テスト: `scripts/check-wasm-paths.test.mjs`（Windows のビルドのパス、`/` と小文字のドライブ名、Linux の CI、macOS の home と home の外の `.cargo`、利用者名、短すぎる利用者名を見ない、`http://`・`https://` を数えない、付け替えた後の形を通す、`remapPathPrefixFlags` の Windows・Linux）

#### F10（AC-4）

- `GpuErrorSource` に `"storage"` を足し、見出しの表を `src/ui/dialogs/ErrorDialog.tsx` から `src/ui/dialogs/error-source-label.ts`（`ERROR_SOURCE_LABEL`）に出して「保存領域のエラー」を足した。表は `Record<GpuErrorSource, string>` なので、種類を足して見出しが無いと型で落ちる
- 保存領域の削除の失敗は `"storage"` で報告する。テスト: `src/ui/dialogs/error-source-label.test.ts` の "heads a failure of the browser storage as storage, not as a conversion error"・"gives every source its own heading"、`src/app/storage-cleanup.test.ts` の "shows a failure to remove a scratch dir in the error log under the storage heading, not as a conversion error"・"shows a failure to remove a cached conversion in the error log under the storage heading"
- 使い手を数えた: `grep -rn "GpuErrorSource" src` は 28 行、テスト以外のファイルは 11 個（`open-files.ts`・`point-cloud-tools.ts`・`storage-cleanup.ts`・`section-export.ts`・`section-view.ts`・`core/plugin-host.ts`・`gpu-error-log.ts`・`useErrorLog.ts`・`useLayers.ts`・`useRendererLifecycle.ts`・`error-source-label.ts`）。
  種類で分かれるのは見出しの表（`ERROR_SOURCE_LABEL`）と、`GpuErrorLog.report` の「直前と同じ本文・同じ種類なら回数を足す」だけ。ほかは種類を受け取って渡すだけなので、種類が 1 つ増えても困る側は無い。`plugin-host.ts`（PL-1 の範囲）は型を通すだけで、触っていない

#### F9（AC-3）

- `src/app/scratch-cleanup.ts` を `src/app/storage-cleanup.ts` にした（一時ファイルと変換済みキャッシュの両方を扱うため名前を替えた）。`removeStorageUnlessConverting(ctx, target)` の `target` は `all-scratch`・`one-scratch`・`all-cached`・`one-cached` の 4 つ。
  どれも `withConversionLock` の中でだけ消し、取れなければ何も消さず `"busy"` を返して押したボタンをストアに置く。失敗の文は「一時ファイルを消せませんでした: …」「変換済みキャッシュを消せませんでした: …」
- `useOpfsStorage` の `removeOpfsCachedConversion`・`clearOpfsCachedConversions`（`useCallback` の手順）を消し、文脈 `storageCleanupContext` に消す関数（`clearAllCachedConversions`・`removeCachedConversionEntry`）を入れて組むだけにした。消した 2 つの使い手は `grep -rn` で `StorageDialog.tsx` の 2 か所と配線（`useCopcViewer.ts`・`viewer-types.ts`）だけで、全部付け替えた。`withConversionLock`・`opfs.ts` の消す関数は変えていない
- `StorageDialog.tsx`: 変換済みキャッシュの「すべて消す」（`data-testid="cached-remove-all"` を足した）は見出しの下、行の「消す」はその行の下に文を出す。`data-testid` の `scratch-cleanup-busy` は `storage-cleanup-busy` にした（使い手は `src`・`e2e`・`scripts` に無い）
- 文を出すかは `showsBusyNoticeFor(blocked, target, breakdown)`（押したボタンで、かつ対象がまだ一覧にあるとき）。CM-F1 では「対象が無くなった」を画面の条件にだけ書いていたのを、この関数に入れてテストにした

文が消える時とテスト（`src/app/storage-cleanup.test.ts`）:

| 消える時 | テスト |
|---|---|
| 次に消せた | "clears the busy notice once a later press removes: $kind"（4 つの target） |
| 保存領域を開き直した | "forgets the busy notice when the storage page is opened again after the conversion ended: $kind"（4 つ） |
| 一覧を読み直した（更新） | "forgets the busy notice of a cached conversion row when the list is refreshed" |
| 対象が一覧から無くなった | "hides the notice once its target is no longer listed: $kind"（4 つ）、"hides the notice of a removed cached row while the other rows stay" |

ほか: "asks for the conversion lock by the same name, only if available: $kind"、"removes nothing and remembers the blocked button when a conversion holds the lock: $kind"、"removes all cached conversions and refreshes when the lock is free"、"removes only the chosen cached conversion when the lock is free"、"releases the lock when removing throws, so a later conversion can take it"、"keeps the busy notice of one viewer out of another viewer"、"shows the notice only next to the button that was blocked"、"matches the blocked row by name or output"

画面で見たこと（Playwright の Chromium（`channel: "chromium"`）。`npx vite --port 5397 --strictPort` を自分で立て、終わってから、コマンドラインに `--port 5397` を含む自分の 2 つのプロセスだけを止めた。台本は作業役の一時フォルダに置き、撮った後に消した）:

- 同じオリジンの 2 つ目のタブで `navigator.locks.request("pcv-web-conversion", …)` を持ったまま、OPFS の `pcv-converted` に `shot-a`・`shot-b` の変換済みキャッシュ（`.copc.laz` と `.meta.json`）を作り、設定 → 保存領域で変換済みの「すべて消す」と `shot-a.las` の行の「消す」を押した
- 375px・1280px とも、スクリプトの出力は `noticesWhileBusy: 1`、`namesWhileBusy` は 4 つのファイルが全部残る、ロックを離して「更新」で `noticesAfterRefresh: 0`、その後の「すべて消す」で `namesAfter: []`・`noticesAtEnd: 0`
- 「すべて消す」の文は見出しのすぐ下に、行の「消す」の文はその行（`shot-a.las`）のすぐ下に橙で出る。375px では 2 行に折り返してダイアログの枠の中に収まり、ボタンや行と重ならない（`375-2-remove-all-cached-busy.png`・`375-3-remove-one-cached-busy.png`・`1280-3-remove-one-cached-busy.png` を見た）

確かめていないこと（未確認）:

- 実際の変換が走っている最中に押したとき（上はロックを手で持っただけ）。所有者の確認手順: Web 版で大きな LAS の変換を始め、別のタブで 設定 → 保存領域 → 変換済みの「すべて消す」を押す。押した近くに「変換・ツールの実行中なので消せません。…」が出て、キャッシュが残り、変換が最後まで終わること。終わってからもう一度押すと消えること
- 消すのに失敗したときの「保存領域のエラー」の見出しは、画面では出していない（失敗させる手段が無いため。テストだけ）
- CI（Linux）で作った wasm の中身と、`pages.yml`・`ci.yml` の新しい段が CI で通ること（push していないため）

### 実装の記録 R2（2026-11-21、作業役。監査 R1 の指摘への対応）

- F-1（should）: 直した（f37bacf）。利用者名は `[\/]名前[\/]`（パスのフォルダ名）としてだけ探す。監査役の赤のテスト（`audit CM-F2 R1 red` の 2 件）を弱めずに入れた。
  再発防止のテスト（8d067b3、よくある利用者名 24 個でコミットした wasm に当たらない）で、付け替えた根の中のフォルダ名（`/pcv\vendor\laz\src\…` の `src` など）と、Rust の配布物が付け替えた `/rustc/<hash>/library/std/…`・`/rust/deps/…` の中にも当たることが分かった。そのため、付け替えた根（`REMAPPED_ROOTS` と `/rustc/`・`/rust/deps/`）より後ろにある利用者名のフォルダは見ないようにした。付け替えた根と同じ名前の利用者（`pcv`・`cargo`・`rustc-sysroot`）は探さない（その場合も `/home/…`・ドライブ名の検査は効く）
- F-2（should）: 直した（a1be9e3）。`--help` から「and is the same from any folder」を消した
- N-1（nit）: 直した（0d01b6a）。`encodedRustflagsWith` が既にある `CARGO_ENCODED_RUSTFLAGS`（無ければ `RUSTFLAGS`）の後ろに付け替えの指定を足す。テスト 3 件。何も設定していないときのフラグは前と同じで、`npm run build:wasm` は再ビルドせず（`Finished … in 0.08s`）、wasm の sha256 は `b570a9d4…c441` のまま
- N-2（nit）: 直さない。消すのに失敗したとき一覧を読み直さないのは CM-F1 からある形で、利用者は「更新」で読み直せる。失敗の後に読み直すかは CM-F1 の形と合わせて決めることで、このタスクの AC の外のため
- 前の wasm（`e0ff21b`）に新しい検査をかけると 75 件で落ちる。利用者名を渡さないと 57 件で、残りの 18 件は `Masa1` のフォルダ名の当たり（同じパスを、利用者名の前後の文字の範囲が違う文字列として別に数える。`findBuildMachinePaths(前の wasm, "")` と `(前の wasm, "Masa1")` で確かめた）

### 実装の記録 R3（2026-11-21、作業役。監査 R2 の指摘への対応）

- F-3（should）: 直した（b84d8d7）。利用者名のフォルダを見ないのは、当たったパスの先頭が付け替えた根（`/pcv/`・`/cargo/`・`/rustc-sysroot/`・`/rustc/`・`/rust/deps/`）のときだけにした（`startsWithRemappedRoot`）。根の名前が途中のフォルダにあるだけのパス（`/mnt/pcv/someone/…`）は捕まえる。
  監査役の赤のテスト（`audit CM-F2 R2 red` の 4 件）を弱めずに入れた。直す前のコードでは 4 件落ち、直した後は `scripts/check-wasm-paths.test.mjs` の 46 件が全部通る（よくある利用者名 24 個でコミットした wasm に当たらないテストも含む）。`npm run check:wasm-paths` は OK
- N-3（nit）: 8d067b3 のコミットメッセージの本文の「付け替えた根より後ろにある利用者名のフォルダは引き続き捕まえる」は、コードと逆だった。正しくは、8d067b3 は根より後ろの利用者名のフォルダを見ないようにした（実装の記録 R2 のとおり）。その後 b84d8d7 で、見ないのはパスの先頭が根のときだけにした。履歴は書き換えない（メインの決定）
