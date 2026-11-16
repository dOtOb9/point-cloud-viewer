// Checks that a new ADR (number >= 24) says which code it depends on, and that the code really is there.
//   node scripts/check-adr.mjs            (all TaskSheets/ADR-*.md with number >= 24)
//   node scripts/check-adr.mjs <files>    (those files)
// Required in the ADR (template: TaskSheets/ADR-TEMPLATE.md):
//   "## 依存するコードの確認": a table with >= 3 rows `| `path:line` | `symbol` | what the ADR relies on |`.
//      Every row is checked: the file exists, the line exists, and the symbol appears within 20 lines of that line.
//   "## 整合の確認": a section (ADR-0018 / 0021 / 0022 / 0023 and the CLAUDE.md rules).
//   "## 数えた物": what the ADR counted ("N paths", "all consumers") with the command and its output, or "なし".
// Why: PF-0 (ADR-0024) was approved only after four rounds in which the design contradicted the code it stands on
// (renderer "unchanged", generation keys vs parentKey / hierarchyByKey). See TaskSheets/RECURRENCE.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_CHECKED_ADR = 24;
const WINDOW = 20;
const MIN_ROWS = 3;

function sectionBody(text, titleStart) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).startsWith(titleStart));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/**
 * Problems in one ADR. `fs` = { exists(path), read(path) } relative to the repository root (injected for tests).
 * Empty array = fine.
 */
export function checkAdr(text, fs) {
  const problems = [];
  const code = sectionBody(text, "依存するコードの確認");
  if (!code) {
    problems.push('missing section "## 依存するコードの確認"');
  } else {
    const rows = code.filter((l) => /^\|\s*`[^`]+:\d+`\s*\|/.test(l));
    if (rows.length < MIN_ROWS) problems.push(`"依存するコードの確認" has ${rows.length} rows, needs at least ${MIN_ROWS} (| \`path:line\` | \`symbol\` | claim |)`);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const ref = /`([^`]+):(\d+)`/.exec(cells[1] ?? "");
      const symbol = /`([^`]+)`/.exec(cells[2] ?? "")?.[1];
      if (!ref || !symbol) { problems.push(`bad row (need \`path:line\` and \`symbol\`): ${row.slice(0, 80)}`); continue; }
      const [, path, lineStr] = ref;
      const line = Number(lineStr);
      if (!fs.exists(path)) { problems.push(`${path}:${line}: file does not exist`); continue; }
      const lines = fs.read(path).split(/\r?\n/);
      if (line < 1 || line > lines.length) { problems.push(`${path}:${line}: the file has only ${lines.length} lines`); continue; }
      const from = Math.max(0, line - 1 - WINDOW);
      const to = Math.min(lines.length, line + WINDOW);
      if (!lines.slice(from, to).some((l) => l.includes(symbol))) {
        problems.push(`${path}:${line}: \`${symbol}\` not found within ${WINDOW} lines (the code moved, or the ADR misreads it)`);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = "TaskSheets";
  const given = process.argv.slice(2);
  const files = given.length > 0
    ? given
    : readdirSync(dir).filter((f) => /^ADR-\d{4}-.*\.md$/.test(f) && adrNumber(f) >= FIRST_CHECKED_ADR).map((f) => join(dir, f));
  const fs = { exists: (p) => existsSync(p), read: (p) => readFileSync(p, "utf8") };
  let failed = false;
  for (const file of files) {
    const problems = checkAdr(readFileSync(file, "utf8"), fs);
    if (problems.length > 0) {
      failed = true;
      console.error(`${file}:`);
      for (const p of problems) console.error(`  ${p}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`ADRs OK (${files.length} checked)`);
}
