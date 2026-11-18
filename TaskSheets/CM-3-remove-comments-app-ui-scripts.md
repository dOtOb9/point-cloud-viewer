# CM-3: コメントを消す（`src/` のうち `renderer`・`datasource`・`wasm` 以外）

- 共通の決まり・例外・「なぜ」の移し方: [CM-0-no-comments.md](./CM-0-no-comments.md)（CM-0 が先に main に入っていること）
- 範囲: `src/` のうち `renderer`・`datasource`・`wasm` 以外（`app`・`ui`・`state`・直下のファイル）、`scripts/`・`e2e/`・`docs/video/tools/`、ルートの設定（`eslint.config.js`・`vite.config.ts`・`playwright.config.ts` など）、`.github/workflows/*.yml`・`Cargo.toml`（ルート）・`.gitattributes`・`scripts/*.ps1`。範囲の外のファイルは触らない（並行して別の作業役が消している）
- 方針: 振る舞いは変えない。push しない

## 受け入れ基準

- **AC-1** 範囲のファイルについて `scripts/comment-baseline.json` の項目が無くなり（上限 0）、`npm run check:comments` が通る。例外（CM-0 の「例外」）だけが残る
- **AC-2** 消したコメントが、コードから読めない意図を持っていた所では、CM-0 の順（名前 → テストの名前 → このシートの「移した理由」）で移す。
  名前を変えたら使い手を全部直す（`grep` の数を作業報告に書く）。名前の変更と関数の切り出し以外の変更はしない（振る舞いを変えない）
- **AC-3** コメントだけの行を消した後に、空行が2行以上続く・ブロックの先頭が空行になる、などの跡を残さない（整形ツールが通る）
- **AC-4** `src/code-limits.test.ts` の BASELINE など、行数に依存する検査・文書（ADR-0024 などの `path:line` の参照）を、縮んだ行数に合わせて直す（`npm run check:docs` が通る）
- **AC-5** `npm run check:all` が全部 OK
- YAML・TOML・`.gitattributes`・PowerShell は検査の対象外なので、`grep` で残りが無いことを作業報告に貼る（`#` で始まる行と行末の ` # `。`#!` と YAML の文字列の中は除く）
- `scripts/check-comments.mjs` などの検査のスクリプトの冒頭の説明も消す。使い方は `--help` の出力やエラーメッセージ、タスクシートに移す

## 移した理由の記録

