# 紹介動画（アプリ紹介・3〜4分）の作成パイプライン

- 状態: 初版ドラフト完成。`docs/video/out/intro-draft.mp4` を再生成できる状態
- 台本: `docs/video/script.md`
- 元タスク: 所有者から「台本を実写動画にする再実行可能なパイプラインを作り、ドラフトを1本作る」の依頼
- **撮影時点のコミット: `fca15ae`(作業開始時のorigin/main)。** 作業と並行して別エージェントが
  UIシェルの作り直しを進めている(コーディネーターからの連絡)。そちらが`origin/main`へ
  入った後は、`docs/video/footage/`の実写5本(`01-hook`・`04-web-convert`・
  `05-color-modes`・`06-edl`・`07-center-priority`)を**撮り直すこと**
  (UIのセレクタ・レイアウトが変わっている可能性が高く、`capture-app.mjs`の
  `data-ui-id`/ラベルテキストに基づくセレクタが通らなくなる、または違う見た目を
  映してしまう)。`docs/video/footage/01-hook.mp4`以外の`02-windows.mp4`等
  (所有者撮影分)はUIに依存しないため撮り直し不要

（このファイルは作業完了後にコーディネーターへの報告をもとに書く。実行ログ・ffprobe出力・
確認したフレームの所見は最後にまとめて追記する。）

## 作ったもの

- `docs/video/scenes.json`: シーン台本（ナレーション文・字幕・画面素材の指定）。
  `docs/video/script.md` の文言をもとにしている
- `docs/video/cards/*.html`: タイトル・COPCの図・実測の表・プレースホルダなどの静止画面
  （1920×1080でスクリーンショットする）
- `docs/video/tools/`: 独自の`package.json`を持つビルドツール一式（アプリ本体のpackage.jsonは触っていない）
  - `render.mjs`: `scenes.json`から`docs/video/out/intro-draft.mp4`を作るメインスクリプト
  - `capture-app.mjs`: Web版(vite preview)をheaded chromiumで操作し、実機映像を
    `docs/video/footage/`に書き出すスクリプト
  - `lib/tts.mjs` + `lib/tts.ps1`: ナレーションwavの生成（WinRT音声合成）
  - `lib/compose.mjs`: 1シーン分の動画を組み立てる（素材の尺合わせ・字幕焼き込み・音声ミックス）
  - `lib/record.mjs`: CDP screencastでchromiumの描画をフレーム列として録画し、可変間隔のまま動画化する
  - `lib/cards.mjs`: HTMLカードをPNGにスクリーンショットする（headless chromium）
  - `lib/captions.mjs`: 字幕のdrawtextフィルタ組み立て
  - `lib/ffmpeg.mjs` / `lib/paths.mjs`: 共通ヘルパー

## 選んだ方法と理由

### TTS: WinRT (`Windows.Media.SpeechSynthesis`) の既定音声

所有者の環境で`SpeechSynthesizer`の既定音声が**OneCoreの日本語音声「Microsoft Ayumi」**
だったため、それをそのまま使った（ブリーフで提示されたjaJP Ayumi/Haruka/Ichiro/Sayakaの
うちの1つ）。SAPIのHarukaにフォールバックする分岐は作らなかった(Ayumiが最初から
使えたため)。`AllVoices`列挙はPowerShellからだと空配列を返す現象に当たった
(WinRTコレクションのマーシャリングの問題と思われる。未調査)が、`synth.Voice`
(既定音声)は問題なく取れたので、列挙はせず既定音声をそのまま使う設計にした
(`docs/video/tools/lib/tts.ps1`)。

### 字幕の焼き込み: ffmpeg drawtext + textfile

