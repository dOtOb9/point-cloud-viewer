# ADR-0016: Web版の変換を実ブラウザで通すE2E(Playwright)をCIに入れる

- 状態: 採択
- 日付: 2026-10-08
- 前提: [ADR-0012](./ADR-0012-web-worker-sync-io.md)（Web版のWorker内同期I/O）、
  [ADR-0006](./ADR-0006-conversion-strategy.md)（変換戦略）、
  [M4-import-and-conversion.md](./M4-import-and-conversion.md)（M4-12の変換の内訳表示）、
  `CLAUDE.md`「テストとCIが緑でも、動くとは限らない」

## 決定

1. Playwright(`@playwright/test`)で、Web版の変換を実際のヘッドレスChromiumで
   1本通すE2Eテストを追加した: `playwright.config.ts`・`e2e/web-conversion.spec.ts`。
2. テスト用の点群(LAS)はコミットせず、`scripts/make-test-las.ts`がテストのたびに
   その場で生成する(色・強度付き、2,000点)。
3. 本番(GitHub Pages)と同じサブパス(`base: "/point-cloud-viewer/"`)で
   `vite build`→`vite preview`したものを対象にする(`GITHUB_PAGES_BUILD=true`)。
4. ヘッドレスChromiumでWebGPUを使うため、Playwrightの`channel: "chromium"`を
   指定する(理由は後述「WebGPUが使えるようになるまで」)。追加のコマンドライン
   フラグは不要だった。
5. `.github/workflows/ci.yml`に新しい独立ジョブ`e2e`(ubuntu-latest)を追加した。
   他のジョブを待たず並行実行する。Playwrightのブラウザ本体は
   `actions/cache`でキャッシュする。
6. `CLAUDE.md`に、E2Eが使う`data-testid`の一覧と「UIを作り直すときも消さない
   こと」を追記した。

## 背景: なぜ要るか

このプロジェクトでは、**テストもCIも緑なのに、実際のブラウザでは壊れている**
ことが何度も起きた。

- wasmでの時刻panic(`std::time::Instant::now`がwasm32で`unreachable`)。
  本番の変換経路が必ず失敗していたが、CIは`vendor/copc-writer`が
  ルートworkspaceのexclude対象で一切リント・テストされておらず素通りしていた
  (`ci.yml`の`rust`ジョブのコメント、2026-10-07の緊急修正参照)
- `FileReaderSync`にバッファが無く、変換が1点ごとに重い処理を繰り返して
  実質止まって見えた(`crates/pcv-wasm/src/convert.rs`の「読み込みの
  バッファリング」節参照)
- OPFSのハンドルの衝突
- 変換完了後「変換の内訳」とダウンロードのリンクがすぐ消える
  (`fix(state): 変換完了後、続けて開くopenFileが変換の内訳を消してしまう
  不具合を直す`、f98a32e)

いずれも**Web版の変換の流れを実際のブラウザで1回通せば見つかった**不具合であり、
単体テスト(vitest、DOM無し・wasm未実行)や型検査では原理的に検出できない
種類の不具合だった。このADRは、その「1回通す」ことを自動化してCIに入れる。

## なぜPlaywrightか

既存のテストはvitest(jsdom、実ブラウザでもwasmでもない)のみ。実ブラウザで
wasm・OPFS・File選択・WebGPUを実際に動かす必要があり、ブラウザを操作できる
E2Eフレームワークが要る。PlaywrightはChromium/Firefox/WebKitを自動インストール
でき、`setInputFiles`でファイル選択を、`page.on("console")`でconsoleを、
それぞれ素朴に扱える。他の主要な選択肢(Cypress)と比べて検討はしていない
(Playwrightで要件を満たせることを確認できたため、比較検討に時間を使わなかった。
**未検討**であることを明記する)。

## WebGPUが使えるようになるまで(ここが一番時間を使った調査)

