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
| `src/app/dtm.ts:landXmlUnitFor` | 国際フィートと米国測量フィートの差は 6e-7 なので、許容差はそれより細かくする | ここ（名前は `UNIT_FACTOR_TOLERANCE`） |
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
| `e2e/*.spec.ts:STILL_VISIBLE_WAIT_MS` | 変換の完了直後に内訳とダウンロードが消える不具合があったので、表示された瞬間だけでなく 2 秒後も表示されていることを見る | ここ（名前は `STILL_VISIBLE_WAIT_MS`） |
| `e2e/web-point-file-conversion.spec.ts:buildSyntheticPly` | 1点は x/y/z の float 3つと r/g/b の uchar 3つで 15 バイト | 名前 `XYZ_FLOAT_BYTES`・`RGB_UCHAR_BYTES` |
| `scripts/make-test-las.ts:buildSyntheticLas` | LAS 1.2 のヘッダーの各欄の名前 | 欄の名前を引数に取る書き手 `lasFieldWriter`、`NO_VARIABLE_LENGTH_RECORDS`・`RETURN_NUMBER_1_OF_1_RETURNS`。出力のバイト列が前と同じことを確かめた（下の記録） |
| `scripts/check-adr.mjs`・`check-doc-paths.mjs`・`check-task-sheet.mjs`・`check-all.mjs` | 冒頭の説明（何を見るか・見ないもの・使い方） | `--help` の出力（`USAGE`）。`check-task-sheet.mjs` は引数が無いときもこれを出す |
| `scripts/check-adr.mjs:STRICT_SYMBOL_DISTANCE_LINES`・`GENERIC_WORDS` | 厳しい検査で識別子を探す行の幅（20 行）、それだけでは何も証明しない語の一覧 | 名前（旧 `WINDOW`・`GENERIC`） |
| `scripts/check-all.mjs` | vitest は `c:\` の小文字のドライブ名から起動すると全ファイルが落ちる | ここ（名前は `withUpperCaseDriveLetter`） |
| `scripts/ui-shots.mjs`・`find-unused-ts.cjs`・`dtm-browser-check.mjs`・`thin-filter-browser-bench.mjs`・`bench/web-first-open.mjs` | 使い方・前提（preview を先に起動）・出力・見えないもの | 使い方のエラー（`--help` も）。`web-first-open.mjs` は引数が足りないとき使い方を出して終了コード 2 で止まる（前は `undefined` のまま進んだ） |
| `scripts/igpu-bench/bench.mjs` | https のページから http://127.0.0.1 を読むと、新しい Chromium は「ローカルネットワークへのアクセス」の許可待ちで止まる（開発機で確認） | ここ（名前は `LOCAL_NETWORK_CHECKS_OFF`）。使い方（ThinkBook のデスクトップから `cd C:\pcv-bench; node bench.mjs [セッション名]`。SSH からだと GPU が見えない）はここ |
| `scripts/diag-sky-ray.ts` | 空とグリッドの NaN の3世代（invViewProj を f32 で渡す／単位ベクトルを線形補間して長さが縮む／画素ごとに f64 の基底から組み立てる）。「NaN が出ない」は「値が正しい」ではない。閾値 F64 1e-6・F32 1e-4、世代1 の誤差は最大 0.16 程度。使い方 `npx tsx scripts/diag-sky-ray.ts` | ここ（経緯は TaskSheets/M2-shading-and-ui.md の M2-0c） |
| `scripts/diag-webgpu-headless.mjs` | ヘッドレス Chromium で WebGPU のアダプタが取れる起動フラグを CI の Linux で試すための診断。使い方 `node scripts/diag-webgpu-headless.mjs`（先に `npx playwright install --with-deps chromium`） | ここ |
| `playwright.config.ts` | `channel: "chromium"`: 既定の chrome-headless-shell は `requestAdapter()` が常に null。`--enable-unsafe-webgpu` は Windows・Linux の両方で動いた最小の構成（CI run 37792380083・37793228559）。Linux だけの4つの SwiftShader のフラグは GPU プロセスの "Target crashed" を止める（4つ一緒で 90 回中 0 回、単独で 30 回中 11〜17 回。TaskSheets/CI-e2e-gpu-crash.md）。Windows では `--use-angle=swiftshader` で null になる。127.0.0.1 を明示するのは、省略すると vite preview が IPv6 だけに bind することがあるため。サーバーを使い回さないのは、他のセッションの古いビルドを試験しないため。`GITHUB_PAGES_BUILD=true` で build→preview するのは本番と同じサブパスで試すため | ここと ADR-0016（名前は `WEBGPU_FLAG`・`LINUX_SWIFTSHADER_FLAGS`・`PREVIEW_HOST`。`reuseExistingServer` はリテラルの `false`） |
| `vite.config.ts` | `defineConfig` を "vitest/config" から取るのは `test` の型のため（`/// <reference>` は triple-slash-reference の lint に掛かる）。GitHub Pages はサブパスで配信。`clearScreen: false`・固定ポート 1420・`src-tauri` を監視しないのは Tauri の雛形の指定。vitest の `exclude` は既定を展開して足す（指定すると丸ごと上書きされる）。`.claude/**`（`AGENT_WORKTREES`）を除くのは、エージェントの worktree がこのリポジトリの全部の写しで、ルートで `npm test` を走らせるとテストが二重に数えられるため。`e2e/**`（`PLAYWRIGHT_SPECS`）を除くのは、Playwright の `*.spec.ts` が vitest の既定のパターンにも合い、`npm test` が「test() をここで呼べない」で落ちるため | ここ（名前は `GITHUB_PAGES_SUBPATH`・`AGENT_WORKTREES`・`PLAYWRIGHT_SPECS`） |
| `eslint.config.js` | パターンは import 文（no-restricted-imports）・動的 `import()`・型の `import()`・`require()`（no-restricted-syntax）の全部に展開する。ESLint は同じルールの設定を後勝ちで置き換えるので、ゾーンごとに全パターンを並べる。esquery の正規表現は `/` を含められないので `[/]` に直す。`.claude`（`AGENT_WORKTREES`）を無視するのは、エージェントの worktree がこのリポジトリの全部の写しで、lint が全ファイルを二重に見るため | 既存の TaskSheets/RF-safety-net.md（`layerRules()`・`selectorRegex()`）とここ |
| `src/layer-rules.test.ts`（置き換えた grep） | RF-1 で置き換えた CI の grep: 規約2 `grep -rl "@tauri-apps/api" src/`、規約3・5 `grep -rlE "from ['\"]react(-dom)?(/[^'\"]*)?['\"]" src/renderer src/app`・`grep -rlE "from ['\"][^'\"]*state/use[A-Z][^'\"]*['\"]" src/app`・`find src/renderer src/app -name "*.tsx"` | ここと、テスト名「everything the old CI greps caught is still caught」 |
| `.github/workflows/ci.yml` | 全ブランチ・全 PR で走る（土台が main でない重ねた PR も単独で緑）。`fetch-depth: 0` は check:docs が base と比べるため。invariants は規約1（pcv-core が wasm32 でビルドできる、ADR-0001）。`vendor/copc-writer` はワークスペースの外なので fmt・test を別に走らせる（M4-8 で wasm32 の `Instant::now` の不具合が素通りした）。`disallowed_methods` はネイティブでは見ない（`web_time::Instant` が `std::time::Instant` の再エクスポートになり、正しいコードまで弾く）。e2e は他のジョブを待たない。ブラウザ本体はキャッシュし、`--with-deps` の apt はキャッシュしない。"Target crashed" の診断にマシン情報・`DEBUG=pw:browser`・OOM のログを残す。build は 13 秒の frontend だけを待ち、5 分超の rust は待たない。インストーラは作らない | ここ |
| `.github/workflows/pages.yml` | ci.yml と分けたのは rust・build ジョブ（windows-latest）に wasm32 と wasm-bindgen-cli の前提を混ぜないため（ADR-0012）。mdBook は `peaceiris/actions-mdbook` で入れ、本は dist/book/ にコピーして同じ成果物で公開。所有者が一度だけ Pages の Source を "GitHub Actions" にする。pcv-wasm は別ワークスペースなので rust-cache に別に教える。copc-writer の `disallowed_methods` は `--lib` だけ（`--all-targets` は criterion が wasm32 で通らない）・`-D clippy::disallowed_methods` だけ（`--no-default-features` で既存の dead-code 警告が多い）。wasm-bindgen CLI は Cargo.lock の版と完全一致が要るので Cargo.lock から読む。RF-15: コミットした JS グルーと型が今ビルドしたものと同じかを見る（.wasm は絶対パスを含むので比べない） | ここ |
| `.github/workflows/release.yml` | `workflow_dispatch` はタグ無しでビルドだけ試す経路（Release は作らない。APK は artifact に残し、保持は 90 日より短く）。タグと tauri.conf.json の版が違えば最初に落とす。署名しない（ADR-0004 追記4、SmartScreen の警告は本文に書く）。`contents: write` が無いと 403。成果物はワークスペース直下の `target/` に出る（v0.1.0 で `src-tauri/target/` を指定し、インストーラ抜きの Release が成功扱いになった）ので出力をログに残し、`fail_on_unmatched_files: true`。Android は aarch64 だけ。setup-android の既定の "tools" は削除済みなので "platform-tools" だけ。debug 鍵はキャッシュして使い回す（変わると上書きインストールできない）、無ければ AGP と同じ固定値で作る。`--debug` を付けない（Rust まで最適化なしになり LAZ 展開が遅い。493MB→6.8MB、run 35875956360）。署名前の APK は消す | ここ |
| `Cargo.toml` | `crates/pcv-wasm` はワークスペースに入れない（wasm-bindgen 系がネイティブの `--workspace` を壊す。ADR-0012）。copc-reader 0.9.0 は複数ページの hierarchy を開けない（ADR-0003 の追記）、copc-writer 0.9.0 は tempfile・memmap2 で wasm32 で動かない（M4-6a、vendor/copc-writer/PATCH.md）、laz は可変長チャンクのシーク（L2-G、vendor/laz/PATCH.md）。`panic = "unwind"` は `catch_unwind` で `pcv://` の読み出しを panic から戻すため（ADR-0013。バイナリは 4,328,448→11,416,576 バイト、ロガー追加と切り分けていない。Android の性能は未計測） | ここ |
| `.gitattributes` | `*.ui`・`*.generated.tsx` を LF に固定するのは、ui-forge が LF で正規化して書き出し、この PC の `core.autocrlf=true` だと CRLF になって検査が落ちるため（ADR-0014）。`*.wgsl` は CM-1 がシェーダーを `?raw` で読むので、Windows のチェックアウトで CRLF が混ざらないよう LF に固定した（コーディネーターの指示） | ここ |
| `scripts/bench/sampler.ps1`・`run-native.ps1` | CSV は桁区切り無し（PF-0 で "1,040" が2列に割れ、1 GiB 超の値が全部消えた）。サンプラーは E コア（0xFF000）に置き、測る側を P コア（0xFFF）に固定する。使い方 `run-native.ps1 -Exe <exe> -ArgLine <args> -Tag <name> -OutDir <dir> [-TempDir <dir>] [-MinFreeGB 25]`、`sampler.ps1 -RootPid <pid> -Csv <path>` | ここ |
| `scripts/download-tokyo-23ku-tiles.ps1`・`las-header-report.ps1`・`docs/video/tools/lib/tts.ps1` | 使い方（`-ListFile`・`-OutDir`・`-ExistingDir`、`-Dir`・`-ListFile`、`-Text`・`-OutPath`）。図郭1枚は zip 約 0.12GB＋展開 約 0.2GB、並列分に +2GB。出典は東京都デジタルツイン実現プロジェクト「区部点群データ」（CC BY 4.0）。tts は WinRT の SpeechSynthesis（PowerShell 5.1 に await が無いので Task 経由） | ここ |
| `docs/video/tools/*.mjs` | 撮影の事故の回避（設定の変更は録画の外、CDP screencast を変換中に止める、`stopScreencast` が固まるので上限で諦める、scale/pad の幅と高さは別の引数、ffmpeg の stdin を切る）。`FIRST_LOAD_PAUSE_MS`（800 ms）は最初の読み込みの詰まりを少し見せるため。`PCD_CONVERSION_TIMEOUT_MS`（10 分）はブラウザでの PCD の変換が実測で 3 分を超えたことがあるため。`turnEdlOff` は EDL が既定でオンなので、最初の1回の切り替えでオフになる。経緯は TaskSheets/VIDEO-intro.md | ここ |
| `src/app/section-3d.ts:sectionAxes` | Rust の `SectionAxes::new`（`crates/pcv-core/src/profile.rs`）と `sectionBox`（`src/state/tool-math.ts`）と同じ組み立てでないと、パネルの `(s, z)` と 3D の線がずれる | テスト「matches SectionAxes of crates/pcv-core/src/profile.rs and sectionBox of src/state/tool-math.ts, so the panel's (s, z) and the 3D line agree」（期待値は Rust の式 `along` = A→B から `up` の成分を除いた単位ベクトル、`z = dot(p, up)` で手で求めた） |
| `src/ui/shell/AppShell.tsx:layerPanelStartsOpen` | 狭い画面ではドロワーが点群を覆うので最初は閉じる。広い画面で最初から開くのは、E2E がデスクトップ幅で「変換の内訳」（`conversion-breakdown`）の表示を待つため | ここ（名前は `layerPanelStartsOpen`） |
| `src/ui/common/portal-target.ts:portalOutsideLayerPanel`（新規。`LayerActions.tsx`・`LayerContextMenu.tsx`） | レイヤーパネルは transform で滑って出入りするので、中に置くと `position: fixed` の基準がパネルになる。それを避けて `document.body` に portal で出す | ここ（名前は `portalOutsideLayerPanel`） |
| `src/state/useCopcViewer.ts`（型の再エクスポート） | 消したコメントは「src/ui が renderer・datasource の型を state 経由で受け取るため（規約3）の再エクスポート」と書いていたが、d05c858 の時点で再エクスポートは `CopcViewerState` だけで、古くなっていた。src/ui は `CopcViewerState` を `useCopcViewer` から import する | ここ |
| `src/app/open-files.ts:OpenFilesContext.setConversionProgress`・`setConvertingFileName` | 進捗とファイル名を `ViewerStatus` の `converting` に入れない（R5）。Web の進捗（"preparing"）は状態が "converting" に変わる前に届くことがあり、失えない。ダイアログは変換が終わった後（"ready"）もファイル名を出し、ファイル名は状態がまだ "opening" のうちに決まる | ここ |
| `src/app/point-cloud-tools.ts:computeSectionLine`・`src/state/layers.ts:SectionInfo.sourceLayerId` | 断面の地表線は、薄く切り出したレイヤーでなく元のレイヤー（`sourceLayerId`）の点から計算する。cloth の計算には線の周りの点が要り、薄い切り出しには無い | ここ |
| `src/ui/settings/pages/RenderScaleDialog.tsx:RENDER_SCALE_CHOICES` | 自由入力にせず決め打ちの選択肢にしたのは、0 や負の値で画面が壊れるのを避けるため | ここ（名前は `RENDER_SCALE_CHOICES`。旧 `RENDER_SCALE_OPTIONS`、使い手 1） |
| `src/state/useCopcViewer.ts`（`status`・クリップボード・`setInitError`） | `status` は、ほとんどの hook が書くので `useCopcViewer` に置く。内訳のコピーは `navigator.clipboard` が無い（HTTPS でない等）と失敗するが、画面を壊さずログだけにする。`setInitError` は effect が依存するので安定させる | ここ |
| `src/state/useFileOpen.ts`・`usePointCloudTools.ts`・`useSectionView.ts`（コンテキスト） | コンテキストは描画のたびに作り直し、イベントの手順が拾った時点の値を使う。ref の getter は呼んだときに読む（ref は最初の描画の後に埋まる）。ロック（`openLock`・`toolLock`）とセクションの読み込みの番号は、アプリの間ずっと1つのオブジェクトで、後の描画で作ったコンテキストとも共有する | ここ |
| `src/app/section-view.ts:openSectionPanel`・ポインタの処理 | ツールが終わるのは始まってから長い後なので、コンテキストは古い描画のものでよいように getter・setter・番号だけを読み、状態の値は読まない。パンは押した位置を基準にするので、パンになる前の移動も含める | ここ |
| `src/app/section-math.ts:TOUCH_LONG_PRESS_MS` | 指の長押し（500 ms）はマウス（300 ms）より少し長くして誤操作を避ける | ここ |
| `src/state/useRendererLifecycle.ts` | `rendererRef`・`sourceRef` を `useCopcViewer` で作るのは、`useDisplaySettings` が `rendererRef` を、このフックがその `onStats` を要るため。effect は1回だけ走るので、渡すコールバックは安定していなければならない。WebSource と TauriSource を選ぶのはここだけ（ADR-0012） | ここ |
| `src/state/useLayers.ts:nextLayerId` | 番号は消したレイヤーの分も再利用しない（renderer のキーがぶつからないように）。一覧は React の state と ref の2つに持ち、書くのは `commitLayers` だけ | ここ |
| `src/state/measure.ts` | 面積は重心を引いてから靴紐の公式で計算する（60 万台の座標で二乗が大きくなり精度が落ちないように）。水平成分は二乗の差でなく直接組み立てる（桁落ちが少ない） | ここ |
| `src/state/tool-math.ts:projectToNdc` | renderer の `viewProj` は原点のずらしを含まない（ノードごとに f32 でかける）ので、そのまま Rust に送れる | ここ |
| `src/state/units.ts` | 単位が不明（null）のときは換算せず、数値に「座標の単位（m かどうか不明）」を添える。m と書かない | ここ |
| `src/state/useTheme.ts` | 既定は OS に従う（ADR-0005）。設定で手動に固定できるのは、所有者が実機で両テーマを見比べるため（エージェントは OS のモードを切り替えて確かめられない）。ADR の決定は覆していない | ここ |
| `src/state/useUpdateCheck.ts` | 署名鍵を作らない（ADR-0004 追記4）ので、デスクトップも Android と同じ「GitHub Releases を fetch → 同意したらリリースページを開く」。`tauri dev` では確認しない。`checkingEnabled` は state にせず毎回導出する（effect の中で同期の setState を避ける。react-hooks/set-state-in-effect）。オフラインで失敗しても起動は止めない | ここ |
| `src/ui/common/useTransitionMount.ts`・`src/ui/shell/AppShell.tsx`（前回の値との比較） | 閉じるアニメーションを見せるため、DOM に居る（`mounted`）と見せている（`shown`）を分ける。開くときは2回の rAF で別のフレームにしてから `shown` にする。「変換が始まった」「新しいエラー」の検出は、effect で setState せず、前回の値を state に持って描画中に比べる（React の推奨。set-state-in-effect を避ける） | ここ |
| `src/ui/dialogs/Dialog.tsx` | 暗幕のクリックで閉じるのは mousedown と click の両方が暗幕の上のときだけ（パネルで押して外で離すテキスト選択・スライダーでは閉じない）。Esc はパネルに付けるので、重なっても最前面だけが閉じる。モバイル（`glassEnabled=false`）ではぼかしを切る（GPU に重い）。上端線の色のクラス名は文字列のまま書く（Tailwind が検出できるように） | ここ |
| `src/ui/layers/LayerList.tsx`（左線） | 選択の有無で左線の太さが変わると文字がずれるので、全行に同じ太さの左線を付け、選択していない行は透明にする | ここ |
| `src/ui/layers/LayerPanel.tsx` | パネルと開閉ボタンは絶対配置＋transform で動かす（flex だとパネルが DOM から消えた瞬間にボタンが飛ぶ）。狭い画面のドロワーでガラスが読みにくいリスク（ADR-0005）は、点群がほぼ覆われるので小さいと判断した（未検証） | ここ |
| `src/ui/dialogs/ColorModeDialog.tsx` | 消したコメントは「`colormap.ts` の `COLOR_MODES` の並びに合わせてある」と書いていたが、`COLOR_MODES` は今は無い（古くなっていた）。並びは `ColorMode` 型（`src/renderer/colormap.ts`）の並びと同じ | ここ |
| `src/ui/dialogs/ConversionDialog.tsx` | 「開く」ボタンを置かない。変換の結果は完了時に `openFiles` がそのままレイヤーに足すので、押せるボタンが何もしないと紛らわしい | ここ |
| `src/ui/settings/pages/EdlDialog.tsx`・`AppearanceDialog.tsx` | EDL は画面全体にかける処理でレイヤーごとにできないので設定に置く。強さの setter は無い（`src/renderer/edl.ts` の固定値）ので、オン・オフだけ | ここ |
| `src/ui/settings/pages/StorageDialog.tsx` | UI は datasource を直接触らない規約なので、バイトの表示用の整形はここに閉じる | ここ |
| `src/ui/shell/UnsupportedDeviceScreen.tsx` | WebGL2 のフォールバックを書かない（ADR-0002）ので、WebGPU が無いと何も描けない。白い画面と区別するため、条件と診断情報を出す | ここ |
| `src/ui/layers/LayerStatsDetails.tsx` | 詳細の統計は1行のステータスバーに収まらないので、左パネルの折りたたみ（既定で閉じる）に残す（既存の機能を全部届く所に置く要求） | ここ |
| `src/ui/status/StatusBar.tsx` | 「進捗」は変換中は変換の割合、それ以外はノードの読み込み数を出す。変換中はクリックで変換ダイアログを開き直せる（外側クリック・Esc で閉じても変換は続く） | ここ |
| `src/ui/settings/pages.test.tsx`・`src/ui/dialogs/LayerViewDialogs.test.tsx` | React は value をプロトタイプの setter 経由で追うので、テストは同じ経路で値を入れてから input イベントを送る | ここ |
| `src/app/section-export.ts:sectionLineWorldPoints` | 書き出す `z` は `up` に沿った絶対の高さ（profile.rs の `project` は `dot(p, up)` で原点を引かない）で、パネルの GL の表示と同じ値なのでそのまま書く。X・Y は `A + s * along` を f64 で求め、ファイルの単位のまま（m・ft に換算しない） | ここ |
| `src/app/section-view.ts`（押している指・ボタンの記録） | 押しているポインタの記録はポインタの速さで変わるので、React の state でなく普通のオブジェクトに置く | ここ |
| `src/state/useDisplaySettings.ts`（端末ごとの既定値） | renderer のコンストラクタと同じ純粋関数を同じ入力で呼ぶので、握手なしで既定値が一致する。初期化関数として渡し、描画のたびに計算し直さない。自動点予算の既定（オン）は renderer の既定と同じ | ここ（設計書 `docs/book/src/frontend/state.md` の「端末ごとの既定値」の行にもある） |
| `src/state/useFileDrop.ts` | 最新の `openFiles` を ref で持つ。effect は1回だけ購読し、呼ぶときはいつも最新を呼ぶ | ここ |
| `src/state/dtm-setting.ts`・`src/ui/settings/pages/DtmOutputDialog.tsx` | DTM の出力形式は DTM のダイアログでなく設定で選ぶ（所有者の答え Q18） | ここ |
| `src/app/view.ts:ViewContext` | 投影の種類はストアが持ち、`setProjection` が renderer に伝える一方向。renderer から種類を返すことはない | ここ |

