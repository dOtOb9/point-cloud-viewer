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

## TP-1（2026-11-16、監査: R2 で APPROVE、再発防止: 未承認）

| 指摘 | 重さ | 根本原因 | 防ぐ仕組み（種類: テスト / lint / CI / スクリプト / 決まり / 注意） | 置いた場所・コミット |
|---|---|---|---|---|
| F-1 幅 375px でダイアログが点群（押した結果）を隠した | must | 作業エージェントは PC 幅の画面でしか見ておらず、狭い幅は「幅 375px で収まる」と設計で済ませた。テストと CI は DOM の存在しか見ないので、「結果が見えるか」は誰も機械的に見ていなかった | スクリプト: `scripts/ui-shots.mjs` が 375px と 1280px で操作の前後を自動で撮る（手で Playwright を組む手間を無くす）。決まり: AGENTS.md「UI を足す・変えたら、画面を撮って自分の目で見る」（画像のパスと所見を報告に書く）。見た目の判断そのものは自動化できないので、撮る手間を下げて「見る」を必須にした | `scripts/ui-shots.mjs`、AGENTS.md（作業エージェントの決まり） |
| F-2 カーソルズームの式がクラスの中でテスト無し。なのに「確かめた」と書いた。ファイルも 1000 行超からさらに増えた | must | 数式をクラスのメソッドに直接書き、「画面で確かめる」で済ませた。さらに記録の「確かめた」に根拠を求める決まりが無かった。既に大きいファイルに足す抵抗が無かった | テスト: `src/code-limits.test.ts` が、800 行超のファイルの新設と、超えているファイルの増加（BASELINE）で落ちる（`npm test` なので CI も）。決まり: AGENTS.md「『確かめた』には根拠を添える」「数式は純粋な関数に出してテスト」 | `src/code-limits.test.ts`、AGENTS.md。元の誤り（renderer に1行足す）で落ちることを一時的に確かめた（1310 行 > 上限 1309 で失敗） |
| F-3 平行投影のズームで注視点が視線方向へ滑り、往復すると画面が空になりうる | should | 1回のズームだけを考え、「引く→回す→寄る」を重ねた後の不変条件（データが奥行き範囲に入る）を考えなかった。テストも1回の操作しか見ていなかった | テスト: R2 で `projection.test.ts` に往復後の不変条件のテストを置いた（既に入っている）。決まり: AGENTS.md「操作を重ねるものは、往復のあとも成り立つことのテストを置く」。他の操作（パン・回転）への一般化はテストの内容が個別なので、機械的な検査にはしない | `src/renderer/projection.test.ts`（22cc9a7）、AGENTS.md |
| F-4 状態を古い形（`useState` + `useCallback`）で足した（作業中に決まりが ADR-0021 の改訂で変わった） | must（コーディネーターが引き上げ） | 作業の開始時に決まりを読んだきり、途中で CLAUDE.md / ADR が改訂されたことに気づく手段が無かった | 決まり: AGENTS.md「終わる前に、決まりが変わっていないか確かめる」（`git log <開始のコミット>..HEAD -- CLAUDE.md AGENTS.md ADR` を見る）。lint 化は見送り: 「どの状態をどこに置くか」は ADR-0022（TEA）で形が変わる途中で、今ルール化すると次の改訂で壊れるため。TEA の形が固まったら lint 化を再検討する | AGENTS.md |
| F-5 「入力欄にフォーカスがあるか」の判定が4か所に別々にあり、中身が揃っていなかった（SELECT を見るのは新しいものだけ） | must | 既存の3つのうち1つの形をコピーして4つ目を書き、先に共通の関数が無いか探さなかった。判定の中身が揃っていないことを見る仕組みも無かった | テスト: `src/code-limits.test.ts` の「typing target」が、`src/app/typing-target.ts` 以外のコードに `tagName` と `"INPUT"`/`"TEXTAREA"`/`"SELECT"` を比べる書き方があると落ちる。元の誤り（自前の比較を1つ足す）で落ちることを一時的に確かめた。決まり: AGENTS.md に1行 | `src/code-limits.test.ts`、AGENTS.md、`src/app/typing-target.ts`（77aa8e4） |
| F-6 ショートカットが [ctx] 依存で付け直し・置き場所が Toolbar | nit | 画面全体のものを部品の中に置いた。一度きりで仕組みにするほどではない | 仕組みにしない（R2 で直した。一度きりの設計判断で、検査にすると誤検出が多い） | — |
| F-7 ラジオの名前が語の途中で折り返す | nit | 狭い幅で見ていなかった（F-1 と同じ） | F-1 のスクリーンショットの決まりで拾う（別の仕組みは作らない） | — |
| F-8 テスト名・コメントが実際（平行は 0.866 倍）と違う | nit | 式を確かめずにコメントを書いた | 仕組みにしない（一度きり。コメントの正しさを機械で見る手段が無い） | — |
| F-9 ツールチップにキー6・7が無い、レイヤーが無いのに 5 が効く、平行で新規レイヤーの距離が透視のまま | nit | ショートカット表（`VIEW_SHORTCUTS`）と表示（ツールチップ）が別々に書かれていた | 仕組みにしない（R2 で直した。ツールチップを表から生成するほどの数ではない。キーが増えるタスクで再検討） | — |
| F-10 点群のレイヤーを消して計測レイヤーだけが残ると、「視点」ボタンはグレーアウトするのに 5 キーで投影が切り替わった（AppShell が `viewer.layers.length > 0` で有効を判定） | nit | 「視点が使える条件」をボタン（`hasPointCloud`）とショートカット（`layers.length > 0`）で別々に書いた。計測レイヤーもレイヤーに数えられることを見落とした | テスト: `src/code-limits.test.ts` の「view enabled condition」が、`ViewButton.tsx` と `AppShell.tsx` の両方が `hasPointCloud(` を使っていることを検査する（条件を1つの関数に集めた形を壊すと落ちる） | `hasPointCloud(viewer)` に統一（012c6db）、`src/code-limits.test.ts` |