| ファイル:識別子 | 消したコメントの要点 | 移し先（名前／テスト名／ここ） |
|---|---|---|
| `src/app/dtm.ts:landXmlUnitFor` | 国際フィートと米国測量フィートの差は 6e-7 なので、許容差はそれより細かくする | 名前 `UNIT_FACTOR_TOLERANCE_FINER_THAN_THE_6E7_GAP_BETWEEN_THE_FEET` |
| `src/app/section-view.ts:wheelZoomFactor` | `deltaMode` の 1 は行・2 はページ。行 16px・ページ 400px に直す | 名前 `WHEEL_DELTA_MODE_LINE`・`WHEEL_DELTA_MODE_PAGE`・`PIXELS_PER_WHEEL_LINE`・`PIXELS_PER_WHEEL_PAGE` |
| `src/app/open-files.ts:openFiles`（`openLock`） | デスクトップで2つ目の変換を始めると、バックエンドのキャンセルの旗が上書きされ、1つ目をキャンセルできなくなる。ロックが状態でなく普通のオブジェクトなのは、React が描き直す前にドロップが2回届きうるため | ここ |
| `src/app/point-cloud-tools.ts:PointCloudToolsContext.toolLock` | デスクトップのツールは変換と同じ `conversion-progress` イベントを使うので、ファイルを開く側はツールの実行中にその進捗を無視する（`isToolRunning`）。普通のオブジェクトなのは上と同じ理由 | ここ |
| `src/app/typing-target.ts:isTypingTarget`・`isFormControl` | 2つは逆向き。害のないキー（視点の F・1〜7）は `isTypingTarget`（ラジオ・スライダーにフォーカスがあっても効く）、消す・決めるキー（Delete・Enter・Esc）は `isFormControl`（どのフォーム部品でも効かない＝安全側）。TP-1 以前は4つの写しがあり食い違っていた | 既存のテスト `src/code-limits.test.ts`「Delete (layer) and Enter / Esc (measure, selection tools) use isFormControl, never isTypingTarget」と AGENTS.md の決まり |
| `src/state/setting-storage.ts:saveSettingIfStorageAllows`（新規） | localStorage はプライベートウィンドウやサイトデータのブロックで使えないことがある。保存できなくても、選んだ値は再読み込みまで効く（空の `catch {}` 7か所の理由） | 関数名と、テスト名「does not throw when the storage is unavailable (private window, blocked site data): the choice applies until the page is reloaded」 |
| `src/state/viewer-types.ts:CopcViewerState` | `canvasRef` を状態のオブジェクトに入れない。ref と状態を1つのオブジェクトに混ぜると、eslint-plugin-react-hooks の `react-hooks/refs` が描画中の状態の読み取りを誤検知する | ここ |
| `src/state/viewer-status.ts:ViewerStatus` | `enum` でなく文字列の `kind` の判別共用体にしたのは、`kind: "error"` だけが `message` を持てるようにするため。`strict` の下で `switch` が種類を漏らすと TS2366 でビルドが落ちるので、補助関数に `default:` を置かない | ここ |
| `src/state/useDisplaySettings.ts`（EDL の既定） | EDL を既定でオンにするのは、RGB の無い点群（sofi.copc.laz）の形が見えるようにするため。強さは UI に出さず `src/renderer/edl.ts` の `DEFAULT_EDL_STRENGTH` に固定 | ここ |
| `src/state/useDisplaySettings.ts`（自動点予算） | 自動調整は renderer の中で `pointBudget` を変えるので、画面の値は統計から写し戻す。手で変えたら自動を止めたことをすぐ画面に出す（次の統計まで最大 500 ms 待つと、黙って切り替わったように見える） | ここ |
| `src/state/useLayerTool.ts`・`useMeasureTool.ts`（クリックの判定） | 5px 以下の移動だけをクリックとし、ダブルクリックの2回目（`detail >= 2`）は無視する。計測ツールの完成品を触らないために、同じ判定を共有せず2か所に書いた。`dblclick` は capture で受けて止め、orbit-camera.ts のフライ移動を起こさない。多角形は画面の画素で持つので、カメラが動いたら描き直し | ここ |
| `src/state/useNarrowViewport.ts:useNarrowViewport` | 768px はタスクシートの指定値で、実測で決めた値ではない（未検証の初期値） | ここ |
| `src/ui/layers/LayerList.tsx`（長押しの時間・移動量）・`src/ui/toolbar/toolbar-drag.ts`（5px）・`src/ui/dialogs/Dialog.tsx`（閉じるアニメーションの時間）・`src/ui/layers/LayerPanel.tsx`（パネルの時間） | いずれも未検証の初期値。Dialog・LayerPanel の時間は index.css の `--motion-dialog-out`・`--motion-panel` と同じ値にしておく | ここ |
| `src/ui/common/glass.ts` | tint の不透明度（ライト 65%・ダーク 70%）は ADR-0005 のリスク2（点群の上でガラスが読めない）への設計時の判断で、fps は測っていない。モバイルでは backdrop-filter を切って不透明にする（毎フレームのぼかしが点群の描画と GPU を奪い合うため。所有者の Adreno 610） | ここ |
| `src/ui/toolbar/buttons/OpenFileButton.tsx` | `pickFilesToOpen()` はクリックの中で `await` より前に呼ぶ。後にするとブラウザがファイル選択を止める | ここ |
| `src/ui/toolbar/useToolbarDragScroll.ts` | ポインタキャプチャを使わない（click の宛先が変わり、閾値未満のクリックまで壊れうる）。縦ホイールを横スクロールにするのは `passive: false` が要るので React の `onWheel` でなく直接付ける | ここ |
| `src/ui/section/SectionPanel.tsx`（z-index） | 狭い画面ではレイヤーのドロワーの開閉ボタン（bottom-16、高さ 44px）の上・ドロワー（z-10）の下。拡大時はドロワー・ツールバーより上、進捗（z-30）・ダイアログ（z-40・z-50）より下 | ここ |
| `src/ui/tools/MeasureOverlay.tsx`・`SectionLineOverlay.tsx` | 計測線・断面線は WebGPU でなく SVG で描く（ラベルに DOM が要る、描き方を2系統にしない）。代わりに点群に隠れず常に手前に出る（受け入れ済み、TaskSheets/L2-layer-tools.md の L2-D の記録） | ここ |
| `src/ui/tools/RasterWindow.tsx`（プレビューの列の高さ） | ダイアログの本文の高さから絵以外（タイトル・フッター・余白・説明・凡例・注記）を引いた値は、1400×900 で測った約 300px に余裕を足したもの | ここ |
| `e2e/*.spec.ts:TIME_THE_RESULT_MUST_STAY_VISIBLE_MS` | 変換の完了直後に内訳とダウンロードが消える不具合があったので、表示された瞬間だけでなく 2 秒後も表示されていることを見る | 名前 |
| `e2e/web-point-file-conversion.spec.ts:buildSyntheticPly` | 1点は x/y/z の float 3つと r/g/b の uchar 3つで 15 バイト | 名前 `XYZ_FLOAT_BYTES`・`RGB_UCHAR_BYTES` |
| `scripts/make-test-las.ts:buildSyntheticLas` | LAS 1.2 のヘッダーの各欄の名前 | 欄の名前を引数に取る書き手 `lasFieldWriter`、`NO_VARIABLE_LENGTH_RECORDS`・`RETURN_NUMBER_1_OF_1_RETURNS`。出力のバイト列が前と同じことを確かめた（下の記録） |
| `scripts/check-adr.mjs`・`check-doc-paths.mjs`・`check-task-sheet.mjs`・`check-all.mjs` | 冒頭の説明（何を見るか・見ないもの・使い方） | `--help` の出力（`USAGE`）。`check-task-sheet.mjs` は引数が無いときもこれを出す |
| `scripts/check-adr.mjs:STRICT_SYMBOL_DISTANCE_LINES`・`WORDS_THAT_MATCH_ALMOST_ANY_FILE` | 厳しい検査で識別子を探す行の幅（20 行）、それだけでは何も証明しない語の一覧 | 名前（旧 `WINDOW`・`GENERIC`） |
| `scripts/check-all.mjs` | vitest は `c:\` の小文字のドライブ名から起動すると全ファイルが落ちる | 関数名 `withUpperCaseDriveLetterBecauseVitestFailsFromLowerCase` |
| `scripts/ui-shots.mjs`・`find-unused-ts.cjs`・`dtm-browser-check.mjs`・`thin-filter-browser-bench.mjs`・`bench/web-first-open.mjs` | 使い方・前提（preview を先に起動）・出力・見えないもの | 使い方のエラー（`--help` も）。`web-first-open.mjs` は引数が足りないとき使い方を出して終了コード 2 で止まる（前は `undefined` のまま進んだ） |
| `scripts/igpu-bench/bench.mjs` | https のページから http://127.0.0.1 を読むと、新しい Chromium は「ローカルネットワークへのアクセス」の許可待ちで止まる（開発機で確認） | 名前 `LET_THE_HTTPS_PAGE_READ_LOOPBACK_WITHOUT_A_PERMISSION_PROMPT`。使い方（ThinkBook のデスクトップから `cd C:\pcv-bench; node bench.mjs [セッション名]`。SSH からだと GPU が見えない）はここ |
| `scripts/diag-sky-ray.ts` | 空とグリッドの NaN の3世代（invViewProj を f32 で渡す／単位ベクトルを線形補間して長さが縮む／画素ごとに f64 の基底から組み立てる）。「NaN が出ない」は「値が正しい」ではない。閾値 F64 1e-6・F32 1e-4、世代1 の誤差は最大 0.16 程度。使い方 `npx tsx scripts/diag-sky-ray.ts` | ここ（経緯は TaskSheets/M2-shading-and-ui.md の M2-0c） |
| `scripts/diag-webgpu-headless.mjs` | ヘッドレス Chromium で WebGPU のアダプタが取れる起動フラグを CI の Linux で試すための診断。使い方 `node scripts/diag-webgpu-headless.mjs`（先に `npx playwright install --with-deps chromium`） | ここ |
| `playwright.config.ts` | `channel: "chromium"`: 既定の chrome-headless-shell は `requestAdapter()` が常に null。`--enable-unsafe-webgpu` は Windows・Linux の両方で動いた最小の構成（CI run 37792380083・37793228559）。Linux だけの4つの SwiftShader のフラグは GPU プロセスの "Target crashed" を止める（4つ一緒で 90 回中 0 回、単独で 30 回中 11〜17 回。TaskSheets/CI-e2e-gpu-crash.md）。Windows では `--use-angle=swiftshader` で null になる。127.0.0.1 を明示するのは、省略すると vite preview が IPv6 だけに bind することがあるため。サーバーを使い回さないのは、他のセッションの古いビルドを試験しないため。`GITHUB_PAGES_BUILD=true` で build→preview するのは本番と同じサブパスで試すため | 名前 `WEBGPU_IN_HEADLESS_CHROMIUM_ON_WINDOWS_AND_LINUX`・`LINUX_SWIFTSHADER_FLAGS_AGAINST_GPU_PROCESS_CRASHES`・`PREVIEW_HOST_IPV4_BECAUSE_VITE_MAY_BIND_ONLY_IPV6`・`NEVER_TEST_A_STALE_PREVIEW_SERVER`。残りはここ（ADR-0016） |
| `vite.config.ts` | `defineConfig` を "vitest/config" から取るのは `test` の型のため（`/// <reference>` は triple-slash-reference の lint に掛かる）。GitHub Pages はサブパスで配信。`clearScreen: false`・固定ポート 1420・`src-tauri` を監視しないのは Tauri の雛形の指定。vitest の `exclude` は既定を展開して足す（指定すると丸ごと上書きされる） | 名前 `GITHUB_PAGES_SUBPATH`・`AGENT_WORKTREES_THAT_COPY_THIS_REPOSITORY`・`PLAYWRIGHT_SPECS_RUN_BY_NPM_RUN_E2E`。残りはここ |
| `eslint.config.js` | パターンは import 文（no-restricted-imports）・動的 `import()`・型の `import()`・`require()`（no-restricted-syntax）の全部に展開する。ESLint は同じルールの設定を後勝ちで置き換えるので、ゾーンごとに全パターンを並べる。esquery の正規表現は `/` を含められないので `[/]` に直す | 既存の TaskSheets/RF-safety-net.md（`layerRules()`・`selectorRegex()`）、名前 `AGENT_WORKTREES_THAT_COPY_THIS_REPOSITORY` |
| `src/layer-rules.test.ts`（置き換えた grep） | RF-1 で置き換えた CI の grep: 規約2 `grep -rl "@tauri-apps/api" src/`、規約3・5 `grep -rlE "from ['\"]react(-dom)?(/[^'\"]*)?['\"]" src/renderer src/app`・`grep -rlE "from ['\"][^'\"]*state/use[A-Z][^'\"]*['\"]" src/app`・`find src/renderer src/app -name "*.tsx"` | ここと、テスト名「everything the old CI greps caught is still caught」 |
| `.github/workflows/ci.yml` | 全ブランチ・全 PR で走る（土台が main でない重ねた PR も単独で緑）。`fetch-depth: 0` は check:docs が base と比べるため。invariants は規約1（pcv-core が wasm32 でビルドできる、ADR-0001）。`vendor/copc-writer` はワークスペースの外なので fmt・test を別に走らせる（M4-8 で wasm32 の `Instant::now` の不具合が素通りした）。`disallowed_methods` はネイティブでは見ない（`web_time::Instant` が `std::time::Instant` の再エクスポートになり、正しいコードまで弾く）。e2e は他のジョブを待たない。ブラウザ本体はキャッシュし、`--with-deps` の apt はキャッシュしない。"Target crashed" の診断にマシン情報・`DEBUG=pw:browser`・OOM のログを残す。build は 13 秒の frontend だけを待ち、5 分超の rust は待たない。インストーラは作らない | ここ |
| `.github/workflows/pages.yml` | ci.yml と分けたのは rust・build ジョブ（windows-latest）に wasm32 と wasm-bindgen-cli の前提を混ぜないため（ADR-0012）。mdBook は `peaceiris/actions-mdbook` で入れ、本は dist/book/ にコピーして同じ成果物で公開。所有者が一度だけ Pages の Source を "GitHub Actions" にする。pcv-wasm は別ワークスペースなので rust-cache に別に教える。copc-writer の `disallowed_methods` は `--lib` だけ（`--all-targets` は criterion が wasm32 で通らない）・`-D clippy::disallowed_methods` だけ（`--no-default-features` で既存の dead-code 警告が多い）。wasm-bindgen CLI は Cargo.lock の版と完全一致が要るので Cargo.lock から読む。RF-15: コミットした JS グルーと型が今ビルドしたものと同じかを見る（.wasm は絶対パスを含むので比べない） | ここ |
| `.github/workflows/release.yml` | `workflow_dispatch` はタグ無しでビルドだけ試す経路（Release は作らない。APK は artifact に残し、保持は 90 日より短く）。タグと tauri.conf.json の版が違えば最初に落とす。署名しない（ADR-0004 追記4、SmartScreen の警告は本文に書く）。`contents: write` が無いと 403。成果物はワークスペース直下の `target/` に出る（v0.1.0 で `src-tauri/target/` を指定し、インストーラ抜きの Release が成功扱いになった）ので出力をログに残し、`fail_on_unmatched_files: true`。Android は aarch64 だけ。setup-android の既定の "tools" は削除済みなので "platform-tools" だけ。debug 鍵はキャッシュして使い回す（変わると上書きインストールできない）、無ければ AGP と同じ固定値で作る。`--debug` を付けない（Rust まで最適化なしになり LAZ 展開が遅い。493MB→6.8MB、run 35875956360）。署名前の APK は消す | ここ |
| `Cargo.toml` | `crates/pcv-wasm` はワークスペースに入れない（wasm-bindgen 系がネイティブの `--workspace` を壊す。ADR-0012）。copc-reader 0.9.0 は複数ページの hierarchy を開けない（ADR-0003 の追記）、copc-writer 0.9.0 は tempfile・memmap2 で wasm32 で動かない（M4-6a、vendor/copc-writer/PATCH.md）、laz は可変長チャンクのシーク（L2-G、vendor/laz/PATCH.md）。`panic = "unwind"` は `catch_unwind` で `pcv://` の読み出しを panic から戻すため（ADR-0013。バイナリは 4,328,448→11,416,576 バイト、ロガー追加と切り分けていない。Android の性能は未計測） | ここ |
| `.gitattributes` | `*.ui`・`*.generated.tsx` を LF に固定するのは、ui-forge が LF で正規化して書き出し、この PC の `core.autocrlf=true` だと CRLF になって検査が落ちるため（ADR-0014）。`*.wgsl` は CM-1 がシェーダーを `?raw` で読むので、Windows のチェックアウトで CRLF が混ざらないよう LF に固定した（コーディネーターの指示） | ここ |
| `scripts/bench/sampler.ps1`・`run-native.ps1` | CSV は桁区切り無し（PF-0 で "1,040" が2列に割れ、1 GiB 超の値が全部消えた）。サンプラーは E コア（0xFF000）に置き、測る側を P コア（0xFFF）に固定する。使い方 `run-native.ps1 -Exe <exe> -ArgLine <args> -Tag <name> -OutDir <dir> [-TempDir <dir>] [-MinFreeGB 25]`、`sampler.ps1 -RootPid <pid> -Csv <path>` | ここ |
| `scripts/download-tokyo-23ku-tiles.ps1`・`las-header-report.ps1`・`docs/video/tools/lib/tts.ps1` | 使い方（`-ListFile`・`-OutDir`・`-ExistingDir`、`-Dir`・`-ListFile`、`-Text`・`-OutPath`）。図郭1枚は zip 約 0.12GB＋展開 約 0.2GB、並列分に +2GB。出典は東京都デジタルツイン実現プロジェクト「区部点群データ」（CC BY 4.0）。tts は WinRT の SpeechSynthesis（PowerShell 5.1 に await が無いので Task 経由） | ここ |
| `docs/video/tools/*.mjs` | 撮影の事故の回避（設定の変更は録画の外、CDP screencast を変換中に止める、`stopScreencast` が固まるので上限で諦める、scale/pad の幅と高さは別の引数、ffmpeg の stdin を切る）。経緯は TaskSheets/VIDEO-intro.md | 名前 `SHOW_THE_FIRST_LOAD_STALLING_MS`・`PCD_CONVERSION_IN_THE_BROWSER_TOOK_OVER_3_MIN_SO_WAIT_MS`・`turnEdlOffFromItsDefaultOn`。残りはここ |

