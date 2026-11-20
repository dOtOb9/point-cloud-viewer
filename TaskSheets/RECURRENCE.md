# 再発防止の台帳

`AGENTS.md` の「承認の後の再発防止策」で、タスクごとに作業エージェントが書き、監査役が承認する。
1タスク1節。指摘ごとに「根本原因」と「次から防ぐ仕組み」（人の注意に頼らない物を優先）を書く。

形式:

```
## <タスクID>（<日付>、監査: R<n> で APPROVE、再発防止: <APPROVE の日付>）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
```

---

## TP-1（2026-11-16、監査: R2 で APPROVE、再発防止: R3 で APPROVE 2026-11-16）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| F-1 幅 375px でダイアログが点群（押した結果）を隠した | must | 作業エージェントは PC 幅の画面でしか見ておらず、狭い幅は「幅 375px で収まる」と設計で済ませた。テストと CI は DOM の存在しか見ないので、「結果が見えるか」は誰も機械的に見ていなかった | スクリプト: `scripts/ui-shots.mjs` が 375px と 1280px で操作の前後を自動で撮る（手で Playwright を組む手間を無くす）。決まり: AGENTS.md「UI を足す・変えたら、画面を撮って自分の目で見る」（画像のパスと所見を報告に書く）。見た目の判断そのものは自動化できないので、撮る手間を下げて「見る」を必須にした | `scripts/ui-shots.mjs`、AGENTS.md（作業エージェントの決まり） |
| F-2 カーソルズームの式がクラスの中でテスト無し。なのに「確かめた」と書いた。ファイルも 1000 行超からさらに増えた | must | 数式をクラスのメソッドに直接書き、「画面で確かめる」で済ませた。さらに記録の「確かめた」に根拠を求める決まりが無かった。既に大きいファイルに足す抵抗が無かった | テスト: `src/code-limits.test.ts` が、800 行超のファイルの新設と、超えているファイルの増加（BASELINE）で落ちる（`npm test` なので CI も）。決まり: AGENTS.md「『確かめた』には根拠を添える」「数式は純粋な関数に出してテスト」 | `src/code-limits.test.ts`、AGENTS.md。元の誤り（renderer に1行足す）で落ちることを一時的に確かめた（1310 行 > 上限 1309 で失敗） |
| F-3 平行投影のズームで注視点が視線方向へ滑り、往復すると画面が空になりうる | should | 1回のズームだけを考え、「引く→回す→寄る」を重ねた後の不変条件（データが奥行き範囲に入る）を考えなかった。テストも1回の操作しか見ていなかった | テスト: R2 で `projection.test.ts` に往復後の不変条件のテストを置いた（既に入っている）。決まり: AGENTS.md「操作を重ねるものは、往復のあとも成り立つことのテストを置く」。他の操作（パン・回転）への一般化はテストの内容が個別なので、機械的な検査にはしない | `src/renderer/projection.test.ts`（22cc9a7）、AGENTS.md |
| F-4 状態を古い形（`useState` + `useCallback`）で足した（作業中に決まりが ADR-0021 の改訂で変わった） | must（コーディネーターが引き上げ） | 作業の開始時に決まりを読んだきり、途中で CLAUDE.md / ADR が改訂されたことに気づく手段が無かった | 決まり: AGENTS.md「終わる前に、決まりが変わっていないか確かめる」（`git log <開始のコミット>..HEAD -- CLAUDE.md AGENTS.md ADR` を見る）。lint 化は見送り: 「どの状態をどこに置くか」は ADR-0022（TEA）で形が変わる途中で、今ルール化すると次の改訂で壊れるため。TEA の形が固まったら lint 化を再検討する | AGENTS.md |
| F-5 「入力欄にフォーカスがあるか」の判定が4か所に別々にあり、中身が揃っていなかった（SELECT を見るのは新しいものだけ） | must | 既存の3つのうち1つの形をコピーして4つ目を書き、先に共通の関数が無いか探さなかった。判定の中身が揃っていないことを見る仕組みも無かった | テスト: `src/code-limits.test.ts` の「typing target」が、`src/app/typing-target.ts` 以外の非テストコードに、大文字の `"INPUT"`/`"TEXTAREA"`/`"SELECT"`、`isContentEditable`（型宣言を除く）、`instanceof HTML(Input|TextArea|Select)Element` のどれかがあると落ちる（検出は `findTypingTargetCopies`。行をまたぐ形も見つける。小文字は "select" ツールのモード名とぶつかるので見ない。見逃す形: `matches("input, textarea, select")`・`closest(...)`・小文字のタグ名の一覧など。これらは検査では防げず、AGENTS.md の決まり「`isTypingTarget` を呼ぶ」と監査役の差分の確認で防ぐ）。R1 の検査は「tagName と文字列が同じ行」だけを見ていて、元の4つのうち layer-delete-key.ts の形（次の行で比べる）を見逃していた（監査 RP R1 の F-RP-1）。R2 で、その元の形（77aa8e4 の1つ前の layer-delete-key.ts）を一時的に置いて落ちることを確かめ、A・B・C の形を見つけるテストも置いた。決まり: AGENTS.md に1行 | `src/code-limits.test.ts`、AGENTS.md、`src/app/typing-target.ts`（77aa8e4） |
| F-6 ショートカットが [ctx] 依存で付け直し・置き場所が Toolbar | nit | 画面全体のものを部品の中に置いた。一度きりで仕組みにするほどではない | 仕組みにしない（R2 で直した。一度きりの設計判断で、検査にすると誤検出が多い） | — |
| F-7 ラジオの名前が語の途中で折り返す | nit | 狭い幅で見ていなかった（F-1 と同じ） | F-1 のスクリーンショットの決まりで拾う（別の仕組みは作らない） | — |
| F-8 テスト名・コメントが実際（平行は 0.866 倍）と違う | nit | 式を確かめずにコメントを書いた | 仕組みにしない（一度きり。コメントの正しさを機械で見る手段が無い） | — |
| F-9 ツールチップにキー6・7が無い、レイヤーが無いのに 5 が効く、平行で新規レイヤーの距離が透視のまま | nit | ショートカット表（`VIEW_SHORTCUTS`）と表示（ツールチップ）が別々に書かれていた | 仕組みにしない（R2 で直した。ツールチップを表から生成するほどの数ではない。キーが増えるタスクで再検討） | — |
| F-10 点群のレイヤーを消して計測レイヤーだけが残ると、「視点」ボタンはグレーアウトするのに 5 キーで投影が切り替わった（AppShell が `viewer.layers.length > 0` で有効を判定） | nit | 「視点が使える条件」をボタン（`hasPointCloud`）とショートカット（`layers.length > 0`）で別々に書いた。計測レイヤーもレイヤーに数えられることを見落とした | テスト（振る舞い）: 有効の判定を `src/app/view.ts` の `ViewContext.pointCloud`（ストア）に持たせ、`runViewAction`・`showViewPreset`・`fitAllView`・`setProjection` が、点群が無いとき何もしないようにした。`view.test.ts` が「計測レイヤーだけ（pointCloud = false）」のとき投影も視点も変わらないことを確かめる。点群があるかを決める式も `src/app/view.ts` の `hasPointCloudLayer` / `syncViewEnabled` に置き（ボタンの `hasPointCloud` も同じ関数）、`useViewShortcuts.test.tsx`（jsdom）が「計測レイヤーだけ → 5 で変わらない／点群あり → 変わる／レイヤーを消すと止まる」を通す。元の誤りを一時的に戻して確かめた: ①フックの同期呼び出しを消す → 2 件落ちる、②判定を `layers.length > 0` に戻す → view.test.ts と useViewShortcuts.test.tsx で各 2 件落ちる（AppShell が `viewer.layers` 以外を渡す誤りは、AppShell を描く手段が無いので検査していない）（R1 の文字列検査は、`hasPointCloud(` が別の形で書かれても通るので、監査 RP R1 の F-RP-2 で消した） | `hasPointCloud(viewer)` に統一（012c6db）、`src/app/view.ts`・`src/app/view.test.ts`・`src/ui/toolbar/useViewShortcuts.ts` |

## RF-0/1/15（2026-11-16、監査: R2 で APPROVE、再発防止: R2 で APPROVE 2026-11-16）

