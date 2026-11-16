// Checks that a new ADR (number >= 24) says which code it depends on, and that the code really is there.
//   node scripts/check-adr.mjs                       (all TaskSheets/ADR-*.md with number >= 24)
//   node scripts/check-adr.mjs [--base <ref>] <files>
// Required in the ADR (template: TaskSheets/ADR-TEMPLATE.md):
//   "## 依存するコードの確認": a table with >= 3 rows `| `path:line` | `symbol` | what the ADR relies on |`.
//   "## 整合の確認": a section that names ADR-0022 and ADR-0023.
//   "## 数えた物": what the ADR counted ("N paths", "all consumers") with the command and its output, or "なし".
// How strict a row is:
//   always: the file exists, the line exists, `symbol` is 3+ characters, not a language keyword or generic word, and the file
//           declares or defines it ("function name", "name(", "name:", "name ="); the "前提" cell (3rd column) is not empty.
//   strict (the ADR is a proposal, or it changed since --base): the symbol must also appear as a whole word within 20 lines
//           of the stated line. An accepted ADR that nobody touches is not failed when unrelated code above it moves.
// Why: PF-0 (ADR-0024) was approved only after four rounds in which the design contradicted the code it stands on
// (renderer "unchanged", generation keys vs parentKey / hierarchyByKey). See TaskSheets/RECURRENCE.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_CHECKED_ADR = 24;
const WINDOW = 20;
const MIN_ROWS = 3;
const MIN_SYMBOL_LENGTH = 3;
const MIN_PREMISE_LENGTH = 8;
// Words that match almost any file; a row that names only one of these proves nothing.
const GENERIC = new Set(
  (
    // TypeScript / JavaScript keywords and ubiquitous built-ins
    "abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum " +
    "export extends false finally for from function get if implements import in instanceof interface is keyof let namespace never new null " +
    "number of override package private protected public readonly require return set static string super switch symbol this throw true try " +
    "type typeof undefined unknown var void while with yield Promise Array Object Math Map Set Date Error JSON length push map filter " +
    "forEach value data name id key keys values index count size " +
    // Rust keywords and ubiquitous types
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

/** True when `line` contains `symbol` as a whole word (not inside a longer identifier). */
export function hasWord(line, symbol) {
  return new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`).test(line);
}

const DECLARATION = /\b(function|const|let|var|class|interface|type|enum|namespace|fn|struct|trait|impl|mod|static|def)\s+/;

/** True when `line` declares or defines `symbol` (a declaration keyword before it, or the "name(" / "name:" / "name =" form). */
export function isDeclaredOrDefined(line, symbol) {
  if (!hasWord(line, symbol)) return false;
  const esc = escapeRegExp(symbol);
  if (new RegExp(`${DECLARATION.source}${esc}(?![\\w$])`).test(line)) return true;
  return new RegExp(`(?<![\\w$])${esc}\\s*[(:=]`).test(line);
}

/** The status word in the "状態" line ("提案", "採択", "却下"...), or null. */
export function adrStatus(text) {
  const m = /^-?\s*状態:\s*\**\s*([^\s*（(]+)/m.exec(text);
  return m ? m[1] : null;
}

/**
 * Problems in one ADR. `fs` = { exists(path), read(path) } relative to the repository root (injected for tests).
 * `changed`: the ADR changed in this PR / since --base (makes the line-distance check strict, like a proposal).
 * Empty array = fine.
 */
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
      if (GENERIC.has(symbol.toLowerCase())) {
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
        const from = Math.max(0, line - 1 - WINDOW);
        const to = Math.min(lines.length, line + WINDOW);
        if (!lines.slice(from, to).some((l) => hasWord(l, symbol))) {
          problems.push(`${path}:${line}: \`${symbol}\` not found within ${WINDOW} lines (the code moved, or the ADR misreads it; fix the line or the ADR)`);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
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