## 記録

### 実装の記録 R1（作業役）

#### やったこと

- 範囲のコメントを全部消した。検査の対象の数（`scripts/comment-baseline.json`）で 1,842（範囲の 169 ファイル。12,261 → 10,419）。検査の対象外だったもの: `docs/video/tools/*.mjs` 12 ファイルの 173（CM-0 R2 で対象になる。base の d05c858 の baseline には無い）、`tsconfig.json` の 2、YAML・TOML・`.gitattributes`・PowerShell の `#` の行 328 行
- 残したのは CM-0 の「例外」だけ（`eslint-disable*`・`@ts-expect-error`・`@vitest-environment`・shebang。範囲の .ts/.tsx/.js/.mjs/.cjs で 29 行）
- 消し方: 一時的なスクリプト（コミットしていない）で、`scripts/check-comments.mjs` の `findScriptCommentRanges` が返す範囲を消した。行全体がコメントなら行ごと、行末なら前の空白ごと、JSX の `{/* */}` は波括弧ごと消し、空行が2つ続く・開き括弧の直後・閉じ括弧の直前の空行・ファイル先頭の空行が増えていないことを、base との比較で確かめた（増えた所は 0）。`LayerList.tsx` の三項演算子の `:` の後に残った改行は手で詰めた
- 名前と関数への切り出し（振る舞いは変えない）は上の「移した理由の記録」の表のとおり。既存の識別子で名前を変えたのは `scripts/check-adr.mjs` の `WINDOW`→`STRICT_SYMBOL_DISTANCE_LINES`（宣言＋使い手 3）・`GENERIC`→`GENERIC_WORDS`（宣言＋使い手 1）だけで、どちらも export していない（`grep -rn "\bWINDOW\b\|\bGENERIC\b" scripts/` で check-adr.mjs の外に 0 件）。ほかは新しく足した定数・関数
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