根本原因は 2 つにまとまる。(A) **検査を別の仕組みに置き換えたとき、前の検査が捕まえていた物を全部捕まえるかを確かめなかった**（F-1・F-2・F-3・F-5・F-6）。
置き換えの受け入れ基準を「新しいルールが、わざとの違反で落ちる」（RF-1 の AC-2）としか書かず、「前の検査が落とした物で落ちなくなる物が無い」を持っていなかった。
(B) **文書に書く事実を、コードを開いて確かめずに、REVIEW の文や記憶から写した**（F-7）。

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| F-1 ESLint の `no-restricted-imports` が動的 `import()` を見ず、grep からの置き換えで検査が後退した | must | (A)。`no-restricted-imports` が import 文しか見ないことを知らず、grep が文字列を全部見ていたこと（動的 import・export-from・require も落としていた）を数えなかった | テスト: `src/layer-rules.test.ts` の「everything the old CI greps caught is still caught」。旧 grep が捕まえた形（import・export-from・動的 import・型の import・require・JSX、全部の層とファイル種別）を固定したケース（ファイル全体で 140 ケース）。決まり: AGENTS.md「検査を置き換えるときは、前の検査が捕まえていた形を全部捕まえることをテストで固定」。元の誤り（`ImportExpression` のセレクタを消す）で 15 ケースが落ちることを一時的に確かめ、戻した | `src/layer-rules.test.ts`、`eslint.config.js`（`require()` のセレクタを足した）、AGENTS.md |
| F-2 型の位置の `import("…").X`（TSImportType）を見ない | should | F-1 と同じ（(A)）。TypeScript 固有の import の形を一覧にしなかった | F-1 のテストと、`layerRules()` がパターンを import 文・`import()`・型の `import()`・`require()` の全部に同じ正規表現で展開する作り（パターンを 1 つ足せば全部に効く）。別の仕組みは作らない | 同上 |
| F-3 `RENDERER_CLASS` が拡張子つき（`.ts`・`.js`）を見ない | should | 正規表現を import 文の文字列の見た目だけで書き、tsconfig の `allowImportingTsExtensions` を見なかった | テスト: F-3 のケース（拡張子つき）。設定との食い違いを自動で見る仕組みは作らない（tsconfig の他の設定がルールを変える場合は、その場で足す） | `src/layer-rules.test.ts` |
| F-5 正規化していないパス（`./../x` など）でプラグインのルールをすり抜ける | nit | 「`../` の数」で判定する作りの限界を、書いた時点で数えなかった | lint: 正規化していないパスを `src/app`・`src/plugins` で禁止（`UNNORMALIZED`）。テスト: F-5 のケース。限界（深さ 9 以上、`../state` の index）は `eslint.config.js` と RF-safety-net.md に書いた | `eslint.config.js`、`src/layer-rules.test.ts` |
| F-6 層のルールが `.js`・`.mjs` を見ない（`files` が `ts,tsx` だけ） | nit | 旧 grep は拡張子を問わなかったことに気づかなかった（(A)） | テスト: F-6 のケースと、F-9（生成物の `src/wasm/**` は見ない）。旧 grep の形のテストにも `src/zz.js`・`.mjs` を含めた | `src/layer-rules.test.ts` |
| F-7 文書の事実の誤り: ROADMAP「HTML/SVG」（実際は Canvas 2D と SVG）、`pcv-convert/Cargo.toml` の description（まだ「スパイク」）、記録の「版が動いた」の一覧（`detect-libc` などは動いていない） | nit（監査役の判定。R1 の指摘では should と書かれていた） | (B)。REVIEW の文・記憶から写し、該当のコード（`section-2d.ts` の先頭のコメントなど）・`git diff` を開かなかった。CLAUDE.md の「数値は実際に実行したコマンドの出力から」は数値だけで、機能の説明・一覧には効いていなかった | スクリプト+CI: `scripts/check-doc-paths.mjs`（`npm run check:docs`、CI の `frontend` ジョブ）が ARCHITECTURE.md・ROADMAP.md・CLAUDE.md の中のパスと相対リンクの存在を見る（RP R2 で ROADMAP を足し、テスト `scripts/check-doc-paths.test.ts` で ROADMAP の存在しないパスが落ちることを固定した。許可リストは完全一致だけで、実在するようになったら落ちる）（RF-0 の AC-1 のワンライナーを置き換えた）。決まり: AGENTS.md「文書に書く事実は、書く前にコードを開く／コマンドを実行して確かめ、方法を作業報告に書く」と、作業報告の形式に「文書に書いた事実の確かめ方」の行。**事実の中身（機能の説明・版・数）は機械で見られない**ので、ここは決まりと報告の欄に頼る（弱い仕組みであることを承知で残す） | `scripts/check-doc-paths.mjs`、`package.json`、`ci.yml`、AGENTS.md |

- `npm run check:docs` が落ちることの確認: CLAUDE.md の末尾にわざと存在しないパス（`src/app/not-here.ts`）と相対リンクを足して実行 → 終了コード 1 とその 2 件を表示（確かめて戻した）。現状は `OK`
- 仕組みにしなかったもの: 作業報告の「文書の事実の確かめ方」の中身の真偽（監査役が見る）
- RP R2（監査役の指摘）: F-RP-1 `check:docs` の対象に ROADMAP を足し、AGENTS.md の文に対象のファイルを明記した。F-RP-2 層のルールの `files` に `.jsx`・`.mts`・`.cts` を足した（赤のテスト 4 件が緑）。
  F-RP-3 `NOT_BUILT_YET` を完全一致にし、実在するようになったら落とす。F-RP-4 旧 grep の `[^'"]*state/use[A-Z]` は `../appstate/useX` のような別名のフォルダも捕まえた。
  今の `(^|/)state/use[A-Z]` はフォルダ名が `state` のときだけ捕まえる。**意図した変更**（`appstate` は src/state ではない。誤検出の方が害になる）。
  F-RP-5 `check-doc-paths.mjs` の先頭のコメントに限界（対象の文書、`](./…)` 以外のリンク、`{a,b}` 形のパス）を書いた

## PF-0（2026-11-16、監査: R4 で APPROVE、再発防止: R3 で APPROVE 2026-11-16）

PF-0 は 4 ラウンドかかった。指摘は 3 つの根本原因に集まる: (A) **確かめずに書いた**（計測の読み違い、設計がコードと食い違う）、(B) **数え漏らした**（共有の資源・経路・使い手）、(C) **コーディネーターの部分を書き換えた**。
下の表は指摘ごと、その後に根本原因ごとの掘り下げと、仕組みを入れたあとの検証を書く。

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類） | 置いた場所・コミット |
|---|---|---|---|---|
| R1 F-1 出力と合わない数値（CSV の桁区切りで 1 GiB 超が落ちた、最初のノードの時間の取り違え） | must | A1 | サンプラーが桁区切り無しで書く＋CSV を厳密に読む（列数・数値が合わない行はエラー）（スクリプト＋テスト）。Web の計測を道具にし、範囲を道具が出す（スクリプト＋テスト）。表の数値は道具の出力から写す（決まり） | `scripts/bench/sampler.ps1`・`run-native.ps1`・`summarize-samples.mjs`(+test)・`web-first-open.mjs`・`summarize-runs.mjs`(+test)、AGENTS.md |
| R1 F-2 ADR がレンダラの実際（階層固定・無効化の口が無い）を確かめず「レンダラは変えずに」と書いた | must | A2 | ADR の雛形に「依存するコードの確認」（`path:line`・識別子・読んで確かめたこと、3 行以上）を必須にし、参照が実在するかを検査（スクリプト＋CI） | `TaskSheets/ADR-TEMPLATE.md`、`scripts/check-adr.mjs`(+test)、`npm run check:docs`、`.github/workflows/ci.yml` |
| R2 F-12 世代つきキーがレンダラ（AN-1 のフェード・`parentKey`）と合わない／R3 F-19 `key` の使い分けがコードと合わない | must | A2（F-2 と同じ。3 ラウンド続いた） | 同上。加えて、API の形を決める ADR は、その値を使う箇所を全部挙げる（「数えた物」に `rg` の結果）（決まり＋雛形） | 同上 |
| R1 F-3 切り替えの瞬間に点がまばらになる、R2 F-13 点予算が全レイヤー共有で条件が成り立たない | should | B（共有の資源を使う者を全部挙げていない） | 雛形の「数えた物」: 共有の資源は使う者を全部挙げ、コマンドと出力を載せる。ADR-0024 では `selectNodesForLayers` が 1 つの予算を使うことを表に入れた（決まり＋検査は節の有無だけ） | `ADR-TEMPLATE.md`、`check-adr.mjs` |
| R1 F-4 変換の入口を 1 つしか数えなかった、F-5 落ちない仕組みが大きい消費者（NodeCache・変換・Web の変換）に効かない | should | B | 同上（「数えた物」。メモリのように使う者が複数いる資源は、全部を表にする） | 同上 |
| R1 F-6 TEA・プラグインとの整合、F-7 PF-1 の AC に数値の線が無い | should | A2／雛形が無かった | 雛形の「整合の確認」（ADR-0022・0023 を名指しした節が無いと CI が落ちる）と「受け入れ基準の案（数値の線）」（前者は検査、後者は決まり） | `ADR-TEMPLATE.md`、`check-adr.mjs` |
| R2 F-11 作業エージェントがタスクシートの受け入れ基準と記録を消した・書き換えた | must | C | コーディネーターの部分（「記録」節の外）が変わったら落ちるスクリプト。作業の終わりと監査で実行（スクリプト＋テスト＋決まり） | `scripts/check-task-sheet.mjs`(+test)、AGENTS.md |
| R2 F-14 変換のメモリ予算を途中で変えられると仮定した、F-15 PF-1 の範囲と AC の食い違い | should | F-14: A2。F-15: 一度きり | F-14 は「依存するコードの確認」の `writer.rs:759`。F-15 は仕組みにしない（範囲を決める判断の食い違いで、コーディネーターの判断で直った。雛形の「受け入れ基準の案」に範囲を書く欄がある程度） | `ADR-0024`、`ADR-TEMPLATE.md` |

