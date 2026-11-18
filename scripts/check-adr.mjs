import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_CHECKED_ADR = 24;
const STRICT_SYMBOL_DISTANCE_LINES = 20;
const MIN_ROWS = 3;
const MIN_SYMBOL_LENGTH = 3;
const MIN_PREMISE_LENGTH = 8;
const WORDS_THAT_MATCH_ALMOST_ANY_FILE = new Set(
  (
    "abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum " +
    "export extends false finally for from function get if implements import in instanceof interface is keyof let namespace never new null " +
    "number of override package private protected public readonly require return set static string super switch symbol this throw true try " +
    "type typeof undefined unknown var void while with yield Promise Array Object Math Map Set Date Error JSON length push map filter " +
    "forEach value data name id key keys values index count size " +
    "as break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self " +
    "static struct super trait true type unsafe use where while Option Result Vec String Box Some None Ok Err u8 u16 u32 u64 i32 i64 f32 f64 usize bool str main new"
  )
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase()),
);

function sectionBody(text, titleStart) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).startsWith(titleStart));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasWord(line, symbol) {
  return new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`).test(line);
}

const DECLARATION = /\b(function|const|let|var|class|interface|type|enum|namespace|fn|struct|trait|impl|mod|static|def)\s+/;

export function isDeclaredOrDefined(line, symbol) {
  if (!hasWord(line, symbol)) return false;
  const esc = escapeRegExp(symbol);
  if (new RegExp(`${DECLARATION.source}${esc}(?![\\w$])`).test(line)) return true;
  return new RegExp(`(?<![\\w$])${esc}\\s*[(:=]`).test(line);
}

export function adrStatus(text) {
  const m = /^-?\s*状態:\s*\**\s*([^\s*（(]+)/m.exec(text);
  return m ? m[1] : null;
}

export function checkAdr(text, fs, { changed = false } = {}) {
  const problems = [];
  const strict = changed || adrStatus(text) === "提案";
  const code = sectionBody(text, "依存するコードの確認");
  if (!code) {
    problems.push('missing section "## 依存するコードの確認"');
  } else {
    const rows = code.filter((l) => /^\|\s*`[^`]+:\d+`\s*\|/.test(l));
    if (rows.length < MIN_ROWS) {
      problems.push(`"依存するコードの確認" has ${rows.length} rows, needs at least ${MIN_ROWS} (| \`path:line\` | \`symbol\` | premise |)`);
    }
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const ref = /`([^`]+):(\d+)`/.exec(cells[1] ?? "");
      const symbol = /`([^`]+)`/.exec(cells[2] ?? "")?.[1];
      if (!ref || !symbol) {
        problems.push(`bad row (need \`path:line\` and \`symbol\`): ${row.slice(0, 80)}`);
        continue;
      }
      const [, path, lineStr] = ref;
      const line = Number(lineStr);
      if (symbol.length < MIN_SYMBOL_LENGTH) {
        problems.push(`${path}:${line}: \`${symbol}\` is shorter than ${MIN_SYMBOL_LENGTH} characters`);
        continue;
      }
      if (WORDS_THAT_MATCH_ALMOST_ANY_FILE.has(symbol.toLowerCase())) {
        problems.push(`${path}:${line}: \`${symbol}\` is a keyword or a generic word that appears in almost any file; name the function, type or constant itself`);
        continue;
      }
      if ((cells[3] ?? "").length < MIN_PREMISE_LENGTH) {
        problems.push(`${path}:${line}: the premise cell (what you read and confirmed) is empty or too short`);
        continue;
      }
      if (!fs.exists(path)) {
        problems.push(`${path}:${line}: file does not exist`);
        continue;
      }
      const lines = fs.read(path).split(/\r?\n/);
      if (line < 1 || line > lines.length) {
        problems.push(`${path}:${line}: the file has only ${lines.length} lines`);
        continue;
      }
      if (!lines.some((l) => hasWord(l, symbol))) {
        problems.push(`${path}:${line}: \`${symbol}\` is not in the file at all`);
        continue;
      }
      if (!lines.some((l) => isDeclaredOrDefined(l, symbol))) {
        problems.push(`${path}:${line}: \`${symbol}\` is in the file but never declared or defined there (no "function/const/class/fn/struct ... name", "name(", "name:" or "name =")`);
        continue;
      }
      if (strict) {
        const from = Math.max(0, line - 1 - STRICT_SYMBOL_DISTANCE_LINES);
        const to = Math.min(lines.length, line + STRICT_SYMBOL_DISTANCE_LINES);
        if (!lines.slice(from, to).some((l) => hasWord(l, symbol))) {
          problems.push(`${path}:${line}: \`${symbol}\` not found within ${STRICT_SYMBOL_DISTANCE_LINES} lines (the code moved, or the ADR misreads it; fix the line or the ADR)`);
        }
      }
    }
  }
  const fit = sectionBody(text, "整合の確認");
  if (!fit) problems.push('missing section "## 整合の確認"');
  else if (!fit.join("\n").includes("ADR-0022") || !fit.join("\n").includes("ADR-0023")) problems.push('"整合の確認" must mention ADR-0022 and ADR-0023');
  const counted = sectionBody(text, "数えた物");
  if (!counted) problems.push('missing section "## 数えた物" (write なし if nothing was counted)');
  else if (counted.join("").trim() === "") problems.push('"数えた物" is empty');
  return problems;
}