### 監査の指摘への対応 R2（作業役）

- F-1（must、消えた「なぜ」）: 指摘の7件を直した。
  1. `sectionAxes` は、Rust と同じ式で手で求めた期待値と `sectionBox` の軸の両方に合うことを確かめるテストを `src/app/section-3d.test.ts` に足した（名前に「matches SectionAxes of crates/pcv-core/src/profile.rs」）。Rust 側に同じ入力のテストを足すのは CM-4 の範囲なので足していない
  2. `layerPanelStartsOpen`（関数名）と表（E2E の理由）
  3. `portalOutsideLayerPanel`（`src/ui/common/portal-target.ts`、使い手 2）
  4・5・6 は表（4 は消したコメント自体が古くなっていた）
  7. `RENDER_SCALE_OPTIONS`→`RENDER_SCALE_CHOICES`（使い手 1）
  - 見直し: `git diff d05c858 -U0 -- src/state src/ui src/app` の消した行のうち、because・ため・ので・never・must・otherwise・so that・avoid・避け・未検証・measured・実測 を含む 151 行を読み、コードから読めない理由を表に 23 行足した（上の表の `src/state/useCopcViewer.ts`（`status`…）の行から下）。ほかは「何をするか」の説明で、名前・型・テスト名で読めると判断した
  - 名前の無い数値: `C:\workspace\pcv-wt-CM-5\scripts\removed-comments-near-literals.mjs d05c858 src/app src/state src/ui` を読み取りだけで使った（このブランチにはコピーしていない）。本番のコードで理由が抜けていたもの（`TOUCH_LONG_PRESS_MS`・Dialog の色のクラス名）を表に足した。テストの中の数値は入力のデータなので残した
