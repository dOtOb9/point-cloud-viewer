# CM-0: コードにコメントを書かない決まりと、それを機械で見る検査

- 元: 所有者の指示（2026-11-17）「コメントをできる限り書かないで。あったら削除しようか。コードから類推できるようにしてくれ」
- 決まり: `CLAUDE.md`「最優先: 所有者が実装を追えること」（2026-10-15 の「コメントは英語」を置き換えた）
- 順番: CM-0（検査）→ CM-1〜CM-5（範囲ごとに消す。並行）→ PL-0。PL-0 以降のコードを最初からコメント無しで書くため、PL-0 より先にする
- 方針: 振る舞いは変えない。push しない

## メインが決めたこと（所有者の判断が要れば覆す）

- **例外**（消さない・検査で許す）は、道具が読む指示だけ: `eslint-disable*`・`@ts-expect-error`・`@ts-ignore`・`/// <reference …>`・`@vitest-environment`・shebang（`#!`）・`// @ts-check`。
  加えて、`unsafe` ブロック・`unsafe impl` の**直前の1行**の `// SAFETY: …`（Rust で `unsafe` の理由を書く慣習。消すと安全の根拠がどこにも無くなる）
- Rust の文書コメント（`///`・`//!`）も消す。外部プラグイン向けの API の説明（ADR-0023）は、コードのコメントでなく `docs/book/` に書く
- **対象外**: `vendor/`（上流のコード）、生成物（`src/wasm/`、`*.generated.tsx`）、Markdown・HTML の文書（`docs/`・`TaskSheets/`）
- コードで表せない「なぜ」（外部の不具合の回避、測って選んだ値、`unsafe` 以外の安全の前提）は、次の順で移す:
  1. 名前（関数・定数・型）にする。例: `// wasm32 is single-threaded` → `const WASM32_IS_SINGLE_THREADED = …` や関数名
  2. その理由を確かめるテストを置き、テストの名前に理由を書く
  3. どちらもできない物だけ、その CM タスクのシートの「移した理由」の表に `ファイル:識別子` と理由を書く

## 範囲（CM-1〜CM-5 は並行。触るファイルが重ならない）

| ID | 範囲 | コメント行（`grep` の概数、2026-11-17） |
|---|---|---|
| CM-1 | `src/renderer/` | 約 4,000 |
| CM-2 | `src/datasource/` | 約 2,100 |
| CM-3 | `src/` の残り（`app`・`ui`・`state`・直下）、`scripts/`・`e2e/`・`docs/video/tools/`、ルートの設定（`eslint.config.js`・`vite.config.ts`・`playwright.config.ts` など）、`.github/workflows/*.yml`・`Cargo.toml`・`.gitattributes` | 約 2,700 |
| CM-4 | `crates/pcv-core/`・`crates/pcv-wasm/` | 約 3,800 |
| CM-5 | `crates/pcv-convert/`・`src-tauri/` | 約 3,200 |

YAML・TOML・`.gitattributes`・PowerShell は CM-0 の検査の対象外（数が少ないので CM-3 で手で消す）。

## 受け入れ基準

- **AC-1** `scripts/check-comments.mjs`（`npm run check:comments`）が、対象のファイル（`git ls-files` のうち `*.ts`・`*.tsx`・`*.js`・`*.mjs`・`*.cjs`・`*.rs`。上の対象外を除く）のコメントを数え、
  `scripts/comment-baseline.json`（ファイルごとの上限）を超えたファイルがあれば、`ファイル:行` と本文の先頭を出して失敗する。上限の無いファイルの上限は 0
- **AC-2** コメントの見つけ方は字句で行う（行頭の `//` を grep しない）。TS・JS は `typescript` の scanner（`ts.createScanner`）、Rust は自前の小さな字句解析。
  次の形を `scripts/check-comments.test.mjs` のケースで固定する:
  - 数える: 行コメント、行末のコメント、ブロックコメント、JSDoc、JSX の `{/* */}`、Rust の `///`・`//!`・入れ子の `/* /* */ */`
  - 数えない: 文字列・テンプレート文字列・正規表現の中の `//`・`/*`（URL、`"a // b"`、`/\/\//`）、Rust の文字列・raw 文字列（`r#"//"#`）・文字（`'/'`）・ライフタイム（`'a`）の後の `//` の扱いを誤らないこと
  - 許す: 上の「例外」の指示。`// SAFETY:` は次の空でない行が `unsafe` を含むときだけ許し、そうでなければ数える
- **AC-3** `scripts/comment-baseline.json` は CM-0 の時点の数で作り、**下げるだけ**。数が上限より減ったファイルがあれば「下げよ」と失敗する（`src/code-limits.test.ts` の BASELINE と同じ考え）。0 になったファイルは JSON から消す
- **AC-4** `npm run check:comments` を `scripts/check-all.mjs` と CI の `frontend` ジョブ（`.github/workflows/ci.yml`）に入れる
- **AC-5** 検査を作ったら、わざとコメントを1行足して落ちること、文字列の中の `//` を足しても落ちないことを、一時的に確かめて作業報告に貼る
- **AC-6** CM-0 自身が足すファイル（`check-comments.mjs`・テスト）にコメントを書かない（上限 0）
- **AC-7** `npm run check:all` が全部 OK