### 根本原因の掘り下げ

**A1 計測の読み違い（F-1）。**
- 起きたこと: サンプラーが `{0:N0}` で書いた値が `1,040` となり、CSV の列が割れた。読む側は `awk -F,` で列の数を確かめず、1 GiB を超えた値を**黙って落とした**（ピークが 974 MiB 以下に見えた）。最初のノードの読み出し時間は、10 枚の 31.8 ms だけを見て「32〜40 ms」と書いた。
- 根本原因は 3 つ。(1) 書く側が文化依存の書式で、読む側が合わない行を捨てた（失敗が静か）。(2) 表の数値を、複数回・複数シナリオの出力から**目で**まとめた。(3) 作業時点で自分の表を出力と突き合わせる手順が無かった。
- 仕組み: (1) は書式を `InvariantCulture`・`F0` に固定し、読む側は列数・数値形式が合わなければ**エラー**（`summarize-samples.mjs`）。(2) は範囲（最小〜最大・回数）を `summarize-runs.mjs` が全回から出す。(3) は AGENTS.md に「表の数値は道具の出力から写す」。
- 限界: 手で打った数値の写し間違い自体は防げない（監査役が出力と突き合わせる）。計測の道具のうち、ネイティブの `convert_timings`・`merge_las_to_copc` の出力の読み取りは今まで通り手でやる。

**A2 設計がコードを確かめずに書かれた（F-2・F-12・F-19、3 ラウンド）。**
- 起きたこと: R1 は「レンダラは変えずに」、R2 は世代つきキー（フェードと `parentKey` に合わない）、R3 は `key` と位置のキーの使い分け（`hierarchyByKey`・選択・`readNode` の全部が `key` を使う）。ラウンドごとに、監査役が**別の箇所**を開いて新しい食い違いを見つけた。
- 根本原因: (1) 設計の文書に「どのコードを読んだか」を書く場所が無く、名前（`parentKey` など）を知っているだけで、その呼び出し元・使い手まで読まなかった。(2) 直すたびに、直した部分だけをコードと突き合わせ、同じ部品の**他の使い手**（今回は `key` の全使用箇所）を調べ直さなかった。(3) 作業エージェントの自己点検が、ADR の文章の整合だけで、コードとの整合ではなかった。
- 仕組み: ADR の雛形に「依存するコードの確認」を**必須の節**にし、`path:line`・識別子の組が実在するかを `scripts/check-adr.mjs` が検査する（CI でも走る）。ファイルが無い・行が無い・識別子が行の近く（20 行以内）に無いと落ちる。
  これで「コードを開かずに名前だけで書く」「コードが動いて参照が古くなる」は捕まる。さらに、API の形（キーなど）を決める ADR は、その値の**全使用箇所**を `数えた物` に `rg` の出力で載せる決まりにした。
- 限界（正直に）: スクリプトは「その箇所を挙げた」ことしか確かめられず、「前提」の欄の文が正しいかは確かめられない。そこは監査役が見る（AGENTS.md の監査の手順に `npm run check:docs` と「前提の欄を、挙げられた箇所と照らす」を足した）。
  ただし R1〜R3 の 3 件はいずれも「挙げるべき箇所を挙げていれば、書いている間に気づけた」種類で、挙げさせる効果は大きいと見ている（推定。次のタスクの指摘の数で確かめる）。

**B 数え漏らし（F-3・F-4・F-5・F-13）。** 「経路は 1 つ」「メモリの使い手は下見だけ」「点予算は下見と COPC で別」は、いずれも**全体を数えずに**書いた。仕組み: 雛形の「数えた物」（数えたコマンドと出力、または「なし」。空だと CI が落ちる）。数え方の正しさは検査できない（決まり）。

**C 受け入れ基準の書き換え（F-11）。**
- 起きたこと: R2 でタスクシートの記録を直すとき、ファイルを「見出しから見出しまで」文字列で切って組み直し、その範囲に入っていたコーディネーターの AC-4・「### PF-1 以降」・「## 記録」を消して、AC-4 を設計の要約に置き換えた。
- 根本原因: (1) コーディネーターの文と作業エージェントの記録が**同じファイル**にあり、編集の道具（文字列で切る）が境界を知らなかった。(2) 編集のあと、`git diff` の**削除側**を見て確かめなかった。(3) AGENTS.md に「受け入れ基準を緩めない」はあったが、「書き換えない」とそれを機械で見る手段が無かった。
- 仕組み: `scripts/check-task-sheet.mjs <ループ開始前のコミット>`: 「記録」節の外の行が 1 行でも変わる・足される・消えると落ちる。作業の終わりと監査で実行し、出力を作業報告に貼る（AGENTS.md）。

### 仕組みが本当に捕まえるかの確認（元の誤りを戻して実行した）

- `node scripts/check-task-sheet.mjs 3bfc36d a5626f4`（問題の a5626f4 と、コーディネーターの原本）→ **exit 1**。「AC-4 が変わった」「### PF-1 以降 が消えた」「## 記録 が消えた」「記録の外に行が足された」と出る。同じコマンドを今の HEAD に対して実行 → exit 0（84 ファイル OK）
- `node scripts/check-adr.mjs TaskSheets/ADR-0024-progressive-open.md` を、「依存するコードの確認」を足す前の ADR-0024 に実行 → exit 1（3 つの節が無い）。足したあと → OK。`check-adr.test.mjs` で、存在しないファイル・範囲外の行・行の近くに無い識別子（例: `hierarchyByKey` を `parentKey` の行に結びつける）を落とすことを確かめた
- `summarize-samples.test.mjs`: 初版の誤り（`5.2,1,319,8,271.6` のような桁区切りの行）が「5 columns, expected 4」で落ちることを確かめた。サンプラーを実際に動かして、新しい CSV が桁区切り無しで、厳密な読み手を通ることも確かめた（3 行、ピーク 3 MiB のテスト用の短い実行）
- `npx vitest run scripts`（C:\ の大文字のパスから）: 4 ファイル 17 テスト緑。`npx eslint scripts/...` 警告なし。`npm run check:docs` OK
- `web-first-open.mjs` は、パスを引数・環境変数にして道具に直したあと、autzen の COPC で 1 回動かして結果（`outcome: settled`）が出ることを確かめた。P コアへの固定は、道具を起動する側（PowerShell で `ProcessorAffinity`）の責任で、この 1 回は固定していない（スクリプトの先頭コメントに書いた）

### 仕組みにしなかったもの

- F-15（PF-1 の範囲と AC の食い違い）: 範囲を決めるのはコーディネーターの判断で、一度きりの調整だった
- 「前提の欄の文の正しさ」: 機械では確かめられない。監査役の手順に足すだけにした

### PF-0-RP R2 での直し（監査 F-1・F-2・F-4〜F-6）

- `check-task-sheet`: 記録の節を「見出しに『記録』を含む節」にし（どのレベルでも。TP の「### 実装の記録 R1」の形を通す）、条件を「コーディネーターの行が、記録の外に全部残っている」にした（記録の見出しを AC の前に差し込んで飲み込ませても、AC が消えた扱いで落ちる）。
  `ee5ecb0→85932de`・`9a312db→3bfc36d`・`85932de→3bfc36d`・`ee5ecb0→3bfc36d` は exit 0（誤検出が消えた）、`3bfc36d→a5626f4` は引き続き exit 1。base はループ開始前のコミットで、コーディネーターがループ中に AC を直したら、その後のコミットにする（AGENTS.md）
- `check-adr`: 識別子は単語の境界で一致・3 文字以上・汎用語（`key`・`if` など）は不可、「前提」が空なら落とす。行の近さ（20 行以内）は、ADR が「提案」の間か、`--base` 以降に変わった時だけ見る。それ以外はファイルにその識別子が在ることだけ（関係ない PR が、採択済みの ADR で落ちない）
- 計測: `summarize-runs` が `.mem.csv` から `peak_private_mib` も出す（厳密な読み手を通す。PF-0 の元の CSV（桁区切りあり）を読ませると「5 columns, expected 4」で落ちることを確かめた）。`run-native.ps1` の affinity の遅れと `web-first-open.mjs` のポートのコメントを直した

### PF-0-RP R3 での直し（監査 F-7〜F-10）