CIのマシン(GitHub Actionsのubuntu-latest)にGPUは無い。所有者の環境
(Windows、このエージェントのサンドボックス)で、ヘッドレスChromiumで
WebGPUが使えるかを実際に試行錯誤して確かめた。

### 分かったこと(実機で確認済み)

1. **`navigator.gpu`自体がセキュアコンテキストでしか存在しない。**
   `page.goto("data:text/html,...")`のようなopaque originのページでは
   `'gpu' in navigator`が`false`になる。`http://127.0.0.1`や`http://localhost`
   (ブラウザがセキュアコンテキスト扱いする特例)なら存在する。
   `vite preview`はhttpでしか配信しないため、このテストでは意識せず満たせている。
2. **Playwrightの既定の`headless: true`は、軽量な専用バイナリ
   (`chrome-headless-shell`)を使う。** このバイナリは`navigator.gpu`は
   存在するが、`requestAdapter()`が常に`null`を返す(GPU機能が根本的に
   使えないビルド)。
3. **`channel: "chromium"`を指定すると、通常の(フル)Chromiumバイナリを
   headlessモードで使うようになる。** このバイナリは、GPUの実機が無くても
   `requestAdapter()`が実際にアダプタを返し、`requestDevice()`・
   `<canvas>`の`getContext("webgpu")`・`configure()`・実際のレンダーパス
   (`beginRenderPass`→`submit`)まで通ることを確認した。内部的には
   Chromium同梱のSwiftShader(ソフトウェアのVulkan実装)が使われている
   (`GPU.BlocklistFeatureTestResults.Webgpu`のヒストグラムlog、
   ANGLEの`renderer`文字列に`SwiftShader`が含まれることで確認)。
4. **追加のコマンドラインフラグは不要だった。** `--enable-unsafe-webgpu`・
   `--ignore-gpu-blocklist`・`--use-vulkan=swiftshader`等を色々試したが、
   `channel: "chromium"`だけで(フラグ無しで)`requestAdapter()`が成功した。
   むしろ`chrome-headless-shell`側ではこれらのフラグをいくら足しても
   `requestAdapter()`は`null`のままだった(バイナリそのものの制約のため、
   フラグでは回避できない)。

### 検証に使ったスクリプト(再現用、リポジトリには残していない)

`chromium.launch({ headless: true, channel: "chromium" })`→
`page.goto("http://127.0.0.1:<port>/")`(素朴な`http.createServer`)→
`navigator.gpu.requestAdapter()`→成功、`requestDevice()`→成功、
`<canvas>.getContext("webgpu")`で`configure`→`beginRenderPass`→`submit`
まで成功、を確認した。この一連の確認はこのマシン(Windows)で行った。
**CI(ubuntu-latest)での同じ確認は、このADRをpushして実際のCI実行結果で
行う(下記「実行結果」参照)。** Windowsで通ることとLinux(ubuntu-latest)で
通ることは別の確認であり、OS依存のSwiftShader/Vulkan ICDの挙動が異なる
可能性がある。

### 対処方針(本番の挙動は変えていない)

`channel: "chromium"`は`playwright.config.ts`(テスト実行の設定)だけに
書いてあり、アプリ本体(`src/`)のコードは一切変更していない。本番の
WebGPU判定(`src/state/useWebGpuSupport.ts`・`src/renderer/webgpu-probe.ts`)は
今までどおりで、実ブラウザでWebGPUが無ければ`UnsupportedDeviceScreen`に
なる(ADR-0002)。E2Eは「CI環境でもWebGPUの実アダプタが取れる」という
Playwright側の起動設定を選んだだけで、アプリ側に「テスト環境では
WebGPU判定を迂回する」ような分岐は一切加えていない。

## テスト用LASをスクリプトでその場生成する理由

