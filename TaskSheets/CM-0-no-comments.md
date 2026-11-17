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

（作業エージェントが足す）