- `check-task-sheet`（F-7）: 記録の外に足された**空でない行は全部**問題にする（「記録」を含む見出しの行だけ例外）。AC の下に「ただし Web と Android は対象外」と足す、記録の外に「## 補足」を足す、は落ちる。
  base の行が head の中で同じ順に並ぶことも見る（AC-3 と AC-4 の入れ替えは落ちる）。水平線（`---`）は区切りなので無視する（TP-1 のシートは、記録を `---` の前に挿入するので、`---` が記録に飲み込まれて順の検査が誤って落ちた。実際の履歴 `ee5ecb0→85932de` で確かめて直した）。
  テストを 4 つ足した。履歴の確認: `ee5ecb0→85932de`・`ee5ecb0→3bfc36d`・`9a312db→3bfc36d`・`85932de→3bfc36d`・`3bfc36d→HEAD` は exit 0、`3bfc36d→a5626f4` は exit 1
- `check-adr`（F-8・F-9）: 汎用語の一覧に TypeScript と Rust の予約語・標準の型（`private`・`readonly`・`interface`・`Promise`・`Result`・`Option`・`Self` など）を入れた。さらに、識別子が引いたファイルの中で**宣言か定義**（`function/const/class/fn/struct … 名前`、`名前(`、`名前:`、`名前 =`）されていることを求める（コメントに書かれているだけの語は落ちる）。文言は「キーワードか汎用語」「3 文字未満」に分けた
- **限界（正直に）**: これらの検査は、ADR が「コードを開いて名前を挙げた」ことを確かめるだけで、本気でごまかす人（宣言のある別の名前を挙げる、AC の意味を変えずに書き足す、など）は止められない。目的は「コードを開かせる」「コーディネーターの部分を黙って変えさせない」ことで、「前提」の欄の正しさと AC の意味は監査役が見る
- CI の `check:docs`（F-10）は今は `--base` 無しで走る。採択済みの ADR を PR で書き換えたときの厳しい検査（行の近さ）を CI で効かせるには、PR の base の sha を `--base` に渡す。これは本流との統合のときに決める

## TP-1-CI（2026-11-17、PR・CI の監査 trendpoint-parity-PR R1 の F-2）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| CI の rust ジョブが `cargo fmt --check` で落ちた（run 43932290047。Rust の example の整形）。ループの中では誰も気づかなかった | should | 作業役の「終わる前に必ず」の一覧に `cargo fmt` が無く、ループの監査役も Rust を触った差分で fmt を走らせなかった。CI が見るものと手元で走らせるものが別々に書かれていて、差が出ても気づく手段が無かった。決まりを後から AGENTS.md に足した（867e58a）だけでは、人の注意に頼ったまま | スクリプト: `npm run check:all`（`scripts/check-all.mjs`）。typecheck・lint・check:circular・check:docs・vitest・`cargo fmt --all -- --check`・vendor の fmt を1つ落ちても最後まで走らせ、OK / FAILED の一覧を出す（Windows では作業ディレクトリのドライブ名を大文字にして vitest の失敗も避ける）。決まり: AGENTS.md の作業役の「終わる前に必ず」を check:all に置き換え、一覧を作業報告に貼る形にした。元の誤り（Rust の example `compare_copc_nodes.rs` に整形の崩れた行を一時的に足す）で `check:all` が `FAILED cargo fmt (workspace)` を出すことを確かめた（その後 `git checkout` で戻した）。限界: wasm・e2e・tauri のビルドは CI だけ（時間と環境が要るため）。clippy（`cargo clippy --workspace --all-targets -- -D warnings`）も check:all に足した（PR 監査 R2-F-2） | `scripts/check-all.mjs`、`package.json`、AGENTS.md |
| 判定を共有する関数の直しで、Delete（確認なしでレイヤーを消す）の安全が黙って外れた（PR 監査 R2 F-1）。R1 の直しで気づかなかった | must | 「視点のキーがラジオで効かない」を直すために共有の `isTypingTarget` を変え、同じ関数を使う他の使い手（Delete・計測の Enter/Esc）の数と、その向き（壊れて困る側）を数えなかった。破壊的なキーと害のないキーでは、安全な側が逆 | テスト: `layer-delete-key.test.ts` の「チェックボックス・ラジオ・スライダーでも消さない」と、`code-limits.test.ts` の「どのキーがどちらの判定を使うか」（破壊的な3か所は `isFormControl`、視点は `isTypingTarget`）。決まり: 「どちらをいつ使うか」は AGENTS.md の作業役の決まり（「入力欄にフォーカスがあるか」の行）に書く（当初は `typing-target.ts` の冒頭コメントに書いたが、コードにコメントを書かない決まり（CM-0）で消えるため、2026-11-18 に AGENTS.md へ移した。CM-0 の PR 監査 R1 F-3）。共有の関数を変えるときは、その関数の使い手を全部数えて報告に書く（AGENTS.md の確認に足した） | `src/app/typing-target.ts`、`src/ui/layers/layer-delete-key.ts`、`src/state/useMeasureTool.ts`、`src/state/useLayerTool.ts` |

## CM-0（2026-11-17、監査: R1 で APPROVE、再発防止: RP R1 で APPROVE 2026-11-17）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| F-1 コメントの検査が WGSL のコメントを見ていない（シェーダーは TS のテンプレート文字列の中にあり、AC-2 の「文字列の中の `//` は数えない」に当たる） | should | 検査の対象を「ファイルの拡張子」で決め、CLAUDE.md の決まりが挙げる言語（Rust・TypeScript・WGSL・スクリプト・設定）と一つずつ突き合わせなかった。WGSL は独立したファイルでなく TS の文字列の中にあるので、拡張子でも字句でも見えない場所にあった。作業役は R1 で取りこぼし（138 行）を数えて記録に書いたが、検査の穴としては残した | テスト＋スクリプト: `.wgsl` を `scripts/check-comments.mjs` の対象の拡張子に足し（`LEXED_LIKE_RUST`）、`check-comments.test.mjs` の `check-comments: WGSL` で数え方を固定した。メインの決定で、CM-1 がシェーダーを `src/renderer/shaders/*.wgsl` に出して `?raw` で import するので、その時点で WGSL のコメントは `npm run check:comments`（check:all と CI の frontend）に入る。直す前の版に戻すと WGSL のテストが落ちることを確かめた。限界: シェーダーを TS の文字列の中に書き戻すと、また見えなくなる。CM-1 への申し送り: シェーダーを出し終えたら、`.ts`/`.tsx` に `/* wgsl */` の印が残っていたら `src/code-limits.test.ts` で落とす（今は `git grep -l "/\* wgsl \*/" -- '*.ts' '*.tsx'` で `src/renderer/` の 5 ファイル: depth-pick・edl・gpu-resources・ground-grid・sky。CM-1 で出した後に置く）。`depth-pick.ts` は行頭が `//` の行の取りこぼしに出なかったが、シェーダーを持つので CM-1 の範囲に入る。AGENTS.md の決まりは足さない（拡張子を足したことで、今ある言語は全部検査に入るため） | `scripts/check-comments.mjs`・`scripts/check-comments.test.mjs`（44d525a） |
| F-2 `// SAFETY:` の次の行がコメントでも、`unsafe` の語があれば許した | nit | 「次の空でない行に `unsafe` がある」を文字列で見て、それがコードかを見なかった | 仕組みにしない（直してテストを置いた: e217dbc。一度きりの判定の甘さで、同じ種類の誤りを捕まえる一般の仕組みは無い） | — |
| F-3 Rust の行コメントの本文の先頭に CRLF の `\r` が残った | nit | Windows の作業コピーが CRLF なのに、テストのケースを LF だけで書いた | 仕組みにしない（直してテストを置いた: f04dc00。出力の見た目だけで、数は変わらない） | — |
| F-4 `git mv` すると新しいパスが上限 0 で落ちる | nit | 決まりどおりの動き（上限はパスごと）。付け替えの手順が書かれていなかった | 仕組みにしない（検査が付け替えを推し量ると、別のファイルへのコメントの持ち込みも通ってしまう）。CM-0 のシートの記録に「名前を変えたら baseline のキーを手で付け替える」と書いた（08605d2）。検査は古いパスに「remove the entry」、新しいパスに上限 0 の超過を出すので、何をすればよいかは出力から分かる | `TaskSheets/CM-0-no-comments.md` |