`CLAUDE.md`の「守ること」で点群データ(`*.las`等)はコミットしない方針になって
いる。`scripts/make-test-las.ts`はLAS 1.2・Point Data Record Format 2
(色+強度、GPS時刻なし)のバイト列を`DataView`で素朴に組み立てる純粋関数
(`buildSyntheticLas`)。

- **Rustのビルドを前提にしない**: `crates/pcv-convert`や既存のRustテストの
  フィクスチャ生成を流用する案もあったが、それだとE2E(frontend寄りの
  ジョブ)がRustツールチェインを前提にしてしまう。`.github/workflows/ci.yml`の
  `frontend`ジョブが元々Rust不要であることに合わせ、`e2e`ジョブも
  Rust不要のままにした。
- **点数は2,000点**: `TaskSheets/TEST-DATA.md`の「テスト内で生成(2,000〜20万点)」
  と同じ下限に合わせた。E2Eは「変換の流れが壊れていないか」を見るテストであり、
  規模の大きさ(3.6億点での性能特性)は`TaskSheets/TEST-DATA.md`が別に担っている
  (sofi.copc.lazでの受け入れ判定)ため、小さい点数で十分。

## data-testidで要素を探す理由

クラス名やDOM構造に頼ると、UIを作り直すたびにE2Eが壊れる。`data-testid`と
アクセシビリティの役割(ボタンの名前など)なら、見た目・レイアウトの変更に
強い。使った`data-testid`は`CLAUDE.md`に一覧を追記した(所有者がUIを
作り直すときに参照できるように)。

## CIへの組み込み

`.github/workflows/ci.yml`に独立した`e2e`ジョブ(ubuntu-latest)を追加した。
既存の`frontend`ジョブ(`npm run test`等)とは別の懸念であり、`needs`を
付けずに並行実行する(`build`ジョブが`frontend`だけを待つのと同じ考え方で、
CI全体の所要時間を増やさないことを優先した)。

- ブラウザ本体(200MB超)のダウンロードは`actions/cache`でキャッシュする
  (`~/.cache/ms-playwright`、キーは`package-lock.json`のハッシュ)。
- OS依存ライブラリ(`apt-get install`、`--with-deps`)はキャッシュしない。
  ubuntu-latestのイメージに大半が既に入っており、キャッシュのヒット/ミスに
  よる時間差が小さい一方、キャッシュ自体の構築・検証コストが乗るため。
- `playwright.config.ts`の`webServer`が`npm run build && npm run preview`を
  自動で起動するので、CI側は`npm run e2e`を呼ぶだけでよい。
- 失敗時はトレース・スクリーンショットを`actions/upload-artifact`で残す
  (`test-results/`、保持7日)。

## 検証について(正直に)

**確認済み(このマシン、Windows、実際にコマンドを実行して確認した):**

- `npx playwright install chromium --with-deps`でブラウザを導入できること
- ヘッドレスChromium(`channel: "chromium"`)で`navigator.gpu.requestAdapter()`
  が成功し、`<canvas>`への実際の描画(`beginRenderPass`→`submit`)まで通ること
- `npm run build`(`GITHUB_PAGES_BUILD=true`)→`npm run preview`で、本番と
  同じサブパス(`/point-cloud-viewer/`)で配信されること
- このE2Eが、**M4-12の内訳パネルが変換直後に消える不具合(修正前のコミット、
  `322b38a`時点)で実際に落ちること**を確認した(「変換の内訳」の表示待ちで
  タイムアウト。スクリーンショットでは点群自体は正しく変換・描画されており、
  内訳パネルだけが無い状態だった)
- 修正(`f98a32e`)がmainに入った後、`git rebase origin/main`してから
  同じE2Eが**通ること**を確認した(下記「実行結果」)
- `npm run typecheck` / `npm run lint` / `npm run ui:check` / `npm test`
  (317件、既存+新規)がすべて成功することを確認した
- `npm test`がPlaywrightの`e2e/*.spec.ts`を拾わないこと(vitestの既定
  includeパターンと重なり、`vite.config.ts`の`test.exclude`に`e2e/**`を
  追加して直した)

