import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const BASELINE_PATH = "scripts/comment-baseline.json";

const CHECKED_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|rs|wgsl)$/;
const LEXED_LIKE_RUST = /\.(rs|wgsl)$/;
const EXCLUDED_PATHS = [/^vendor\//, /^src\/wasm\//, /^TaskSheets\//, /\.generated\.tsx$/];

const TOOL_DIRECTIVES = [
  /^\/[/*]\s*eslint-disable/,
  /^\/[/*]\s*@ts-expect-error/,
  /^\/[/*]\s*@ts-ignore/,
  /^\/\/\/\s*<reference\s/,
  /^\/[/*]\*?\s*@vitest-environment\s/,
  /^\/\/\s*@ts-check\b/,
  /^#!/,
];
const SAFETY_COMMENT = /^\/\/\s*SAFETY:/;
const PREVIEW_LENGTH = 80;

export function isCheckedFile(path) {
  return CHECKED_EXTENSIONS.test(path) && !EXCLUDED_PATHS.some((pattern) => pattern.test(path));
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineNumberAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function scriptKindOf(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

function isCommentKind(kind) {
  return kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia;
}

function isTriviaKind(kind) {
  return (
    isCommentKind(kind) ||
    kind === ts.SyntaxKind.WhitespaceTrivia ||
    kind === ts.SyntaxKind.NewLineTrivia ||
    kind === ts.SyntaxKind.ShebangTrivia ||
    kind === ts.SyntaxKind.ConflictMarkerTrivia
  );
}

function isJsDocNode(node) {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

function collectLeafTokens(node, sourceFile, leaves) {
  if (isJsDocNode(node)) return;
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    leaves.push(node);
    return;
  }
  for (const child of children) collectLeafTokens(child, sourceFile, leaves);
}

function commentsInLeadingTrivia(scanner, text, start, end) {
  const ranges = [];
  scanner.setText(text, start, end - start);
  for (;;) {
    const kind = scanner.scan();
    if (!isTriviaKind(kind)) break;
    if (isCommentKind(kind)) ranges.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
  }
  return ranges;
}

export function findScriptCommentRanges(text, fileName = "file.ts") {
  const kind = scriptKindOf(fileName);
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const variant = kind === ts.ScriptKind.TS ? ts.LanguageVariant.Standard : ts.LanguageVariant.JSX;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant);
  const leaves = [];
  collectLeafTokens(sourceFile, sourceFile, leaves);
  const ranges = [];
  for (const leaf of leaves) {
    if (leaf.kind === ts.SyntaxKind.JsxText) continue;
    ranges.push(...commentsInLeadingTrivia(scanner, text, leaf.pos, leaf.end));
  }
  return ranges;
}

function isIdentifierCharacter(character) {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

function endOfRustLineComment(text, start) {
  const newline = text.indexOf("\n", start);
  return newline < 0 ? text.length : newline;
}

function endOfRustBlockComment(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      depth++;
      i += 2;
    } else if (text.startsWith("*/", i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return text.length;
}

function endOfQuotedLiteral(text, openingQuote, quote) {
  let i = openingQuote + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === quote) return i + 1;
    else i++;
  }
  return text.length;
}

function rawStringHashesAt(text, i) {
  let hashes = 0;
  while (text[i + hashes] === "#") hashes++;
  return text[i + hashes] === '"' ? hashes : -1;
}

function endOfRawString(text, openingQuote, hashes) {
  const closing = '"' + "#".repeat(hashes);
  const end = text.indexOf(closing, openingQuote + 1);
  return end < 0 ? text.length : end + closing.length;
}

function endOfRustWord(text, start) {
  let i = start;
  while (i < text.length && isIdentifierCharacter(text[i])) i++;
  return i;
}

function endAfterRustWord(text, wordEnd, word) {
  if (word === "r" || word === "br" || word === "cr") {
    const hashes = rawStringHashesAt(text, wordEnd);
    if (hashes >= 0) return endOfRawString(text, wordEnd + hashes, hashes);
  }
  if ((word === "b" || word === "c") && text[wordEnd] === '"') return endOfQuotedLiteral(text, wordEnd, '"');
  if (word === "b" && text[wordEnd] === "'") return endOfQuotedLiteral(text, wordEnd, "'");
  return wordEnd;
}

function endOfCharacterOrLifetime(text, quote) {
  if (text[quote + 1] === "\\") return endOfQuotedLiteral(text, quote, "'");
  const codePoint = text.codePointAt(quote + 1);
  if (codePoint === undefined) return text.length;
  const afterCharacter = quote + 1 + (codePoint > 0xffff ? 2 : 1);
  if (text[afterCharacter] === "'") return afterCharacter + 1;
  return quote + 1;
}

