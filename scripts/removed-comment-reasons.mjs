import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findRustCommentRanges, findScriptCommentRanges } from "./check-comments.mjs";

const USAGE = `usage: node scripts/removed-comment-reasons.mjs <base-ref> [paths...]
       node scripts/removed-comment-reasons.mjs --docs

<base-ref> [paths...]: every comment that was in <base-ref> and is gone now, whose text gives a reason
(because, so that, never, must, ため, ので, 避け, 未検証, 実測, ...). Each one must be moved to a name, a test name or the
"移した理由" table of the task sheet before the comment goes (CM-0). Code files are lexed like check-comments;
.yml / .toml / .ps1 / .gitattributes are read by their "#" lines.
--docs: lines of the design documents (docs/book, TaskSheets/ADR-*.md, ARCHITECTURE.md, CLAUDE.md, AGENTS.md) that send
the reader to a comment in the code. Comments are being removed (CLAUDE.md), so such a line points at nothing.`;

export const REASON_WORDS =
  /\b(because|so that|so the|so it|otherwise|never|must|avoid|instead of|rather than|not in|same as|same construction|twin|agree|measured|unverified|workaround)\b|ため|ので|避け|未検証|実測|回避|理由|しないと|でないと|と同じ|に合わせ|揃え/i;

const HASH_COMMENTED = /\.(ya?ml|toml|ps1)$|(^|\/)\.gitattributes$/;
const RUST_LIKE = /\.(rs|wgsl)$/;
const SCRIPT_LIKE = /\.(ts|tsx|js|mjs|cjs)$/;

export function hasReasonWord(text) {
  return REASON_WORDS.test(text);
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === "\n") line++;
  return line;
}

export function commentsOf(text, fileName) {
  if (HASH_COMMENTED.test(fileName)) {
    return text
      .split(/\r?\n/)
      .map((body, i) => ({ line: i + 1, body: body.trim() }))
      .filter(({ body }) => body.startsWith("#") && !body.startsWith("#!"));
  }
  const ranges = RUST_LIKE.test(fileName)
    ? findRustCommentRanges(text)
    : SCRIPT_LIKE.test(fileName)
      ? findScriptCommentRanges(text, fileName)
      : [];
  return ranges.map(([start, end]) => ({ line: lineOf(text, start), body: text.slice(start, end) }));
}

function normalized(body) {
  return body.replace(/\s+/g, " ").trim();
}

export function removedCommentsWithReasons(baseText, headText, fileName) {
  const stillThere = new Set(commentsOf(headText, fileName).map(({ body }) => normalized(body)));
  return commentsOf(baseText, fileName).filter(({ body }) => !stillThere.has(normalized(body)) && hasReasonWord(body));
}

export const DOCS_THAT_MAY_POINT_AT_COMMENTS = /^(docs\/book\/.*\.md|TaskSheets\/ADR-.*\.md|TaskSheets\/ARCHITECTURE\.md|CLAUDE\.md|AGENTS\.md)$/;

const MENTIONS_A_COMMENT = /コメント|comment/i;
const NAMES_CODE = /\.(ts|tsx|js|mjs|cjs|rs|wgsl|ya?ml|toml|ps1)\b|冒頭|先頭|コード中|コードコメント|モジュール/;
const NOT_A_CODE_COMMENT = /コメントアウト|所有者の(コメント)|のコメント（|コメントを書かない|コメントは英語|コメントに.*パッケージ名|コメントのみ|(remove|no)-comments|check[:-]comments|comment-baseline/;

export function linesPointingAtComments(text) {
  return text
    .split(/\r?\n/)
    .map((body, i) => ({ line: i + 1, body }))
    .filter(({ body }) => MENTIONS_A_COMMENT.test(body) && NAMES_CODE.test(body) && !NOT_A_CODE_COMMENT.test(body));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function baseTextOf(baseRef, file) {
  try {
    return git(["show", `${baseRef}:${file}`]);
  } catch {
    return "";
  }
}

function listRemovedReasons(baseRef, paths) {
  const files = git(["diff", "--name-only", "--diff-filter=MD", baseRef, "--", ...paths]).split("\n").filter(Boolean);
  let count = 0;
  for (const file of files) {
    const head = existsSync(file) ? readFileSync(file, "utf8") : "";
    for (const { line, body } of removedCommentsWithReasons(baseTextOf(baseRef, file), head, file)) {
      count++;
      console.log(`${file}:${line} (${baseRef}): ${normalized(body).slice(0, 200)}`);
    }
  }
  console.log(`${count} removed comments give a reason: each needs a name, a test name or a row of the task sheet's table`);
}

function listDocLines() {
  const files = git(["ls-files"]).split("\n").filter((f) => DOCS_THAT_MAY_POINT_AT_COMMENTS.test(f));
  let count = 0;
  for (const file of files) {
    for (const { line, body } of linesPointingAtComments(readFileSync(file, "utf8"))) {
      count++;
      console.log(`${file}:${line}: ${body.trim().slice(0, 200)}`);
    }
  }
  console.log(`${count} document lines send the reader to a comment in the code`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(USAGE);
    process.exit(args.length === 0 ? 2 : 0);
  }
  if (args[0] === "--docs") listDocLines();
  else listRemovedReasons(args[0], args.slice(1));
}