- F-2（should、消したコメントを指す文書）: `docs/book/src/frontend/state.md` の「各 hook の先頭のコメントを読めば」（79 行目）を引数の型と F12 で辿る説明に、「まず読むファイル」（119 行目）を表の「入口」の列を指す文に書き換えた。`TaskSheets/ADR-0016-e2e-web-conversion.md` の「`ci.yml` の `rust` ジョブのコメント」をこのシートの表の ci.yml の行に向けた。`docs/book/src/rust/pcv-convert.md:151` は CM-5 の範囲なので触っていない
- F-3（nit）: `saveSettingIfStorageAllows` の `catch` を `catch { return; }` にした

### 再発防止 CM-3-RP R1（作業役）

- F-4（should、長い名前）: 理由まで入れた名前 17 個を「何か」だけの短い名前にした。理由は上の表にあることを1行ずつ確かめ、無かったもの（vite・eslint の `.claude`・`e2e` の除外、capture-app の待ち時間と EDL）は表に足した。表の「移し先」は「ここ（名前は …）」に直した。R1・R2 の記録の中の名前も今の名前に置き換えてある
  - `UNIT_FACTOR_TOLERANCE_FINER_THAN_THE_6E7_GAP_BETWEEN_THE_FEET`→`UNIT_FACTOR_TOLERANCE`、`TIME_THE_RESULT_MUST_STAY_VISIBLE_MS`→`STILL_VISIBLE_WAIT_MS`、`WORDS_THAT_MATCH_ALMOST_ANY_FILE`→`GENERIC_WORDS`、`withUpperCaseDriveLetterBecauseVitestFailsFromLowerCase`→`withUpperCaseDriveLetter`、`LET_THE_HTTPS_PAGE_READ_LOOPBACK_WITHOUT_A_PERMISSION_PROMPT`→`LOCAL_NETWORK_CHECKS_OFF`、`WEBGPU_IN_HEADLESS_CHROMIUM_ON_WINDOWS_AND_LINUX`→`WEBGPU_FLAG`、`LINUX_SWIFTSHADER_FLAGS_AGAINST_GPU_PROCESS_CRASHES`→`LINUX_SWIFTSHADER_FLAGS`、`PREVIEW_HOST_IPV4_BECAUSE_VITE_MAY_BIND_ONLY_IPV6`→`PREVIEW_HOST`、`NEVER_TEST_A_STALE_PREVIEW_SERVER`→`REUSE_EXISTING_SERVER`（設定のキーをなぞっただけだったので、監査 F-RP-4 でリテラルの `false` に戻した）、`AGENT_WORKTREES_THAT_COPY_THIS_REPOSITORY`→`AGENT_WORKTREES`、`PLAYWRIGHT_SPECS_RUN_BY_NPM_RUN_E2E`→`PLAYWRIGHT_SPECS`、`SHOW_THE_FIRST_LOAD_STALLING_MS`→`FIRST_LOAD_PAUSE_MS`、`PCD_CONVERSION_IN_THE_BROWSER_TOOK_OVER_3_MIN_SO_WAIT_MS`→`PCD_CONVERSION_TIMEOUT_MS`、`turnEdlOffFromItsDefaultOn`→`turnEdlOff`、`layerPanelStartsOpenExceptOnANarrowScreenWhereTheDrawerWouldCoverThePoints`→`layerPanelStartsOpen`、`outsideTheSlidingLayerPanelSoFixedPositionIsTheViewport`→`portalOutsideLayerPanel`、`FIXED_RENDER_SCALES_SO_ZERO_OR_NEGATIVE_CANNOT_BREAK_THE_VIEW`→`RENDER_SCALE_CHOICES`
  - 使い手: どれも定義したファイルの中だけか、e2e の3ファイル（`STILL_VISIBLE_WAIT_MS`）・vite と eslint（`AGENT_WORKTREES`）・portal-target と LayerActions・LayerContextMenu（`portalOutsideLayerPanel`）。置き換えの前に `git grep -c -w <古い名前>` で数え、後に古い名前が TaskSheets の外で 0 件、新しい名前が前に使われていなかったことを確かめた
