// A worker must not change the coordinator's part of a task sheet (AGENTS.md: "作業エージェントの決まり").
//   node scripts/check-task-sheet.mjs <base-ref> [head-ref]
// Compares every TaskSheets/*.md that has acceptance criteria ("**AC-<n>**") at <base-ref> with the same file at
// [head-ref] (default: the working tree). Everything outside the record sections ("## ...記録") must be identical, so
// the acceptance criteria, the headings and the text around them stay as the coordinator wrote them.
// The worker writes only inside "## 記録" (and the coordinator's "監査の記録"). One placeholder line is allowed to go.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = /^（作業エージェントが.*足す）$/;

/** Lines outside the record sections, and the number of record headings. */
export function protectedLines(text) {
  const out = [];
  let inRecord = false;
  let recordHeadings = 0;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (/記録/.test(heading[2]) && level <= 2) {
        inRecord = true;
        recordHeadings++;
        out.push(line); // the heading itself is protected; its body is not
        continue;
      }
      if (inRecord && level <= 2) inRecord = false; // the next "##" section is the coordinator's again
    }
    if (!inRecord && !PLACEHOLDER.test(line.trim())) out.push(line);
  }
  return { lines: out, recordHeadings };
}

/** Problems found when `headText` replaces `baseText`. Empty = fine. Only files with an "**AC-" line are checked. */
export function findProtectedChanges(baseText, headText) {
  if (!/\*\*AC-\d+\*\*/.test(baseText)) return [];
  const base = protectedLines(baseText);
  const head = protectedLines(headText);
  const problems = [];
  const headSet = new Set(head.lines);
  const baseSet = new Set(base.lines);
  base.lines.forEach((line, i) => {
    if (line.trim() !== "" && !headSet.has(line)) problems.push(`removed or changed (base line ${i + 1}): ${line.slice(0, 100)}`);
  });
  head.lines.forEach((line, i) => {
    if (line.trim() !== "" && !baseSet.has(line)) problems.push(`added outside a record section (head line ${i + 1}): ${line.slice(0, 100)}`);
  });
  if (problems.length === 0 && base.lines.join("\n") !== head.lines.join("\n")) problems.push("lines were reordered outside the record sections");
  if (head.recordHeadings < base.recordHeadings) problems.push("a record heading was removed");
  return problems;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [baseRef, headRef] = process.argv.slice(2);
  if (!baseRef) {
    console.error("usage: node scripts/check-task-sheet.mjs <base-ref> [head-ref]");
    process.exit(2);
  }
  const files = git(["ls-tree", "-r", "--name-only", baseRef, "TaskSheets"]).split("\n").filter((f) => f.endsWith(".md"));
  let failed = false;
  for (const file of files) {
    const baseText = git(["show", `${baseRef}:${file}`]);
    let headText;
    if (headRef) {
      try { headText = git(["show", `${headRef}:${file}`]); } catch { headText = ""; }
    } else {
      headText = existsSync(file) ? readFileSync(file, "utf8") : "";
    }
    const problems = findProtectedChanges(baseText, headText);
    if (problems.length > 0) {
      failed = true;
      console.error(`${file}: the coordinator's part changed`);
      for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`task sheets OK (${files.length} files compared with ${baseRef})`);
}
