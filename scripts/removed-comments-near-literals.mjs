import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCountedComments, findRustCommentRanges, isCheckedFile } from "./check-comments.mjs";
import ts from "typescript";

const LINES_LOOKED_AT_AFTER_A_COMMENT = 8;
const MAGIC_NUMBER = /(?<![\w.])(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e-?\d+)?)(?![\w.])/g;
const NUMBERS_THAT_EXPLAIN_THEMSELVES = new Set(["0", "1", "0.0", "1.0", "2", "2.0"]);
const SHORT_STRING_LITERAL = /"([^"\\\n]{1,3})"/g;
const LEXED_LIKE_RUST = /\.(rs|wgsl)$/;

function commentRanges(text, fileName) {
  if (LEXED_LIKE_RUST.test(fileName)) return findRustCommentRanges(text);
  const ranges = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      ranges.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
    }
  }
  return ranges;
}

function lineIndexAt(text, offset) {
  let line = 0;
  for (let i = 0; i < offset; i++) if (text[i] === "\n") line++;
  return line;
}

function withoutComments(line) {
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}

function bareLiteralsOf(codeLine) {
  const code = withoutComments(codeLine);
  const numbers = [...code.matchAll(MAGIC_NUMBER)]
    .map((match) => match[0])
    .filter((number) => !NUMBERS_THAT_EXPLAIN_THEMSELVES.has(number));
  const shortStrings = [...code.matchAll(SHORT_STRING_LITERAL)].map((match) => match[0]);
  return [...numbers, ...shortStrings];
}

export function findRemovedCommentsNearLiterals(baseText, headText, fileName) {
  const countedLines = new Set(findCountedComments(baseText, fileName).map((comment) => comment.line));
  const headCommentBodies = new Set(
    commentRanges(headText, fileName).map(([start, end]) => headText.slice(start, end).trim()),
  );
  const headCodeLines = new Set(headText.split(/\r?\n/).map((line) => line.trim()));
  const baseLines = baseText.split(/\r?\n/);
  const foundByCodeLine = new Map();
  for (const [start, end] of commentRanges(baseText, fileName)) {
    const firstLine = lineIndexAt(baseText, start);
    if (!countedLines.has(firstLine + 1)) continue;
    const body = baseText.slice(start, end).trim();
    if (headCommentBodies.has(body)) continue;
    const lastLine = lineIndexAt(baseText, Math.max(start, end - 1));
    const candidates = [baseLines[firstLine].slice(0, start - baseText.lastIndexOf("\n", start - 1) - 1)];
    for (let i = lastLine + 1; i < baseLines.length && candidates.length <= LINES_LOOKED_AT_AFTER_A_COMMENT; i++) {
      candidates.push(baseLines[i]);
    }
    for (const candidate of candidates) {
      const literals = bareLiteralsOf(candidate);
      const code = candidate.trim();
      if (literals.length > 0 && headCodeLines.has(code)) {
        if (!foundByCodeLine.has(code)) {
          foundByCodeLine.set(code, {
            line: firstLine + 1,
            comment: body.split(/\r?\n/)[0].slice(0, 80),
            literals,
            code: code.slice(0, 100),
          });
        }
        break;
      }
    }
  }
  return [...foundByCodeLine.values()];
}

export function repositoryRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

export function changedCheckedFiles(root, base, pathspecs) {
  const output = execFileSync("git", ["diff", "--name-only", base, "--", ...pathspecs], { encoding: "utf8" });
  return output.split("\n").filter((path) => path && isCheckedFile(path) && existsSync(join(root, path)));
}

function baseTextOf(base, path) {
  try {
    return execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function main() {
  const [base, ...pathspecs] = process.argv.slice(2);
  if (!base) {
    console.error("usage: node scripts/removed-comments-near-literals.mjs <base commit> [pathspec...]");
    process.exit(2);
  }
  const root = repositoryRoot();
  let total = 0;
  for (const path of changedCheckedFiles(root, base, pathspecs)) {
    const baseText = baseTextOf(base, path);
    if (baseText === null) continue;
    for (const item of findRemovedCommentsNearLiterals(baseText, readFileSync(join(root, path), "utf8"), path)) {
      total++;
      console.log(`${path}:${item.line}: ${item.comment}`);
      console.log(`    still bare: ${item.literals.join(", ")} in \`${item.code}\``);
    }
  }
  console.log(`${total} removed comments explained a literal that is still bare: name it, or write the reason in the task sheet`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