- 再発防止は `TaskSheets/RECURRENCE.md` の「## CM-3」の節。道具 `scripts/removed-comment-reasons.mjs`（テスト付き）と AGENTS.md の作業役の決まりを1行足した。F-4 の決まりは CM-1 の作業役が足す行に任せた
- 道具で自分の範囲を見直した結果: `node scripts/removed-comment-reasons.mjs d05c858 src/app src/state src/ui` は 207 件。R2 で 151 行を読んで表に足した後なので、新しく語を足して増えた分（twin・not in・same as・と同じ・に合わせ など）を読んだ。最初の語の一覧に当たらない 52 件（出力の先頭 200 文字で判定。最初の語の一覧では 175 件、今は 207 件）を読み、表に無かった理由を 6 行足した（`section-export.ts` の z と X・Y、押しているポインタの記録、端末ごとの既定値、`useFileDrop` の ref、DTM の出力形式を設定で選ぶ理由、投影の種類の一方向）。残りは「同じ関数を呼ぶ」「同じ見た目」など名前で読める説明か、表に既にあるもの。207 件の全部を表の行と1件ずつ突き合わせてはいない（未確認）。`--docs` は 17 行で、範囲の文書（state.md・ADR-0016）にはもう無い

### CM-3-RP R2 での直し（監査 F-RP-1〜F-RP-4）