## 確かめ方

- `npm run check:comments` の出力、`scripts/check-comments.test.mjs`（`scripts/check-adr.test.mjs` と同じく vitest で走る）、`npm run check:all` の末尾の一覧

## 記録

### 実装の記録 R1（作業役）

#### やったこと

- `scripts/check-comments.mjs`（`npm run check:comments`）を足した。`git ls-files` のうち `*.ts`・`*.tsx`・`*.js`・`*.mjs`・`*.cjs`・`*.rs`（`vendor/`・`src/wasm/`・`docs/`・`TaskSheets/`・`*.generated.tsx` を除く）のコメントを数え、`scripts/comment-baseline.json` の上限と比べる
  - 超えたファイル: `ファイル: N comments, the limit is M` の後に、そのファイルのコメントを全部 `ファイル:行: 本文の先頭 80 文字` で出して失敗する（どれが新しいかは分からないので全部出す）
  - 減ったファイル: `lower it to N`（0 なら `remove the entry`）と出して失敗する。`node scripts/check-comments.mjs --lower-baseline` は、各ファイルの上限を「今の数と上限の小さい方」に書き直し、0 の行を消す（上げない・ファイルを足さない。テスト `lowers the baseline without ever raising it or adding a file`）。CM-1〜CM-5 で数千件を消すときに手で直さずに済むように足した
  - 数える単位はコメント1つ（`//` の1行が1つ、`/* … */` は何行でも1つ）
- TS・JS: `ts.createSourceFile` で構文木を作り、葉のトークン（`getChildren` が 0 個のノード）ごとに、その前の trivia（`pos` からトークンの前まで）を `ts.createScanner`（skipTrivia=false、`.tsx`・`.js` 系は `LanguageVariant.JSX`）で読んでコメントを集める。JSDoc のノードは葉として辿らない（その本文は次のトークンの trivia で1回だけ数える）。`JsxText` は trivia を持たないので読まない
- Rust: 自前の字句解析（`findRustCommentRanges`）。`//`・`///`・`//!`、入れ子を数える `/* */`、`"…"`（エスケープ）、`r"…"`・`r#"…"#`・`br##"…"##`・`cr"…"`、`b"…"`・`c"…"`・`b'…'`、文字 `'/'`・`'\''`、ライフタイム・ラベル `'a`（`'` の次の1文字の後が `'` でなければライフタイム）。識別子は語ごとに読むので、`bar"` のように `r` で終わる語を raw 文字列と取り違えない
- 許す物（数えない）: コメントの先頭が `eslint-disable`・`@ts-expect-error`・`@ts-ignore`・`/// <reference `・`@vitest-environment`（`/** @vitest-environment … */` も）・`// @ts-check`、shebang。`// SAFETY:` は、コメントの最後の行の次の空でない行に `unsafe` があるときだけ許す（TS でも同じ規則）
- `scripts/check-comments.test.mjs`（19 ケース）で AC-2 の形を固定した
- `package.json` に `check:comments`、`scripts/check-all.mjs` の STEPS と `.github/workflows/ci.yml` の frontend ジョブ（check docs の後、test の前）に足した。`AGENTS.md` の「作業役の決まり」の check:all の一覧に `check:comments` を足した

#### 初期の数（`scripts/comment-baseline.json`）

- 対象 432 ファイルのうち 407 ファイルにコメントがあり、合計 12,261（Rust 7,074、TS・JS 5,187）
- CM の範囲ごと（baseline の JSON を範囲の正規表現で分けて合計した）: CM-1 2,138／CM-2 1,207／CM-3 1,842／CM-4 3,837／CM-5 3,237。範囲の表の「コメント行」は行の数で、こちらはコメントの数なので一致しない

#### 検査が数えないコメント（CM-1 への申し送り）