## CM-2（2026-11-18、監査: R1 で APPROVE、再発防止: RP R1 で APPROVE 2026-11-18）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| F-1 `opfs.ts` の `attempt`・`attemptSync` の名前から「失敗を捨てる」ことが読めず、誰も使わない boolean を返していた | should | コメントを消して空になった `catch` を ESLint の `no-empty` が落とし、それを通すための関数を「どう動くか（試す）」で名付けた。消したコメント（「実害なし」「後始末は続ける」）が言っていたのは「失敗を捨てる」ことで、その結果を名前にしなかった。戻り値は「いつか使うかも」で付け、使い手を数えなかった（CM-0 の「名前に移す」は、何を名前にするかまでは言っていない） | 決まり: AGENTS.md の作業役の決まりに「コメントを名前に移すときは、何をするかより何が起きるかを名前にし、使い手のいない戻り値を作らない」を足した（例に `ignoreFailure` と、採らない `attempt`）。CM-1・3〜5 もコメントを消すと同じ空の `catch` に当たるので、そこで効く。lint・テストにしない理由: 「名前が意図を表すか」は機械で判定できず、「戻り値を誰も使わない」も、typescript-eslint に関数の戻り値の未使用を見るルールが無い（`no-unused-vars` は変数だけ。呼び出しの式文として捨てられる戻り値は見ない）。直した後: `ignoreFailure`・`ignoreFailureSync`（`Promise<void>`・`void`） | AGENTS.md、`src/datasource/opfs.ts`（6613450） |
| F-2 `SIZE_OF_A_DIR_IN_USE_BY_ANOTHER_TAB` がどんな失敗でも 0 になるのに、理由の 1 つだけを名前にしていた | nit | 仕組みにしない。F-1 と同じ根本原因（何が起きるかでなく、消したコメントが挙げた原因の 1 つを名前にした）なので、F-1 の決まりで足りる | — |
| F-3 表に `openFiles`・`reportPreparing` の理由が無かった | nit | 仕組みにしない。1,207 個のコメントから「なぜ」を選ぶ判断の漏れで、機械で拾えない。監査役が消したコメントと表を突き合わせて見つけられた | — |
| F-4 先頭の BOM が 3 ファイルで消えた | nit | 仕組みにしない。一時的なスクリプト（コミットしていない）の `trim()` が BOM も空白として扱った。BOM は動作に影響せず、そのスクリプトは使い回さない | — |

## CM-5（2026-11-18、監査: R1 で APPROVE、再発防止: RP R1 で APPROVE 2026-11-19）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| F-1 テストの小さいメモリ予算（64 KiB・256 KiB）の理由（octree をディスク上で分けさせる。既定ではメモリの中で終わる。ADR-0019）を消し、名前に移さなかった | should | 3,237 個を一時的なスクリプトでまとめて消し、「なぜ」を探すのを、`src/` の行の中のコメント（`///`・`//!` を除く）をキーワード（「ため」「実測」「ADR」など）で grep した結果だけに絞った。テスト（`tests/`・`mod tests`）を見る対象から外したので、**テストの数値の理由**を見落とした。数値の理由は「理由の語」を含まない文（"A small memory budget makes the octree split on disk"）で書かれていることが多く、キーワードでは拾えない | スクリプト＋テスト: `scripts/removed-comments-near-literals.mjs <base> <パス…>`。base にあって今は無いコメントのうち、すぐ後（8 行以内）か同じ行に、名前の無い数値（0・1・2 以外）か 3 文字以下の文字列が**変わらずに残っている**ものを、行ごとに1件で出す。`removed-comments-near-literals.test.mjs` の 7 ケース（F-1・F-2 の形を含む）で固定した。元の誤り（付け替え前の R1 の `97a507b`。付け替え後は `e357ec0`）に当てると、F-1 の 3 か所（`import/convert.rs:232`・`tests/streaming_conversion.rs:476`・`tests/import_merge_memory_is_bounded.rs:112`）と F-2（`src-tauri/src/lib.rs:227` の `"*"`）が出ることを確かめた（R1 の全体で 193 件）。決まり: AGENTS.md の作業役の決まりに「CM タスクでは終わる前にこれを実行し、出た行ごとに名前にするか判断し、件数と名前にしなかった理由を持つ値を報告に書く」を足した。CM-1〜CM-4 も同じ base（ループ開始前のコミット）と自分の範囲で使える（TS・JS・WGSL も読む） | `scripts/removed-comments-near-literals.mjs`・`.test.mjs`、AGENTS.md |
| F-2 `pcv://` の応答の `Access-Control-Allow-Origin: *` の理由（開発中は devUrl `http://localhost:1420` から fetch するのでオリジンが違い、無いと "Failed to fetch"）をどこにも残さなかった | should | F-1 と同じ（関数の上の `///` は、キーワードの grep の前に `///` を除いていたので見なかった）。加えて、**本番では見えない開発時だけの理由**は、テストも本番の動きも落ちないので、消しても何も赤くならない | 上と同じスクリプトが `"*"` を出す。直しでは、関数 `allow_fetch_from_dev_server_origin` に出し、テスト `every_pcv_response_allows_fetch_from_the_dev_server_origin` で4つの応答が全部ヘッダを持つことを確かめる（ヘッダを消すと落ちる。理由は関数の名前と CM-5 のシートの表にある） | `src-tauri/src/lib.rs`（9ce7be9） |
| 構成の負債: `PROGRESS_REPORT_STRIDE` を `import/convert.rs` と `streaming.rs` の2か所で持ち、「同じ値」のコメントが消えた | should | 「同じ値を持つ」というコメントが2つの定義をつないでいたのに、コメントを消すときに2つを1つにまとめなかった。同じ形の `READ_BATCH_SIZE`（`streaming.rs`・`merge.rs`・`import/las.rs`）も同じだった | 直した（4410008、`READ_BATCH_SIZE` も1つに: 0696974）。仕組みにはしない: 「同じ名前・同じ値の定数が複数ある」を機械で見ると、examples（クレートの外から `pub(crate)` を使えない）やテストの意図的な複製も当たり、判断が要る。上のスクリプトは、消えたコメントの後に残った数値として、この形（`const READ_BATCH_SIZE: u64 = 1024 * 1024;` の3か所）も出したので、見落としは同じ仕組みで捕まる | `crates/pcv-convert/src/streaming.rs` ほか |
| F-3・F-4（nit） | nit | F-3 は同じ値 0 の定数を別の意味の欄に流用した。F-4 は2つ並んだ `unsafe` の1つ目の前だけに `// SAFETY:` を置いた | 仕組みにしない（直した: 2131c14・177954c）。F-4 の形は `clippy::undocumented_unsafe_blocks`（pedantic でなく restriction）で捕まえられるが、`vendor/` を除いて有効にする設定と、既存の `unsafe` の全部への適用が要り、CM-4 の範囲（`pcv-wasm`）にも及ぶので、ここでは入れない | — |

### 限界と、仕組みを当てた結果

- スクリプトは「数値・短い文字列の近くのコメント」しか見ない。数値を持たない理由（「`File::try_clone` はシーク位置を共有するので開き直す」のような、手順の理由）は出ない。その種類は R1 で `src/` の行の中のコメントを読んで表に書いた分に頼っている
- 出る件数は多い（CM-5 の今で 186 件。大半はテストのデータ）。出た行を全部直す必要は無く、「理由を持つ値か」を1件ずつ見る道具。見た結果、CM-5 では `READ_BATCH_SIZE` の3か所の重複（1つにまとめた）、PLY の `257`（`U8_TO_U16_FULL_RANGE_FACTOR` にした）、`MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES`・`RASTER_MAX_CELLS_DESKTOP`・`default_pool_size` の `4`（シートの表に足した）を直した