export function findRustCommentRanges(text) {
  const ranges = [];
  let i = 0;
  while (i < text.length) {
    const character = text[i];
    if (text.startsWith("//", i)) {
      const end = endOfRustLineComment(text, i);
      ranges.push([i, end]);
      i = end;
    } else if (text.startsWith("/*", i)) {
      const end = endOfRustBlockComment(text, i);
      ranges.push([i, end]);
      i = end;
    } else if (character === '"') {
      i = endOfQuotedLiteral(text, i, '"');
    } else if (character === "'") {
      i = endOfCharacterOrLifetime(text, i);
    } else if (isIdentifierCharacter(character)) {
      const wordEnd = endOfRustWord(text, i);
      i = endAfterRustWord(text, wordEnd, text.slice(i, wordEnd));
    } else {
      i++;
    }
  }
  return ranges;
}

function nextNonEmptyLine(lines, afterIndex) {
  for (let i = afterIndex + 1; i < lines.length; i++) if (lines[i].trim() !== "") return lines[i];
  return "";
}

function isUnsafeCode(line) {
  const code = line.trim();
  return !code.startsWith("//") && !code.startsWith("/*") && /\bunsafe\b/.test(code);
}

function isAllowedComment(body, endLine, lines) {
  if (TOOL_DIRECTIVES.some((pattern) => pattern.test(body))) return true;
  if (SAFETY_COMMENT.test(body)) return isUnsafeCode(nextNonEmptyLine(lines, endLine - 1));
  return false;
}

export function findCountedComments(text, fileName) {
  const ranges = LEXED_LIKE_RUST.test(fileName) ? findRustCommentRanges(text) : findScriptCommentRanges(text, fileName);
  const lineStarts = lineStartsOf(text);
  const lines = text.split(/\r?\n/);
  const comments = [];
  for (const [start, end] of ranges) {
    const body = text.slice(start, end);
    const line = lineNumberAt(lineStarts, start);
    const endLine = lineNumberAt(lineStarts, Math.max(start, end - 1));
    if (isAllowedComment(body, endLine, lines)) continue;
    comments.push({ line, preview: body.split(/\r?\n/)[0].trimEnd().slice(0, PREVIEW_LENGTH) });
  }
  return comments;
}

export function compareWithBaseline(commentsByFile, baseline) {
  const tooMany = [];
  const lowerTheLimit = [];
  const files = new Set([...Object.keys(commentsByFile), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const comments = commentsByFile[file] ?? [];
    const limit = baseline[file] ?? 0;
    if (comments.length > limit) tooMany.push({ file, limit, comments });
    else if (comments.length < limit) lowerTheLimit.push({ file, limit, count: comments.length });
  }
  return { tooMany, lowerTheLimit };
}

export function loweredBaseline(commentsByFile, baseline) {
  const lowered = {};
  for (const file of Object.keys(baseline).sort()) {
    const count = Math.min(baseline[file], (commentsByFile[file] ?? []).length);
    if (count > 0) lowered[file] = count;
  }
  return lowered;
}

export function formatProblems({ tooMany, lowerTheLimit }) {
  const lines = [];
  for (const { file, limit, comments } of tooMany) {
    lines.push(`${file}: ${comments.length} comments, the limit is ${limit} (CLAUDE.md: no comments in code)`);
    for (const { line, preview } of comments) lines.push(`  ${file}:${line}: ${preview}`);
  }
  for (const { file, limit, count } of lowerTheLimit) {
    const action = count === 0 ? "remove the entry" : `lower it to ${count}`;
    lines.push(`${file}: ${count} comments but the limit is ${limit}: ${action} in ${BASELINE_PATH} (or run with --lower-baseline)`);
  }
  return lines;
}

function trackedCheckedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter((path) => path !== "" && isCheckedFile(path) && existsSync(path));
}

function commentsOfTrackedFiles() {
  const commentsByFile = {};
  for (const file of trackedCheckedFiles()) {
    const comments = findCountedComments(readFileSync(file, "utf8"), file);
    if (comments.length > 0) commentsByFile[file] = comments;
  }
  return commentsByFile;
}

function writeBaseline(baseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
}

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function totalOf(baseline) {
  return Object.values(baseline).reduce((sum, count) => sum + count, 0);
}

function runCheck(args) {
  const commentsByFile = commentsOfTrackedFiles();
  let baseline = readBaseline();
  if (args.includes("--lower-baseline")) {
    const lowered = loweredBaseline(commentsByFile, baseline);
    writeBaseline(lowered);
    console.log(`${BASELINE_PATH}: ${totalOf(baseline)} -> ${totalOf(lowered)} comments`);
    baseline = lowered;
  }
  const problems = formatProblems(compareWithBaseline(commentsByFile, baseline));
  if (problems.length > 0) {
    for (const line of problems) console.error(line);
    return 1;
  }
  console.log(`comments OK (${Object.keys(baseline).length} files with ${totalOf(baseline)} comments left in ${BASELINE_PATH})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runCheck(process.argv.slice(2)));
}