## 記録

### 実装の記録 R1（作業役）

#### やったこと

- 範囲のコメントを全部消した。検査の対象の数（`scripts/comment-baseline.json`）で 1,842（範囲の 169 ファイル。12,261 → 10,419）。検査の対象外だったもの: `docs/video/tools/*.mjs` 12 ファイルの 173（CM-0 R2 で対象になる。base の d05c858 の baseline には無い）、`tsconfig.json` の 2、YAML・TOML・`.gitattributes`・PowerShell の `#` の行 328 行
- 残したのは CM-0 の「例外」だけ（`eslint-disable*`・`@ts-expect-error`・`@vitest-environment`・shebang。範囲の .ts/.tsx/.js/.mjs/.cjs で 29 行）
- 消し方: 一時的なスクリプト（コミットしていない）で、`scripts/check-comments.mjs` の `findScriptCommentRanges` が返す範囲を消した。行全体がコメントなら行ごと、行末なら前の空白ごと、JSX の `{/* */}` は波括弧ごと消し、空行が2つ続く・開き括弧の直後・閉じ括弧の直前の空行・ファイル先頭の空行が増えていないことを、base との比較で確かめた（増えた所は 0）。`LayerList.tsx` の三項演算子の `:` の後に残った改行は手で詰めた
- 名前と関数への切り出し（振る舞いは変えない）は上の「移した理由の記録」の表のとおり。既存の識別子で名前を変えたのは `scripts/check-adr.mjs` の `WINDOW`→`STRICT_SYMBOL_DISTANCE_LINES`（宣言＋使い手 3）・`GENERIC`→`WORDS_THAT_MATCH_ALMOST_ANY_FILE`（宣言＋使い手 1）だけで、どちらも export していない（`grep -rn "\bWINDOW\b\|\bGENERIC\b" scripts/` で check-adr.mjs の外に 0 件）。ほかは新しく足した定数・関数
- `saveSettingIfStorageAllows`（`src/state/setting-storage.ts`、テスト `setting-storage.test.ts`）: コメントを消すと `catch { /* … */ }` が空になり ESLint の `no-empty` で落ちたので、7 か所（`dtm-setting.ts`・`motion-setting.ts`・`useDisplayUnit.ts`・`useTempDir.ts`・`useTheme.ts` の書き込み・`useUpdateCheck.ts`）をこの関数に出した。`useTheme.ts` の読み取りの空の `catch` は `return "system"`（直後の `return` と同じ値）にした
- `scripts/make-test-las.ts`: ヘッダーの各欄の名前がコメントにしか無かったので、欄の名前を引数に取る書き手 `lasFieldWriter` で書き直した。出力が前と同じことを確かめた（一時的なスクリプトで d05c858 版と比べ、`{}` と `{ pointCount: 300, seed: 7, offsetX: 1000, offsetY: -5, offsetZ: 3 }` の両方で `identical`）
- 検査のスクリプトの冒頭の説明は `--help`（`USAGE`）に移した: `check-adr.mjs`・`check-doc-paths.mjs`・`check-task-sheet.mjs`（引数が無いときも出す）・`check-all.mjs`。ほかの道具は使い方のエラーに移した（`ui-shots.mjs`・`find-unused-ts.cjs` は `--help` も）
- 振る舞いが変わる所（使い方の誤りのときだけ）: `scripts/bench/web-first-open.mjs` は引数が足りないと使い方を出して終了コード 2 で止まる（前は `undefined` のまま Chromium を起動した）。各スクリプトの `--help` は新しい
- `src/code-limits.test.ts` は冒頭のコメントなどだけを消し、BASELINE の行は触っていない（CM-1・CM-2 も直すため）。BASELINE に範囲のファイルは無い
- ADR の `path:line` の参照（ADR-0024）に範囲のファイルは無いので、直す所は無かった（`grep -n '`[a-z].*:[0-9]' TaskSheets/ADR-0024-progressive-open.md` で見た）
- コーディネーターの追加の指示で `.gitattributes` に `*.wgsl text eol=lf` を足した（別コミット）