function adrNumber(file) {
  const m = /ADR-(\d{4})-/.exec(file);
  return m ? Number(m[1]) : null;
}

function changedSince(baseRef) {
  try {
    return new Set(
      execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { encoding: "utf8" })
        .split("\n")
        .map((f) => f.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

const USAGE = `usage: node scripts/check-adr.mjs [--base <ref>] [ADR files...]

Checks that a new ADR (number >= ${FIRST_CHECKED_ADR}) says which code it depends on, and that the code really is there.
With no files: every TaskSheets/ADR-*.md numbered ${FIRST_CHECKED_ADR} or more. Template: TaskSheets/ADR-TEMPLATE.md.

Required in the ADR:
  "## 依存するコードの確認": a table with >= ${MIN_ROWS} rows | \`path:line\` | \`symbol\` | what the ADR relies on |
  "## 整合の確認": a section that names ADR-0022 and ADR-0023
  "## 数えた物": what the ADR counted, with the command and its output, or "なし"

Every row: the file and the line exist, \`symbol\` has ${MIN_SYMBOL_LENGTH}+ characters, is not a keyword or a generic word,
and the file declares or defines it; the 3rd column is not empty.
Strict (the ADR is a proposal, or it changed since --base): the symbol must also appear within
${STRICT_SYMBOL_DISTANCE_LINES} lines of the stated line. An accepted ADR nobody touches is not failed when unrelated code moves.`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  let baseRef = null;
  const baseAt = args.indexOf("--base");
  if (baseAt >= 0) {
    baseRef = args[baseAt + 1];
    args.splice(baseAt, 2);
  }
  const dir = "TaskSheets";
  const files =
    args.length > 0
      ? args
      : readdirSync(dir)
          .filter((f) => /^ADR-\d{4}-.*\.md$/.test(f) && adrNumber(f) >= FIRST_CHECKED_ADR)
          .map((f) => join(dir, f).replace(/\\/g, "/"));
  const changed = baseRef ? changedSince(baseRef) : new Set();
  const fs = { exists: (p) => existsSync(p), read: (p) => readFileSync(p, "utf8") };
  let failed = false;
  for (const file of files) {
    const problems = checkAdr(readFileSync(file, "utf8"), fs, { changed: changed.has(file.replace(/\\/g, "/")) });
    if (problems.length > 0) {
      failed = true;
      console.error(`${file}:`);
      for (const p of problems) console.error(`  ${p}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`ADRs OK (${files.length} checked)`);
}