- F-RP-1（should）: 理由の語が F-1 の例に寄っていて、CM-3 が自分で表に移した `src/state/measure.ts` の2文（To keep precision … / so squares do not get huge）を出さなかった。語に `so`・`to keep`・`in order to`・`why`・`ように` を足し、続いた `//` の行を1つのコメントとして読むようにした（理由が2行に分かれても拾う）。出力の行番号は、コメントのうち理由の語がある最初の行。テスト「finds reasons outside the F-1 examples too」「reads consecutive // lines as one comment」で、F-1 以外の文での再現を固定した。d05c858→874a964 で 226 件を出し、`measure.ts:5`・`:76` と F-1 の箇所が入る（同じコメントの塊の中の `useCopcViewer.ts:17` は、塊の最初の理由の行 `:14` として出る）
- F-RP-2（nit）: `--head <ref>` を足し、作業コピー以外のコミットにも当てられるようにした
- F-RP-3（nit）: `--docs` が AGENTS.md の自分の決まりの行を出していたので、`removed-comment-reasons` を含む行を除いた（テストのケースを足した）。今は 17 行
- F-RP-4（nit、CM-3 のコード）: `playwright.config.ts` の `REUSE_EXISTING_SERVER` は設定のキーをなぞっただけだったので、リテラルの `false` に戻した（理由は CM-3 のシートの表）