#### 採らなかった案

- 空の `catch` を許すため ESLint の `no-empty` に `allowEmptyCatch` を足す: 「保存できなくても続ける」理由がどこにも残らないので、関数名とテスト名に出した
- YAML のステップに `name:` を足して理由を書く: 文が長くなり、ログの見出しが読みにくくなるので、理由は上の表に移した
- 設定ファイルの理由を ADR-0016・ADR-0012・ADR-0013・M3 のシートに分けて書き足す: 範囲の外の文書を触ることになり、既に書いてあるかを1件ずつ確かめる手間に見合わないので、この表に集めた

#### 触ったファイル

- `src/app/`・`src/state/`・`src/ui/` の範囲のファイル、`src/code-limits.test.ts`・`src/layer-rules.test.ts`、新規 `src/state/setting-storage.ts`・`setting-storage.test.ts`
- `e2e/*.spec.ts`、`scripts/` の .ts/.mjs/.cjs/.ps1（`check-comments.mjs`・`check-comments.test.mjs` はもともと 0）、`scripts/comment-baseline.json`
- `docs/video/tools/` の .mjs と `lib/tts.ps1`
- `eslint.config.js`・`vite.config.ts`・`playwright.config.ts`・`tsconfig.json`・`.github/workflows/ci.yml`・`pages.yml`・`release.yml`・`Cargo.toml`・`.gitattributes`
- このシートの記録