字幕テキストを一時ファイルに書き出し、`drawtext=textfile=...`で読ませる方式にした。
日本語＋記号＋英数字が混じる文字列をffmpegのフィルタ文字列エスケープ
(`:`,`'`,`\`,`,`)にそのまま埋め込むと事故りやすいため。フォントは
`C:\Windows\Fonts\YuGothB.ttc`(Yu Gothic Bold)。

### 動画撮影: CDP `Page.startScreencast`

`playwright-core`の`recordVideo`はソフトウェアエンコードで画質が粗いとブリーフにあった
指示どおり、採用しなかった。`page.screenshot()`を一定間隔で回す方式も検討したが、
1920×1080のキャプチャは1回50〜150ms程度かかり律速になる。CDPの`Page.startScreencast`は
実機（RTX 4070 / WebGPU有効）で1〜数秒の操作に対して**60fps前後**の実測ペースでフレームが
届いた(`lib/record.mjs`)。フレーム間隔は一定ではないため、各フレームに実測の
表示時間を割り当てたconcat demuxerのリストを作り、最後に`fps=30`で30fps CFRへ
揃え直している。

### ffmpeg-static / ffprobe-static

ブリーフの指示どおり。`docs/video/tools/package.json`にのみ依存を追加した
(アプリ本体の`package.json`は変更していない)。`npm install`は初回、GitHub Releasesの
アセット取得が1回だけ500エラーで失敗した(再実行で成功。一過性のものと思われる、
詳細未調査)。

### WebGPUをheaded chromiumで有効にするフラグ

Playwrightが使うChromium(chromium-1248、Chrome for Testing 156)は既定では
`navigator.gpu`自体が無効だった。次のフラグの組み合わせで有効になることを確認した
(`docs/video/tools/capture-app.mjs`の`CHROMIUM_ARGS`):

```
--enable-unsafe-webgpu
--enable-features=Vulkan,WebGPU,WebGPUDeveloperFeatures
--use-angle=d3d11
--disable-gpu-sandbox
--ignore-gpu-blocklist
```

`--enable-unsafe-webgpu`だけ、`--ignore-gpu-blocklist`だけでは`navigator.gpu`が
現れず、`--enable-features=...,WebGPU,...`を明示的に足して初めて有効になった
(未調査の詳細: 個々のフラグのうちどれが必須でどれが冗長かは切り分けていない。
上の5つをまとめて使えば動くことだけ確認した)。`msedge`チャンネルは試していない
(上記の組み合わせで動いたため)。

### はまったこと: 撮影用previewサーバーがポート4173で別サーバーと衝突した

同じマシンで動いている別のツール(ui-forgeのpreview、本リポジトリの依存。
`npm run ui:gen`等が使う)が偶然ポート4173を使っており、`vite preview --port 4173
--strictPort`を実行した直後は正しく起動していたログが残っていたにもかかわらず、
後から`curl`やPlaywrightで`http://localhost:4173/`を見ると**別サーバー**
(`<title>ui-forge preview</title>`のページ)が応答していた。Playwrightの
`waitForSelector('canvas')`が15秒タイムアウトし続ける原因がこれだと分かるまで、
「WebGPUが有効にならない」問題だと誤認して時間を使った。**対策として、
previewサーバーのポートを4555に変更した**(`capture-app.mjs`の`BASE_URL`既定値、
および起動コマンド`npm run preview -- --port 4555 --strictPort --host 127.0.0.1`)。
同じマシンで複数のエージェント・ツールが並行して動きうる環境では、
ポートがかぶっていないかを`curl`で`<title>`を確認するまでは信用しないこと。

### 大規模データ(東京都デジタルツイン)が撮影中に用意できた

作業の途中で、コーディネーター経由で「別エージェントが東京都デジタルツイン実現
プロジェクト「区部点群データ」(渋谷区、55タイル、CC BY 4.0)を結合して
`data/tokyo-shibuya-merged.copc.laz`に用意している」という連絡が入った。
完成を待って`cargo run -p pcv-core --release --example open_bench --
data/tokyo-shibuya-merged.copc.laz`を実行し、COPCヘッダーから実際の点数と
ファイルサイズを取った(推測ではなく実測):

```
ファイルサイズ  : 4.62 GB
総点数          : 347797138
hierarchy ノード: 6475
開く時間        : 64.3 ms
```

この数字をもとに、`01-hook`シーンのnarration/captionをscript.md本来の
「数億点の点群も」に戻し、字幕を「4.62GB ／ 347,797,138 points」にした
(`docs/video/scenes.json`)。`docs/video/tools/capture-app.mjs`は
`data/tokyo-shibuya-merged.copc.laz`が存在すればそれを、無ければautzenを
使うよう分岐している(`hookSourceFile`)。クレジットカード
(`docs/video/cards/14-credits.html`)にも「点群データ: 東京都デジタルツイン
実現プロジェクト 区部点群データ（CC BY 4.0）」を追記した。

### 撮影中にWebGPUレンダリング操作がハングする事故が繰り返し起きた

`capture-app.mjs`で複数シーンを同じページ・同じブラウザセッションで連続撮影する
構成にしていたところ、次の2種類の事故が起きた。

1. **カメラが点群を通り過ぎて何も映らなくなる**: `orbitAndZoom`のホイールズームが
   強すぎ(-120×10回)、01-hookの終盤でカメラが点群を素通りして空を向いたまま
   次のシーン(05-color-modes)が始まり、そのシーンの映像がほぼ無地(ファイルサイズが
   異常に小さい: 36KB)になっていた。ズーム量を弱め(-80×4回)、05/06/07の各シーンの
   前で`resetView()`(サンプルファイルを開き直してカメラをbounding boxへ再フィット)を
   呼ぶようにして直した
2. **設定画面の操作後、file inputがDOMから見つからなくなる／クリックが数十秒固まる**:
   特に「中央優先度の強さを0以外(4)にした直後に設定を閉じるクリックをする」という
   操作列で再現性高く固まった。中央優先度を上げた直後は再読み込み中のノードの
   優先度再計算が重くなっている可能性があり、JSのメインスレッドが長時間専有されて
   Playwrightのクリックが処理されないのではないかと見ているが、**未確定・未調査**。
   対策として`07-center-priority`は専用スクリプト
   (`docs/video/tools/lib/capture-center-priority.mjs`)に切り出し、
   「スライダーを変える操作は録画していない間に済ませ、録画中はホイール操作だけを行う」
   形に作り直した(強さ0の場面と4の場面を別々に録画し、最後にffmpegで連結)。
   これで安定して撮れることを確認した。`04-web-convert`も同様に専用スクリプト
   (`lib/capture-web-convert.mjs`)に切り出したが、こちらは別の理由(変換そのものが
   極端に遅い/止まって見える)で結局撮影できなかった。詳細は下の
   「04-web-convert(autzen.pcdのブラウザ内変換)の実写撮影は断念した」節参照

さらに、`page.waitForFunction(fn, {timeout})`のように第2引数へ直接optionsを
渡す呼び方は、Playwrightがそれを`arg`(predicateへの引数)と解釈し、指定した
timeoutが無視されて既定の30秒になる事故があった。`page.waitForFunction(fn,
undefined, {timeout})`のようにargへ明示的に`undefined`を渡す形に直した
(`capture-app.mjs`・`lib/capture-web-convert.mjs`)。

CDPの`Page.stopScreencast`が応答を返さないまま固まる事故も観測したため、
`lib/record.mjs`の`stop()`を含む主要なCDP呼び出しに`withTimeout`ヘルパーで
上限(5〜10秒)を設け、超えたらその時点までに撮れたフレームだけで動画化するよう
にした(1カットの事故で撮影全体を止めないため)。

### 04-web-convert(autzen.pcdのブラウザ内変換)の実写撮影は断念した

`04-web-convert`(ブラウザでautzen.pcd[1,065万点、319MB]を変換する場面)だけは、
最終的に実写footageを撮れなかった。試した3通り:

1. `capture-app.mjs`内で、ファイルを開いてから変換完了までCDP screencastで
   録画し続ける → 180秒(既定のPlaywrightタイムアウト)で未完了のままtimeout
2. タイムアウトを600秒に伸ばして再実行 → 600秒でも未完了のままtimeout
   (この間、録画フレームは6万枚近くまで増え続けた。`docs/video/tools/lib/record.mjs`の
   screencastは「変化があったときだけ」ではなく、canvasが継続的に再描画している限り
   ほぼ毎フレーム飛んでくるらしいとこの時点で把握した)
3. 「録画している間だけ変換が遅くなっているのでは」という仮説のもと、
   `lib/capture-web-convert.mjs`を作り直し、**録画していない間はCDPを繋がず
   ポーリングだけで完了を待つ**形にして再実行 → **これも600秒(10分)で
   未完了のままタイムアウトした**。つまり録画の有無は原因ではない

その後、`origin/main`(このエージェントが作業を始めた後に別エージェントが進めた
コミット)に`e2e/web-conversion.spec.ts`というテストが追加されているのを見つけた
(`f369cd1`、`TaskSheets/ADR-0016-e2e-web-conversion.md`参照)。**このE2Eテストも
あえて2,000点程度の小さな合成LASしか使っていない**(`scripts/make-test-las`で
その場生成)。コミットメッセージには「テスト・CIが緑のまま実ブラウザでは壊れている
不具合が繰り返し起きていた」とあり、実ブラウザでの変換が壊れやすい領域だと
開発チーム自身も認識している様子がうかがえる。**autzen.pcd相当の大きさ
(百万点オーダー)のファイルを、自動化されたブラウザ操作から変換させると
極端に遅い、あるいは止まって見える状態になる、という所見は今回新しく得られたもの
だが、原因はまだ特定できていない**(WASMがシングルスレッドでCDPのポーリング
自体と競合している、ファイル入力の`setInputFiles`が大きいファイルで特別に遅い、
もしくは変換ロジック自体に大きい入力で刺さる経路がある、のいずれも未切り分け)。

このドラフトでは`04-web-convert`はプレースホルダのまま出荷する。所有者または
次の担当者が確かめる手順: Windows版のブラウザ(手動操作、自動化なし)で
`data/autzen.pcd`を選んで変換し、実際にどれくらいの時間がかかるか・途中で
止まって見えないかを見てほしい。自動化なしでも遅ければアプリ側の問題、
自動化なしだと速いなら自動化環境(Playwright/CDP)固有の問題と切り分けられる。

### ffmpegの`scale`/`pad`フィルタでの事故: 0バイト出力のままハングしたように見えた

最初の実装で`scale=1920x1080:force_original_aspect_ratio=decrease`のように
`1920x1080`を1個の文字列で渡していた(`pad`も同様)。これは`scale`/`pad`どちらの
引数としても無効で、ffmpegは「フィルタの再初期化に失敗」してすぐにエラー終了する
(0バイトの出力ファイルが残る)。ところがNodeの`child_process.spawn`側で
`stdout`を誰も読まずに放置していたため(子プロセス終了時の`close`イベント自体は
正常に飛ぶはずだが、`docs/video/out/tmp/01-hook/01-hook-v0.visual.mp4`が
0バイトのまま6分以上ファイルサイズが変わらず、プロセスがCPU時間0のまま
残り続けるという「ハングしたように見える」状態になった。原因はまだ完全には
特定できていないが、再現しなくなるよう(1)`scale=1920:1080:...`/`pad=1920:1080:...`
と幅・高さを別引数に直し、(2)`spawn`の`stdio`を`['ignore','ignore','pipe']`に
明示する、の両方を行った(`docs/video/tools/lib/ffmpeg.mjs`、
`docs/video/tools/lib/compose.mjs`)。

## honesty（ドラフトの誠実さ）

- `script.md`のシーン1は「数億点の点群も」。撮影を始めた時点ではautzen
  (1,065万点)しか無かったため、ナレーション・字幕を「大きな点群も」＋実際の点数
  に変え、誇張を避けた言い回しで作っていた。作業の途中で東京都デジタルツイン
  実現プロジェクトの大規模データ(3.48億点)が用意できたため、**最終的にはそちらで
  撮影し、ナレーション・字幕をscript.md本来の「数億点の点群も」に戻した**
  (下の「大規模データ(東京都デジタルツイン)が撮影中に用意できた」節参照)。
  `docs/video/tools/capture-app.mjs`は大規模データが無い環境で再撮影すると
  自動でautzenにフォールバックするが、その場合は`scenes.json`の`01-hook`の
  narration/captionを誇張しない言い回しに手で戻す必要がある(`note`フィールドに
  手順を書いてある)
- 実測の表(`docs/video/cards/10-table-open.html`、`12-table-convert.html`)の数値は
  `TaskSheets/M1-point-rendering.md`(11.1ms/9MB/32.0ms/13MB)と
  `TaskSheets/M4-import-and-conversion.md`のM4-9(171秒/0.23GiB、原文は
  「170.80〜171.19秒、プライベートメモリピーク0.227GiB」)を実際に開いて照合した。
  両方とも「開発機での実測」とカード上に明記した
- autzenの出典(`docs/video/cards/14-credits.html`)は`TaskSheets/TEST-DATA.md`の
  「出典」節の文言をそのまま使った: 「Autzen Stadium — Watershed Sciences, Inc.
  （2010年取得）、Hobu, Inc. の Max Sampson が2021年に分類」
- AIMD点予算自動調整のカード(`11-point-budget.html`)は当初`ADR-0009`を出典に
  書いていたが、実際にAIMD(Additive Increase/Multiplicative Decrease)という
  語が出てくるのは`ADR-0010-lod-priority-and-point-budget.md`だったため、
  grepで確認してから出典を直した

## 未確認・所有者が確かめること

- **ナレーション音声の品質**: Ayumiの発話内容が自然か、読み間違い・変なイントネーションが
  無いかは、実際に音声を聞いて確認していない(このエージェントは音声を聞けない)。
  `docs/video/narration/*.wav`を再生して確認してほしい
- **各シーンの画面の見栄え**: フレームを静止画として目視したのみ(`docs/video/out/`から
  `docs/video/tools/lib/extract-frames.mjs`で抽出可能)。動画として連続再生したときの
  カメラの動きの滑らかさ・字幕の出だし/消えのタイミングは未確認
- **WebGPUを有効にするchromiumのフラグ**: 5つまとめて動くことは確認したが、
  どれが必須でどれが無くても動くかの切り分けはしていない
- **CDP screencastがWASM変換を遅くしている疑い**(`capture-web-convert.mjs`参照):
  録画を止めている間に変換が速く終わることを期待してスクリプトを作り直したが、
  実際に「録画ありだと遅い/録画無しだと速い」を定量比較したわけではない
  (録画ありの実行を10分で打ち切った後、録画無しの構成に作り直してそのまま
  採用したため)。本当にscreencastが原因かは未検証
- **`npm install`が1回だけGitHub Releasesの取得で500エラーになった件**: 一過性か、
  再現するものかは確認していない
- **`AllVoices`がPowerShellから空配列になる件**: 既定音声(Ayumi)が使えたため
  深追いしていない。他の声を明示的に選びたくなったときに影響する

## 分かっている改善点（この版では直していない）

- **01-hookのカメラ移動**: 序盤でホイールズームの最中に、点群を真横から見るような
  画角を一瞬通過する(`TaskSheets/VIDEO-intro.md`の「カメラが点群を通り過ぎて
  何も映らなくなる」の軽い版。致命的ではないが綺麗ではない)
- **09-copc-diagramのカード自体のキャプションと、動画の字幕(caption)が縦に近い位置に
  並ぶ**: カード内の説明文(「開くときに読むのは hierarchy だけ…」)と、焼き込んだ字幕
  (「COPC（Cloud Optimized Point Cloud）」)が近接していて窮屈。カードのレイアウトか
  字幕の位置をもう少し離すと良い

## 所有者がプレースホルダを差し替える方法

`docs/video/footage/`に、決まったファイル名でmp4を置いて`npm run build`
(= `docs/video/tools`で`npm run build`)を再実行すると、プレースホルダから
実写映像に自動で差し替わる(`docs/video/tools/lib/compose.mjs`の
`resolveVisualSource`: ファイルが無ければカードへフォールバックする)。

| ファイル名 | 内容 | 撮る人・機材 |
|---|---|---|
| `docs/video/footage/02-windows.mp4` | 同じ点群(autzen)をWindows版で開いて映す | 所有者・Windows実機 |
| `docs/video/footage/02-android.mp4` | 同じ点群をAndroidタブレットで開いて映す | 所有者・Android実機 |
| `docs/video/footage/03-windows-formats.mp4` | LAZ→COPC変換の進捗〜完了、続けてPLY/PCDを開く | 所有者・Windows実機 |
| `docs/video/footage/08-touch.mp4` | 1本指回転・2本指ズーム/パン | 所有者・Android実機 |

`01-hook.mp4`は東京都デジタルツインのデータ(`data/tokyo-shibuya-merged.copc.laz`)で
撮影済み。別の大規模データに差し替えたい場合は、同じファイル名のままデータファイルを
差し替えて`npm run capture`を再実行すること(`capture-app.mjs`の`hookSourceFile`が
`data/tokyo-shibuya-merged.copc.laz`の有無で自動分岐するので、ファイル名を変える場合は
`docs/video/tools/lib/paths.mjs`の`TOKYO_SHIBUYA_COPC`も直すこと)。

以下4つは`docs/video/tools/capture-app.mjs`で自動撮影済み(Web版、autzen)。
再撮影したい場合は、previewサーバーを起動してから`npm run capture`を実行する:

```
cd point-cloud-viewer           # リポジトリルート
npm run build
npm run preview -- --port 4555 --strictPort --host 127.0.0.1   # 別ターミナルで起動したままにする
cd docs/video/tools
npm run capture
```

| ファイル名 | 内容 |
|---|---|
| `docs/video/footage/01-hook.mp4` | 大規模データ(無ければautzen)を開いて回す・寄る |
| `docs/video/footage/05-color-modes.mp4` | 着色: 標高→強度→分類→RGB |
| `docs/video/footage/06-edl.mp4` | EDLオン/オフ |
| `docs/video/footage/07-center-priority.mp4` | 中央優先度の強さ0→4 |

`docs/video/footage/04-web-convert.mp4`(autzen.pcdのブラウザ内変換)は
**今回撮影できなかった**(上の「04-web-convert(autzen.pcdのブラウザ内変換)の
実写撮影は断念した」参照)。`npm run capture:web-convert`
(`docs/video/tools/lib/capture-web-convert.mjs`)で再挑戦できるが、
現状だと10分待っても変換が終わらない。次に試す人は、まず自動化なしの手動操作
(Windows版のブラウザでautzen.pcdを選んで変換するだけ)で同じ遅さが起きるか
確認してから、自動化側の問題かアプリ側の問題かを切り分けてほしい。

## 再生成の手順

```
cd docs/video/tools
npm install
npm run build        # scenes.json -> docs/video/out/intro-draft.mp4
```

実写撮影からやり直す場合は上記「所有者がプレースホルダを差し替える方法」の
`npm run capture`を先に実行する。

## 触ったファイル

- `docs/video/scenes.json`（新規）
- `docs/video/cards/*.html`、`docs/video/cards/style.css`（新規）
- `docs/video/tools/`配下一式（新規。独自package.json）
- `.gitignore`（`docs/video/out/`・`docs/video/footage/`・`docs/video/narration/`・`*.pcd`を追加）
- `TaskSheets/VIDEO-intro.md`（本ファイル、新規）

## 実行ログ（コマンドと出力の抜粋）

### ビルド

```
cd docs/video/tools && npm run build
...
=== 完成 ===
出力: ...docs\video\out\intro-draft.mp4
合計時間: 171.59s (2:51)
```

### ffprobe（最終成果物）

```
[STREAM] codec_name=h264 width=1920 height=1080 r_frame_rate=30/1 profile=High pix_fmt=yuv420p
[STREAM] codec_name=aac sample_rate=48000 channels=2
[FORMAT] duration=171.589000 size=19497547
```

1920×1080・30fps・H.264(High)・AAC 48kHz/stereo・2:51.59。受け入れ条件の
2:45〜4:15に収まっている。

### 東京都デジタルツインのCOPCヘッダー実測

```
cargo run -p pcv-core --release --example open_bench -- data/tokyo-shibuya-merged.copc.laz
ファイルサイズ  : 4.62 GB
総点数          : 347797138
hierarchy ノード: 6475
開く時間        : 64.3 ms
```

### シーンごとの尺（`docs/video/out/build-report.json`より。パディングは頭0.4秒+尾0.7秒=1.1秒で全シーン一致、ナレーションと字幕のズレが無いことを機械的に確認）

| シーン | ナレーション長(秒) | シーン長(秒) | 映像ソース |
|---|---|---|---|
| 01-hook | 11.76 | 12.86 | footage(東京都デジタルツイン) |
| 02-cross-platform | 14.07 | 15.17 | placeholder×2 + footage(01-hook再利用) |
| 03-formats | 24.86 | 25.96 | placeholder |
| 04-web-convert | 10.63 | 11.73 | placeholder（未撮影。上記参照） |
| 05-color-modes | 13.71 | 14.81 | footage |
| 06-edl | 5.01 | 6.11 | footage |
| 07-center-priority | 9.63 | 10.73 | footage |
| 08-touch | 3.45 | 4.55 | placeholder |
| 09-copc-diagram | 21.24 | 22.34 | card |
| 10-table-open | 6.91 | 8.01 | card |
| 11-point-budget | 6.99 | 8.09 | card |
| 12-table-convert | 9.62 | 10.72 | card |
| 13-future-cta | 12.87 | 13.97 | card |
| 14-credits | 5.38 | 6.48 | card |

合計 171.59秒。

### フレーム確認（受け入れ条件3）

`docs/video/tools/lib/extract-frames.mjs`で全14シーンの中央時刻のフレームを
`C:\Users\Masa1\AppData\Local\Temp\claude\c--rust-point-cloud-viewer\93cb5495-a7f7-4a52-9ec5-f6c2668b9eeb\scratchpad\video-frames\`
へ書き出し、Readツールで1枚ずつ目視した。

| シーン | 所見 |
|---|---|
| 01-hook | 東京都デジタルツインの点群(347,797,138点)がRGBで表示されている。字幕「4.62GB／347,797,138 points」が正しく読める(tofuなし) |
| 02-cross-platform | Androidプレースホルダカードが表示されている。字幕「Windows / Android / Web ── Tauri + Rust + WebGPU」読める |
| 03-formats | Windowsプレースホルダカードが表示されている。字幕「COPC / LAS / LAZ / E57 / PLY / PCD」読める |
| 04-web-convert | プレースホルダカード(「Web版の自動撮影映像（未生成）」)。字幕「ブラウザだけで変換 ── WebAssembly + OPFS」読める |
| 05-color-modes | autzenの分類色(緑・茶・青等)が表示されている。字幕「着色: 標高 → 強度 → 分類 → RGB」読める |
| 06-edl | autzenのRGB+EDL陰影が表示されている。字幕「EDL（陰影）: オン / オフ」読める |
| 07-center-priority | autzenが表示されている。字幕「中央優先度の強さ: 0 → 4」読める |
| 08-touch | Androidタッチ操作プレースホルダカード。字幕「1本指で回転 / 2本指でズーム・パン」読める |
| 09-copc-diagram | COPCの図(ヘッダー/hierarchy/ノード/octree)が表示されている。字幕とカード自体の説明文が近接していてやや窮屈(未解決の改善点として記録済み) |
| 10-table-open | 実測の表(autzen/sofiの開く時間・メモリ)が正しい数値で表示されている |
| 11-point-budget | AIMD制御の説明カードが表示されている |
| 12-table-convert | 変換の実測表(171秒/0.23GiB)が正しい数値で表示されている |
| 13-future-cta | タイトルとGitHub URLが表示されている |
| 14-credits | 東京都デジタルツイン・autzenの出典とナレーション音声のクレジットが表示されている |

**app-footage系のシーン(01, 05, 06, 07)はすべて実際に点群が描画されている
フレームであることを確認した(黒画面・エラーバナー・白紙ではない)。**
placeholder系(02, 03, 04, 08)は意図どおりプレースホルダカードが表示されている。

### 字幕とナレーションの同期（受け入れ条件4）

全14シーンで `シーン長 - ナレーション長 = 1.1秒`(頭パディング0.4秒+尾パディング0.7秒)
が一致しており(上の表参照)、`docs/video/tools/lib/compose.mjs`の`adelay`フィルタで
ナレーションの開始を頭パディング分だけ遅らせているため、音声の始まりと字幕の
表示開始がズレない設計になっている。個々のwavファイルの音量・明瞭さは
耳で聞いて確認していない(「未確認」節参照)。

### footage差し替えテスト（受け入れ条件5）

```
docs/video/footage/02-windows.mp4 に赤画面+「DUMMY TEST FOOTAGE」の3秒クリップを設置
→ シーン02を単独で組み立て直す
→ resolvedSources: [{"kind":"footage","file":"02-windows.mp4"}, ...]
→ フレームを抽出して目視: 赤画面に「DUMMY TEST FOOTAGE」の文字が映っている
→ docs/video/footage/02-windows.mp4 を削除
```

プレースホルダから実写への自動差し替えが機能することを確認した。差し替え後の
テスト用ファイルは確認後に削除済み（`git status`でfootage/配下が追跡されていない
ことも確認済み）。

### gitignore・差分確認

```
git status --short
 M .gitignore
?? TaskSheets/VIDEO-intro.md
?? docs/video/cards/
?? docs/video/scenes.json
?? docs/video/tools/
```

`docs/video/out/`・`docs/video/footage/`・`docs/video/narration/`・
`docs/video/tools/node_modules/`はいずれも`git status`に出てこない
(`.gitignore`で除外済み)。