**未確認:**

- **CI(ubuntu-latest)上で実際にこのE2Eが通るか。** 上の確認はすべてこの
  エージェントのWindows環境で行った。Linux上でのSwiftShader/Vulkan ICDの
  挙動がWindowsと異なる可能性があり、CIで初めて失敗することもありうる。
  下記「実行結果」にrun idを記す(完了を待たずに報告している場合はその旨)
- デスクトップ(Tauri)版・Android版のE2E(対象外、このタスクの範囲は
  Web版の変換のみ)
- 実GPU(ヘッドレスChromiumのSwiftShaderソフトウェアレンダラのみで確認)
- Safari・Firefoxでの変換(ADR-0004が挙げた対象ブラウザはChromium系のみ)
- `sofi.copc.laz`級(3.6億点)の規模でのE2E(このテストは2,000点の小さい
  合成データのみ。大規模データの検証は`TaskSheets/TEST-DATA.md`が別に担う)

## 検討したが採らなかった案

| 案 | 却下理由 |
|---|---|
| ヘッドレスChromiumへのGPU関連フラグ(`--enable-unsafe-webgpu`等)を足して`chrome-headless-shell`のままWebGPUを使う | 実際に試したが`requestAdapter()`は`null`のままだった。`chrome-headless-shell`自体の制約でフラグでは回避できないと判断した |
| テスト用LASをRust側(`crates/pcv-convert`やそのテストフィクスチャ)で生成する | E2E(frontend寄りのジョブ)にRustツールチェインの前提を持ち込みたくない。`ci.yml`の`frontend`ジョブと同じ思想(Rust不要)をE2Eにも適用した |
| `e2e`ジョブを`frontend`の後に`needs`で直列化する | `build`ジョブが`frontend`だけを待つ既存の設計方針(`rust`ジョブの5分超を待たない)に合わせ、独立した懸念は並行させてCI全体の所要時間を増やさない方を選んだ |

## 所有者が確認する手順

1. CIのE2Eジョブ(`e2e`)が緑であることを確認する: `gh run view <run-id>`
2. 失敗した場合は`actions/upload-artifact`の`playwright-test-results`を
   ダウンロードし、`npx playwright show-trace trace.zip`でトレースを見る
3. 手元で再現する場合: `npm ci && npx playwright install --with-deps chromium`
   の後、`npm run e2e`(Windowsでも`channel: "chromium"`で同様に通ることを
   このエージェントが確認済み)

## 実行結果

```
$ npx tsc --noEmit
(出力無し、終了コード0)

$ npx eslint .
(出力無し、終了コード0)

$ npm run ui:check
(出力無し、終了コード0)

$ npx vitest run
 Test Files  36 passed (36)
      Tests  317 passed (317)

$ npx playwright test --config=<port 4199版>   # 修正前(322b38a相当)で実行
  1) [chromium] › e2e/web-conversion.spec.ts ─────
     Error: expect(locator).toBeVisible() failed
     Locator: getByTestId('conversion-breakdown')
     Timeout: 45000ms
  1 failed
  （スクリーンショットで、点群自体は変換・描画済み(points: 2,000)だが
    内訳パネルが無いことを確認した。不具合を実際に捕まえられる証拠）

$ git fetch origin && git rebase origin/main   # f98a32e(修正)を取り込む
Successfully rebased and updated refs/heads/worktree-agent-a46b5e35bfe295b14.

$ npx playwright test --config=<port 4199版>   # 修正後
  1 passed (7.5s)

$ rm -rf dist && CI=true npx playwright test --config=<port 4199版>  # クリーンな状態から
  1 passed (7.5s)
  elapsed_seconds=9   # ビルド+preview起動+テストを含む合計
```

CI(`ci.yml`、`e2e`ジョブ): <!-- push後に実行結果のrun idをここに追記する -->