#### 確かめ方

- `npm run check:comments` が OK で、`node -e` で baseline の範囲の項目が 0 件
- YAML・TOML・`.gitattributes`・PowerShell の残り: `grep -n -E '^\s*#([^!]|$)|\s#\s' .github/workflows/ci.yml .github/workflows/pages.yml .github/workflows/release.yml Cargo.toml .gitattributes scripts/download-tokyo-23ku-tiles.ps1 scripts/las-header-report.ps1 scripts/bench/run-native.ps1 scripts/bench/sampler.ps1 docs/video/tools/lib/tts.ps1` が 0 件（終了コード 1）。消したのは行頭が `#` の行だけで、`run: |`・`body: |` の中の本文は変わっていない（base の行と比べた）
- `npm run check:all`、`node scripts/check-task-sheet.mjs d05c858`
- 確かめていないこと: CI のワークフロー（YAML のコメントの行を消しただけだが、GitHub 上で走らせていない）、E2E（`npx playwright test --list` で 6 件が読み込めることだけ見た）、`docs/video/tools` の撮影（`node --check` だけ）、`scripts/igpu-bench/bench.mjs`・`dtm-browser-check.mjs`・`thin-filter-browser-bench.mjs`・`ui-shots.mjs` の実行（使い方の表示だけ見た）、PowerShell のスクリプトの実行