## CM-1（2026-11-19、監査: R2 で APPROVE、再発防止: RP R1 で APPROVE 2026-11-19）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| R1 F-1 `points.wgsl` に空行が 2 行続いた（`${ELEVATION_INTENSITY_RAMP_WGSL_SRC}` の行を消した跡。AC-3） | must | 空行の跡を消す処理を、コメントを消した場所にだけ掛け、テンプレートの値を抜いた場所（同じ「行を消した跡」）には掛けなかった。手で見た「空行の跡」の検査（awk）も `src/renderer/*.ts` だけで、新しく作った `.wgsl` を対象に入れなかった。lint・整形の道具は `.wgsl` を見ないので、どの検査にも掛からなかった | テスト: `src/renderer/shaders/shaders.test.ts`「no shader file keeps two blank lines in a row where a comment or a template value was removed」（監査役の赤のテスト。`shaders/*.wgsl` を全部読み、5 ファイルあることも確かめる）。R1 の `points.wgsl` に戻すと落ちることを確かめた（R2 の記録）。限界: TS の空行は見ない（TS は lint と、行数に頼る） | 718fe21 |
| R1 F-2 `device.lost` の `.catch(() => {\n})` が空のまま残り、捨てる理由（reject しない）が消えた | should | コメントだけが中身だったブロックを、機械的に消した後に「中身が空になった所」を探さなかった。CM-2 で同じ形が出て決まり（AGENTS.md の「何が起きるか」を名前に）が入ったが、CM-1 は並行していて知らなかった | 決まり: CM-2 が足した AGENTS.md の行（空の `catch` は「何が起きるか」の名前の関数に）。CM-1 は `ignoreRejection` にした（RP で `ignoreBecauseDeviceLostNeverRejects` から改名）。lint（`@typescript-eslint/no-empty-function`）は入れない: 名前の付いた空の関数そのもの（`ignoreRejection`）も落とすので、決まりで足りる形を lint で禁じることになるため | `src/renderer/gpu-resources.ts`（718fe21・RP） |
| R1 F-3・R2 F-7 理由を文にした長い名前（`YELLOW_SO_GREEN_TO_RED_IS_NOT_MUDDY`・`MIN_CONCURRENCY_SO_FEW_CORES_DO_NOT_SERIALIZE`・`UP_TOO_CLOSE_TO_Z_FOR_A_Z_SEED`・`UP_IS_AN_AXIS`・`CONCURRENCY_MEASURED_IN_ADR_0007`）。CM-3 でも同じ傾向（`layerPanelStartsOpenExceptOnANarrowScreenWhereTheDrawerWouldCoverThePoints` など） | should / nit | CM-0 の「なぜの移し方」が「1. 名前にする」を先頭に置き、例も `// wasm32 is single-threaded` → `WASM32_IS_SINGLE_THREADED` と、理由の文をそのまま名前にする形だった。そのため「理由を消さずに残す」ことを名前で果たそうとし、「それが何か」を表す名前と「なぜか」を書く表を分けなかった。表という置き場があるのに、名前と表の役割分担が決まりに無かった | 決まり: AGENTS.md の作業役の決まりに「名前は『それが何か』（値の意味・単位）だけ、『なぜ』は表」と、文の形の名前の目印（`_SO_`・`_FOR_A_`・`_IS_AN_`・`Because`・`_MEASURED_IN_…`）と例を足した。仕組み（機械）にしない理由: CM-1 の時点の `src/` で 5 語以上の名前は 49 個あり、文の形はそのうち 4 個（`git grep -ohE` で数えた）。残り 45 個（`DESKTOP_POINT_CACHE_MEMORY_BUDGET_BYTES`・`estimatePointCountForLasFile` など）は単位や対象を並べた普通の名前で、長さの上限は誤検知の方が多い。接続詞の一覧で見る案も、`is`・`for`・`to` は普通の名前（`isTypingTarget`・`waitFor…`・`toScreen…`）に多く、4 語の `UP_IS_AN_AXIS` も長さでは捕まらない。監査役が差分の新しい名前を見る（決まりの行を根拠に指摘できる） | AGENTS.md（作業役の決まり）、改名は RP のコミット |

- CM-0 のシート（例外・「なぜ」の移し方）の「1. 名前にする」の例が文の形のままなのは、CM-0 のメインの部分（記録の外）で、作業役は変えられない。CM-2〜5 がまだ動いているなら、メインがその例を直すか、AGENTS.md の新しい行を指すことを勧める

## CM-3（2026-11-19、監査: R2 で APPROVE、再発防止: RP R1 で APPROVE 2026-11-19）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| R1 F-1 コードから読めない「なぜ」が移されずに消えた（`sectionAxes` が Rust と同じ組み立て、レイヤーパネルの初期の開閉と E2E、portal の理由、型の再エクスポート、`converting` に進捗を入れない理由（R5）、断面の地表線を元のレイヤーから計算する理由、レンダースケールの決め打ち） | must | 作業役は、消す前の全コメント（約 3,000 行）を一度通して読み、「大事な理由」を自分の判断で選んで表に移した。読む量に対して、消した1件ずつに「移し先」を付ける手順も一覧も無く、注意だけに頼った。選ぶ基準も「外部の不具合・測った値」（CM-0 の例）に寄り、手順の理由（なぜこの順か、なぜ状態に入れないか、なぜこの組み立てか）を落とした。CM-5 の道具（`removed-comments-near-literals.mjs`）は消したコメントの近くに残った名前の無い数値を出すので、数値の無い手順の理由は拾えない | スクリプト＋テスト＋決まり: `scripts/removed-comment-reasons.mjs <base> <パス…>` が、base にあって今は無いコメントのうち理由の語（because・so that・never・must・not in・twin・same as・ため・ので・と同じ・に合わせ・避け・未検証・実測 など）を含むものを `ファイル:行` で全部出す（コードは `check-comments.mjs` と同じ字句解析、yml・toml・ps1・.gitattributes は `#` の行）。AGENTS.md の作業役の決まりに「コメントを消すときは、この一覧の各行の移し先を確かめ、件数を作業報告に書く」を足した。テスト `removed-comment-reasons.test.mjs` が F-1 の文の形を固定する。確かめたこと: d05c858 と今の src/app・src/state・src/ui で 207 件を出し、F-1 の7件（`section-3d.ts:3`・`AppShell.tsx:62`・`LayerActions.tsx:11`・`LayerContextMenu.tsx:13`・`useCopcViewer.ts:17`・`open-files.ts:42`・`:50`・`point-cloud-tools.ts:182`・`layers.ts:35`・`RenderScaleDialog.tsx:4`）が全部一覧に入る（最初の語の一覧では `section-3d.ts:3`（twin）と `open-files.ts:50`（Not in）が漏れたので語を足した）。限界: 理由の語を含まない理由は拾えない。一覧は「移し先があるか」までは見ない（表の行とコメントを機械で突き合わせると、言い換えた行を誤って落とすため）。作業報告の件数と表を監査役が抜き取りで見る | `scripts/removed-comment-reasons.mjs`・`.test.mjs`、`AGENTS.md`（作業役の決まり） |
| R1 F-2 消したコメントを指す文書が残った（`docs/book/src/frontend/state.md` の「各 hook の先頭のコメントを読めば」、ADR-0016 の「`ci.yml` の `rust` ジョブのコメント」） | should | CM-0 の範囲の表は文書（`docs/`・`TaskSheets/`）を対象外にし、コメントを消す側が「そのコメントを指す文書」を探す手順が無かった。`check-doc-paths.mjs` はパスの実在しか見ないので、パスは残ったまま中のコメントが無くなっても通る | スクリプト＋テスト＋決まり: 同じ道具の `--docs` が、設計書・ADR・ARCHITECTURE・CLAUDE・AGENTS のうち「コメント」とコードのファイル名（または冒頭・先頭・モジュール）を同じ行に書いている行を出す。上と同じ決まりで件数を作業報告に書く。確かめたこと: d05c858 の state.md の 79・119 行目と ADR-0016 の 37 行目を出す（テスト `finds the lines of CM-3 R1 F-2`、ADR-0016 は d05c858 版を読んで確かめた）。今は 17 行を出し、残りは CM-1・CM-2・CM-4・CM-5 の範囲のコメントを指す ADR-0007・0008・0010・0012・`docs/book/src/rust/pcv-convert.md:151` など。限界: 一覧で、CI では落とさない（今落とすと他の CM の範囲で全部赤になる。全部の CM が終わって 0 件になったら CI に入れるかをメインが決める） | 同上 |
| R2 F-4 理由まで入れた長い名前（`layerPanelStartsOpenExceptOnANarrowScreenWhereTheDrawerWouldCoverThePoints` など 17 個） | should | CM-0 の「なぜは名前に」を、理由の文をそのまま名前に入れることだと読んだ。名前に入れるのは「それが何か」で、「なぜ」は表、という区別が決まりに無かった。CM-1 でも同じ形が出ている | 決まり: CM-1 の作業役が AGENTS.md の作業役の決まりに足す「名前は『それが何か』（値の意味・単位）だけ、『なぜ』はタスクシートの表」に任せる（同じ趣旨の行を二重に足さない）。CM-3 では 17 個を短い名前にし、表の各行に理由があることを確かめた（4d3afc2）。採らなかった案: 識別子の長さを `src/code-limits.test.ts` で上限（例 40 文字）にする。今の最長は `DESKTOP_POINT_CACHE_MEMORY_BUDGET_BYTES`（39 文字、`git grep -o -E '\b[A-Za-z_][A-Za-z0-9_]{34,}\b'` で数えた）で、長さだけでは「理由が入っているか」を見分けられず、CM-1 の決まりと監査の目で足りると判断した | CM-1 の AGENTS.md の行（main に入った AGENTS.md の作業役の決まり）、4d3afc2 |

### CM-3-RP R2 での直し（監査 F-RP-1〜F-RP-4）

- F-RP-1（should）: 理由の語が F-1 の例に寄っていて、CM-3 が自分で表に移した `src/state/measure.ts` の2文（To keep precision … / so squares do not get huge）を出さなかった。語に `so`・`to keep`・`in order to`・`why`・`ように` を足し、続いた `//` の行を1つのコメントとして読むようにした（理由が2行に分かれても拾う）。出力の行番号は、コメントのうち理由の語がある最初の行。テスト「finds reasons outside the F-1 examples too」「reads consecutive // lines as one comment」で、F-1 以外の文での再現を固定した。d05c858→c718aff（付け替え前の 874a964） で 226 件を出し、`measure.ts:5`・`:76` と F-1 の箇所が入る（同じコメントの塊の中の `useCopcViewer.ts:17` は、塊の最初の理由の行 `:14` として出る）
- F-RP-2（nit）: `--head <ref>` を足し、作業コピー以外のコミットにも当てられるようにした
- F-RP-3（nit）: `--docs` が AGENTS.md の自分の決まりの行を出していたので、`removed-comment-reasons` を含む行を除いた（テストのケースを足した）。今は 17 行
- F-RP-4（nit、CM-3 のコード）: `playwright.config.ts` の `REUSE_EXISTING_SERVER` は設定のキーをなぞっただけだったので、リテラルの `false` に戻した（理由は CM-3 のシートの表）

