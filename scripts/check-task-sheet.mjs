// A worker must not change the coordinator's part of a task sheet (AGENTS.md: "作業エージェントの決まり").
//   node scripts/check-task-sheet.mjs <base-ref> [head-ref]
// Compares every TaskSheets/*.md that has acceptance criteria ("**AC-<n>**") at <base-ref> with the same file at
// [head-ref] (default: the working tree). The coordinator's lines outside the record sections must all still be there.
// A record section is anything under a heading that contains "記録" ("## 記録", "### 実装の記録 R1", "### 監査の記録"), at any level.
// <base-ref> = the commit before the loop started; if the coordinator fixed an AC during the loop, use the commit after that fix.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = /^（作業エージェントが.*足す）$/;
const AC_LINE = /\*\*AC-\d+\*\*/;

/**
 * Lines outside the record sections. A record section starts at a heading whose text contains "記録", at any level,
 * and ends at the next heading of the same or a higher level (fewer or equal "#"). The record heading line itself is kept.
 */
export function protectedLines(text) {
  const out = [];
  let recordLevel = null; // heading level of the open record section, or null
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (recordLevel !== null && level <= recordLevel) recordLevel = null; // the record section ended
      if (recordLevel === null && /記録/.test(heading[2])) {
        recordLevel = level;
        out.push(line);
        continue;
      }
    }
    if (recordLevel === null && !PLACEHOLDER.test(line.trim())) out.push(line);
  }
  return out;
}

/**
 * Problems when `headText` replaces `baseText`. Empty = fine. Only files with an "**AC-" line are checked.
 * Rule: every non-blank line the coordinator wrote outside the record sections must still be there outside the record
 * sections (so an AC swallowed by a record heading counts as removed), and no new AC line may appear outside them.
 */
export function findProtectedChanges(baseText, headText) {
  if (!AC_LINE.test(baseText)) return [];
  const base = protectedLines(baseText);
  const head = protectedLines(headText);
  const headSet = new Set(head);
  const baseSet = new Set(base);
  const problems = [];
  base.forEach((line, i) => {
    if (line.trim() !== "" && !headSet.has(line)) {
      problems.push(`removed, changed or moved into a record section (base line ${i + 1}): ${line.slice(0, 100)}`);
    }
  });
  head.forEach((line, i) => {
    if (AC_LINE.test(line) && !baseSet.has(line)) {
      problems.push(`acceptance criterion added outside a record section (head line ${i + 1}): ${line.slice(0, 100)}`);
    }
  });
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
      try {
        headText = git(["show", `${headRef}:${file}`]);
      } catch {
        headText = "";
      }
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