## RF-0/1/15（2026-11-16、監査: R2 で APPROVE、再発防止: 未承認）

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
| F-7 文書の事実の誤り: ROADMAP「HTML/SVG」（実際は Canvas 2D と SVG）、`pcv-convert/Cargo.toml` の description（まだ「スパイク」）、記録の「版が動いた」の一覧（`detect-libc` などは動いていない） | should | (B)。REVIEW の文・記憶から写し、該当のコード（`section-2d.ts` の先頭のコメントなど）・`git diff` を開かなかった。CLAUDE.md の「数値は実際に実行したコマンドの出力から」は数値だけで、機能の説明・一覧には効いていなかった | スクリプト+CI: `scripts/check-doc-paths.mjs`（`npm run check:docs`、CI の `frontend` ジョブ）が ARCHITECTURE.md と CLAUDE.md の中のパスと相対リンクの存在を見る（RF-0 の AC-1 のワンライナーを置き換えた）。決まり: AGENTS.md「文書に書く事実は、書く前にコードを開く／コマンドを実行して確かめ、方法を作業報告に書く」と、作業報告の形式に「文書に書いた事実の確かめ方」の行。**事実の中身（機能の説明・版・数）は機械で見られない**ので、ここは決まりと報告の欄に頼る（弱い仕組みであることを承知で残す） | `scripts/check-doc-paths.mjs`、`package.json`、`ci.yml`、AGENTS.md |

- `npm run check:docs` が落ちることの確認: CLAUDE.md の末尾にわざと存在しないパス（`src/app/not-here.ts`）と相対リンクを足して実行 → 終了コード 1 とその 2 件を表示（確かめて戻した）。現状は `OK`
- 仕組みにしなかったもの: 作業報告の「文書の事実の確かめ方」の中身の真偽（監査役が見る）