## CM-4（2026-11-19、監査: R1 で APPROVE、再発防止: RP R1 で APPROVE 2026-11-19）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| F-1 シートに書いた wasm の大きさが変わった理由が違った（「panic の行番号などの文字列が縮んだ」と推定。実際の主な原因は、panic の位置に埋め込まれたビルドしたディレクトリの絶対パス 37 か所） | should | 生成物の差の理由を、差の中身（どのバイトが変わったか）を見ずに、変えたこと（行が減った）から推した。「推定（未検証）」と書いたので嘘ではないが、確かめる手段（パスの頭を揃えて比べる・エクスポートとインポートの数を比べる）があったのに使わなかった。生成物にビルドした場所の絶対パスが入るので、worktree が違えば中身が変わることを知らなかった | 注意: 生成物の差の理由を書くときは、差の中身を見てから書く。見ていなければ理由を書かずに「理由は未確認」とだけ書く。仕組みの直し（`--remap-path-prefix` などでパスを入れない）は、メインが別タスクに起こす（構成の負債。CM-4 では直さない）。限界: 機械では見ていない | `TaskSheets/CM-4-remove-comments-pcv-core-wasm.md` の記録の訂正（1314599） |
| F-2 GeoTIFF に書ける EPSG の境界（1..=32766）を `raster/geotiff.rs` では定数にしたが、`crs/mod.rs` の2か所・`crs/describe.rs`・`raster/output.rs` は数値（`(1..=32766)`・`< 32767`）のまま残した | should | コメントを名前に移すとき、いま開いているファイルの数値だけを名前にし、同じ数値・同じ規則がほかのファイルにあるかを `git grep -nw` で探さなかった。境界の書き方が `<= 32766`・`< 32767`・`>= 32767` とばらばらで、同じ規則だと見て取りにくかった | テスト: 規則を関数 `crs::is_geotiff_epsg_code` 1つにして5か所から呼び、境界のテスト `geotiff_epsg_code_is_1_to_32766` と、ほかのファイルに `32766`・`32767` が戻ったら落とす `geotiff_epsg_code_range_is_written_only_in_is_geotiff_epsg_code` を置いた。`raster/output.rs` を元の `code < 32767` に戻すと後者が「raster/output.rs has 32767」で落ちることを確かめ、戻した。決まり（提案、メインが判断）: 数値を定数・関数に切り出すときは、その数値と、±1 した数値を範囲全体で `git grep -nw` し、同じ規則なら1つにする。機械で見られるか: 「同じ規則が複数の場所に数値のまま」は一般には見られない（同じ数値でも別の意味のことが多く、`< 32767` と `<= 32766` のように数値が違っても同じ規則になる）。見つけた規則ごとに、上のような「この数値はここにしか書かない」テストを置くことはできるが、まだ見つけていない規則は守れない | `crates/pcv-core/src/crs/mod.rs`（0451a1c・d814414） |
| F-3 読み違えやすい名前・文や計算を入れた名前（`SYNCHRONOUS_ONLY_IN_A_WORKER: bool = false` を `open_with_async` に渡す、割る数を `MEASURED_ABOUT_90_PERCENT_SO_ASSERT_OVER_HALF`、`CAP_JUST_ABOVE_2004_SQUARED_…` など） | should | 「コメントを名前に移す」を、コメントの文をそのまま名前にすることと取り違えた。その結果、名前が「それが何か」でなく「なぜそうするか」を言い、値（false・2）と名前の意味がずれた。計算を名前に入れたので、値を変えると名前が嘘になる形になった | 決まり: 名前は「それが何か」（値の意味・単位）だけ。「なぜ」と計算はシートの表に書く（CM-1 の再発防止として AGENTS.md に入る予定。CM-4 では AGENTS.md を触っていない）。見直しのコマンドは CM-4 のシートの「CM-4-RP R1」の記録にある。機械で見られるか: 文の形の語（`_SO_`・`_THAT_`・`_GIVING_`・`_BECAUSE_`）を含む新しい名前は、`check-comments` と同じく差分の識別子を字句で数えれば落とせる（今は置いていない。仕様の名前 `PHOTOMETRIC_BLACK_IS_ZERO` やテスト名は除く必要がある）。値と名前の意味のずれ（`false` を「同期」と読ませる）は機械では見られないので、監査役が見る | `crates/pcv-core/**`・`crates/pcv-wasm/**`（f253c34） |

## CM-F1（2026-11-21、監査: R2 で APPROVE）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| R1 F-1 「変換・ツールの実行中なので消せません」の文が実際の状態より長く残った（変換が終わって一覧が「無し」になっても残る、閉じて開き直しても残る） | must | 表示の状態を「いつ忘れるか」を設計で決めず、「次に押すまで」にした。受け入れ基準（AC-2）が「出す」ことだけを求めていたので、出す側のテストだけを書き、消える側（開き直し・読み直し・対象が無くなる）を考えなかった。画面の確認も「押す→出る→ロックを離して消す」の一本道だけで、押した後に別の経路で状態が変わる順を撮らなかった | 決まり: AGENTS.md の作業役の決まりに「案内・警告の表示を足すときは『いつ消えるか』を先に決め、消える時ごとにテストを置く（開き直し・読み直し・対象が無くなったとき）」を足した。テスト: `src/app/scratch-cleanup.test.ts` の "forgets the busy notice when the storage page is opened again after the conversion ended"・"forgets the busy notice of a row when the list is refreshed" | 直し: f613f87。決まり: この節と同じコミット |
| R1 F-2 止められた記録のストアをモジュールの最上位で 1 つ作った（`scratchCleanupBlockedByConversion`。ADR-0021「関数は隠れた状態を持たない」から外れ、F-1 の根っこ） | should | `src/app/view.ts` の `export const viewContext = createViewContext()`（モジュールに 1 つの文脈）を手本に読み、同じ形でよいと判断した。ADR-0021 の「ストアは生成関数で作り文脈で渡す」は文書にしか無く、機械で見ていなかった | lint: `eslint.config.js` の `MODULE_STATE_SYNTAX`（`src/app/**` の最上位の `let`・`var` と、最上位の `createStore(...)` の呼び出しを `no-restricted-syntax` で落とす）。`src/layer-rules.test.ts` の "rejects module state in src/app: …"（4 件）と "allows a store created inside a function in src/app, and module state outside src/app" で固定。R1 の形（`git show 2a16563:src/app/scratch-cleanup.ts`）に一時的に戻して `npx eslint src/app/scratch-cleanup.ts` が 17 行目で落ちる（rc=1）ことを確かめ、戻した | 7c07e5f |
| R1 F-3 `onClick={() => void removeScratchDirsUnlessConverting(…)}` で失敗が処理されない reject になり、画面に何も出なかった | nit | もとからある `void` で呼ぶ形をそのまま使い、呼んだ関数が投げうるかを見なかった | 仕組みにしない（直した: f613f87。関数の中で受け止めて `reportError` に流す）。`src/ui` の `=> void ` は 20 か所あり、投げるかどうかは呼ぶ関数次第で lint では区別できない（`@typescript-eslint/no-floating-promises` も `void` を許す）。nit で一度きりのため | — |

### 限界

- lint は `createStore` を直接呼ぶ形だけを見る。生成関数をモジュールの最上位で呼ぶ形（`src/app/view.ts:26` の `export const viewContext = createViewContext()`）は落ちない。これは既存の形で、使い手が `src/ui/status/`・`src/ui/shell/`（PL-0 が並行して触る）にあるため、この節では変えていない。ビューアごとに作るかはメインの判断（構成の負債の候補）
- F-1 の「いつ消えるか」は機械で見られない（どの状態が一時的な案内かを lint は知らない）ので決まりにした

### CM-F1-RP R2 での直し（監査 F-1〜F-3）

- F-1（must）: R1 のセレクタは `VariableDeclarator > CallExpression` の直下しか見ず、`createStore(null) as Store<…>`・`{ blocked: createStore(null) }`・`export default createStore(null)`・名前空間の import（`st.createStore`）・`Object.freeze(createStore(null))` ですり抜けた。
  `CallExpression:matches([callee.name="createStore"], [callee.property.name="createStore"]):not(:function CallExpression)`（関数の外のどこでも）に替え、別名の import（`ImportSpecifier[imported.name="createStore"][local.name!="createStore"]`）も落とす。
  監査役の赤のテスト "rejects module state in src/app written another way: …"（4 件）と、足した "rejects module state in src/app hidden behind a call or a rename: …"（`Object.freeze`・別名、2 件）で固定。`npx eslint --stdin --stdin-filename src/app/zz-probe.ts` で上の 6 つの形が rc=1、関数の中の `createStore` が rc=0