- TS の文字列の中の WGSL のコメント（`const GRID_SHADER_SRC = /* wgsl */` に続くテンプレート文字列の中の `//`。`createShaderModule({ code: GRID_SHADER_SRC })` に渡る）は、AC-2 の「文字列の中の `//` は数えない」に従って数えない。行頭が `//` で検査が数えなかった行を数えると（一時的なスクリプト。コミットしていない）、`src/renderer/gpu-resources.ts` 67・`ground-grid.ts` 32・`edl.ts` 27・`sky.ts` 12（指示の行を除く）。CLAUDE.md は WGSL のコメントも禁じているので、CM-1 で手で消す必要がある。検査で見るなら、WGSL を持つテンプレート文字列を別に読む仕組みが要る（今回は入れていない）
- 複数行の `// SAFETY:` は、最後の行だけが `unsafe` の直前になるので、最初の行も続きの行も数える（`git grep -n -A2 "// SAFETY" -- '*.rs' ':!vendor'` で見た 7 か所のうち、1行で `unsafe` の直前にあるのは `crates/pcv-convert/tests/import_merge_memory_is_bounded.rs:41` だけ。残りの 6 か所（`crates/pcv-convert/src/disk_space.rs:59`・`:96`、`crates/pcv-wasm/src/e57_import.rs:87`・`:146`、`crates/pcv-wasm/src/opfs.rs:348`、`src-tauri/src/conversion.rs:194`）は複数行）。CM-4・CM-5 で1行にまとめれば数から外れる
- `src/state/useCopcViewer.ts:101` の `eslint-disable-next-line … -- run when the selection changes,` の続きの行は、指示でない普通のコメントとして数える

#### 採らなかった案

- 行頭の `//` を grep する: 文字列・テンプレート・正規表現・JSX の本文の `//` を拾い、行末のコメントを落とす（AC-2）
- `ts.createScanner` だけで先頭から全部を走査する: `/` が割り算か正規表現か、`}` がテンプレートの続きか、JSX の本文かを、構文を知らないスキャナーは決められない（`reScanSlashToken`・`reScanTemplateToken`・`scanJsxToken` を呼ぶ判断を自前で持つことになる）。構文木の葉の間の trivia だけをスキャナーで読めば、その判断はパーサーに任せられる
- `ts.getLeadingCommentRanges` を使う: 中身は同じだが、AC-2 が `ts.createScanner` を名指ししているのでスキャナーを使った
- 違反のファイルで「新しいコメントだけ」を出す（git の差分を見る）: 仕組みが増えるので、そのファイルのコメントを全部出す形にした
- 例外に `eslint-enable` を足す: 決まりの一覧に無く、リポジトリにも使われていない（`git grep -n "eslint-enable" -- ':!vendor' ':!src/wasm'` の当たりは、この記録の行だけ）ので足さなかった

#### 触ったファイル

- 新規: `scripts/check-comments.mjs`・`scripts/check-comments.test.mjs`・`scripts/comment-baseline.json`（新規の2つの .mjs はコメント 0。`@vitest-environment` の指示だけある）
- 変更: `package.json`・`scripts/check-all.mjs`・`.github/workflows/ci.yml`・`AGENTS.md`（69 行目の一覧）・このシートの記録

#### 確かめ方

- `npm run check:comments` → `comments OK (407 files with 12261 comments left in scripts/comment-baseline.json)`
- `npx vitest run scripts/check-comments.test.mjs`（`C:\` の大文字から）→ 19 passed
- AC-5 を自分で再現する: 対象のファイルの末尾に `// x` を足して `npm run check:comments` が `ファイル:行: // x` を出して終了コード 1 になること、`const s = "https://a // b";` を足しても OK のままであること、既存のコメントを1つ消すと `lower it to N` で落ちることを見て、`git checkout -- <ファイル>` で戻す

### 監査の指摘への対応（R1 の APPROVE の後、CM-0-RP R1）

- F-1（should、WGSL のコメントを見ていない）: メインの決定どおり、`.wgsl` を対象の拡張子に足し、Rust と同じ `findRustCommentRanges` で数えるようにした（`LEXED_LIKE_RUST`。WGSL には文字列・文字が無いので、`//` と入れ子の `/* */` だけが効く）。テスト: `check-comments: WGSL` の 2 ケースと、`isCheckedFile("src/renderer/shaders/points.wgsl")`。`git ls-files '*.wgsl'` は 0 件なので baseline は変わらない。TS のテンプレート文字列の中にある今のシェーダーのコメントは、CM-1 で `src/renderer/shaders/*.wgsl` に出した時点で検査に入る（それまでは上の申し送りのとおり数えていない）
- F-2（nit）: `// SAFETY:` の次の空でない行が `//` か `/*` で始まるときは許さない（`isUnsafeCode`）。テスト: `does not allow // SAFETY: when the next non-empty line is a comment that says unsafe`
- F-3（nit）: 本文の先頭を `trimEnd()` して、CRLF の行の `\r` を出さない。テスト: `gives the beginning of a line comment without the \r of a CRLF line end`
- F-4（nit）: **ファイルの名前を変えたら（`git mv`）、`scripts/comment-baseline.json` のキーも手で新しいパスに付け替える。** 検査は新しいパスを上限 0 として落とし、古いパスには「remove the entry」と出す。上限を上げずに済む付け替えを検査が自分で推し量ると、別のファイルへのコメントの持ち込みも通ってしまうので、手で付け替える決まりにした
- 4 つのテストは、直す前の `scripts/check-comments.mjs`（`git checkout` で一時的に戻した）で 4 件落ちることを確かめ、直した版に戻した（`Tests  4 failed | 19 passed (23)`）