- F-2（should）: テストのファイル（`src/app/**/*.test.*`）は `ignores` で外し、層の規則（React・フックの import、JSX）だけを当てる別の設定にした。監査役の赤のテスト "allows a top-level let in a test file in src/app" と、足した "still applies the layer rules to test files in src/app" で固定
- F-3（nit）: 直さない（上の「限界」のとおり、`viewContext` はメインが構成の負債として扱う）
- 残る限界: 最上位のブロック（`{ let x; }`）の中の `let`、`store["createStore"]` の形は見ない（書く理由の無い形で、手間に見合わないため）

## PL-0（2026-11-21、監査: R2 で APPROVE、再発防止: PL-0-RP R1）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| R1 F-1 Error Boundary を `Dialog` の中に置いたので、ダイアログの中身が投げるとタイトルだけの空の枠が残った | must | 「描画の例外はそのプラグインの UI だけを消す」を「Boundary で中身を包む」と読み、消える単位（枠ごと）を考えなかった。テストは「ほかが残る・報告される」だけを見て、「投げた UI の跡が残らない」を見ていなかった。描く場所ごとに別の部品で Boundary を置いたので、場所ごとに置き方がずれうる形だった | テスト: `src/ui/plugins/plugin-ui.test.tsx` の "a plugin UI that throws leaves nothing behind, in every place the host draws"。リボン・ステータス・ダイアログのそれぞれで、投げる UI を登録したときの DOM が、何も登録していないときと同じ（枠ごと消える）こと、報告されることを確かめる。「ホストの状態の描く一覧（`shortcuts` 以外のキー）が全部この表にある」も確かめるので、描く場所を足すと、その場所のケースを足すまで落ちる。R1 の形（Boundary を `Dialog` の中、閉じない）に一時的に戻すと "dialogs: the whole frame goes…" が落ちることを確かめた | 7ca3d42（監査役の赤のテストは 226a4ed） |
| R1 F-2 効果の失敗を Msg にして `update` に戻す道で、その Msg への `update` がまた同期で投げる効果を返すと、同期の無限ループで固まる | should | AC-1 の「失敗を Msg として update に戻す」をそのまま作り、「戻した先でまた失敗したら」を考えなかった。失敗の経路を1回分しかテストしていなかった | テスト: `src/app/tea.test.ts` の "reports, instead of feeding back to update, an effect that fails while update handles an effect failure" ほか2件（同期・reject・失敗の Msg の効果が dispatch した普通の Msg）。決まり: AGENTS.md の作業役の決まりに「失敗を処理に戻す道を作ったら、戻した先でまた失敗したときの行き先をテストで固定する」を足した。一般の形（失敗を戻す道を持つ全部の仕組み）を機械で見つけるのは、コードの形が決まっていないので置かない | 22fa25a、475706b（AGENTS.md） |
| R1 F-3 プラグインのプログラムの効果の失敗が `update` にしか行かず、`update` が無視すると誰にも見えない | should | AC-1 の文だけを読み、ADR-0022 の「受け入れの目安」の「効果の例外を黙って捨てない（既存のバナーとログに流す）」と ADR-0023 の「効果の例外はホストが errors.report に流す」をホストの `program` の実装と突き合わせなかった | テスト: `src/core/plugin-host.test.ts` の "reports an effect failure of a plugin program under the plugin's id and still gives the msg to update" ほか2件。仕組み（機械）にしない理由: 「ADR の決まりの文が実装に当てはまっているか」は文の意味の判断で、機械で見られない。下の F-4 の決まり（ADR と違う形にしたら ADR を直す）で、ADR を読み返す場面が作業の中に入る。監査役が ADR の「決まり」と照らす | 039681f |
| R1 F-4 ADR-0022・0023 と実装の API の形が違った（3引数の `createProgram`、`shortcuts.add` の形、`ViewNode`・`IconComponent`、enabled の先送り、Error Boundary のクラス）のに、ADR は直さずタスクシートの記録にだけ書いた | should | ADR は「決まった物」で作業役は触らないものと考え、ずれをタスクシートに書けば足りると判断した。ADR とコードの形を突き合わせる仕組みが無く、ずれは人が両方読まないと見えない | テスト: `src/core/adr-shape.test.ts`。ADR-0023 の「PL-0 の口は …だけ」に並べた名前と、ホストがプラグインに渡す `PluginHost` のキーが同じこと、ADR-0022 の最後の改訂の `Failures`・`createProgram` の宣言の各行が `src/app/tea.ts` にあることを確かめる（そろえるため、`Failures.effectFailed` をメソッドの書き方にした）。ADR の行から `program` を消す・`tea.ts` の宣言を前の形に戻すと、それぞれ落ちることを確かめた。決まり: AGENTS.md に「ADR と違う形で実装したら、同じ作業で ADR の末尾に改訂の節を足す。形が一覧や宣言なら突き合わせるテストを置く」。限界: テストが見るのは宣言と口の名前だけで、文の決まり（「組み込みも同じ API で書く」など）は見ない | fc317e1、475706b（AGENTS.md）、ADR の改訂は 7383a9b |
| R1 F-5 プラグインのショートカットと既存のキー処理（視点の F・1〜7、Delete、Enter・Escape）が同じキーで両方走る | should | ホストはプラグイン同士の重なりだけを見て、まだプラグインになっていない既存のキー処理（`window`・`document` の `keydown`）を数えなかった。移行の途中は「ホストの外にもキーの持ち主がいる」ことを前提にしていなかった | 実装＋テスト: `APP_SHORTCUT_KEYS` を断って報告する（4f1d001）。`src/core/app-shortcut-keys.test.ts` が、視点のキーの一覧とソース中のキーの比較が全部 `APP_SHORTCUT_KEYS` に入っていることを確かめる（下の F-6 で範囲を広げた） | 4f1d001、3083fdf |
| R2 F-6 F-5 のテストの正規表現が `(e\|event\|input).key ===/!== "…"` しか拾わず、`switch (e.key) { case … }`・`e.code`・`[…].includes(e.key)`・分割代入の `key`・別の変数名をすり抜けた | should | 検査を、今のコードにある書き方（`e.key === "…"`）に合わせて書き、キーを名指す書き方を先に全部書き出さなかった。AGENTS.md の「検査を置き換えるときは前の検査が捕まえていた形を全部書き出す」は置き換えのときの決まりで、新しく書く検査には当てていなかった | テスト: キーを扱うファイル（`keydown`・`onKeyDown`・`KeyboardEvent`・`ctrlKey` を含むもの）の一覧を `KEYBOARD_FILES` に固定し、増えたら落ちて人が見る。その中で、どの変数名でも `.key` との比較・逆向きの比較・配列の `includes`・`switch (….key)` の `case` を拾い、名前の付いた一覧・Set でのキーの引き当てと `event.code` は「読めない形」として一覧が空であることを確かめる。拾う形ごとのテスト（"the scanner finds every way a key handler names a key"）を置いた。監査役が挙げた形（`case "Backspace"`・`e.code === "KeyQ"`・`["Home","End"].includes(e.key)`・`const { key } = e; key === "PageUp"`・`ev.key === "Insert"`）を `Dialog.tsx` に、`keydown` を持つ新しいファイルを `src/ui/` に一時的に置くと、ファイルの一覧・キーの一覧・読めない形の3つのテストが落ちることを確かめてから戻した。限界: キーを関数の引数で渡す形（`isKey(e, "X")`）は拾わない。その形のファイルは `KEYBOARD_FILES` に入るので、増えたときに人が見る | 3083fdf |
| R2 N-8（nit） `effectFailed` 自身が投げると `dispatch` の外へ抜ける | nit | 失敗を Msg に変える関数を、失敗しないものとして扱った（F-2 と同じ根: 失敗の経路の中の失敗を考えなかった） | テスト: `tea.test.ts` "reports both errors when effectFailed itself throws, and keeps the program usable"、`plugin-host.test.ts` "reports an effect failure once, and the error of an effectFailed that throws, under the plugin's id"。F-2 の決まりが同じ形を指す | dcce8fc |

- R1 の nit（N-1 報告の文を `new Error` で包む、N-3 購読者の例外、N-5 描き方の不揃い）は R2 で直した。一度きりの形で、仕組みにはしない（N-5 は F-1 のテストが全部の描き場所を同じ形で見るので、ずれは同じテストで出る）
- R2 の N-7（`DialogSpec` に閉じたことの通知が無い）は直していない。使い手（自分のダイアログの開閉を Model に持つプラグイン）がまだいないため、PL-1 で `pcv.view` を移すときに要るかを決める（PL-0 のシートの記録に書いた）
