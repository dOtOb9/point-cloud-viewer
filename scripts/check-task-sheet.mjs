import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = /^（作業エージェントが.*足す）$/;
const AC_LINE = /\*\*AC-\d+\*\*/;
const HORIZONTAL_RULE = /^(-{3,}|[*]{3,}|_{3,})$/;
const RECORD_HEADING = /^#{1,6}\s+.*記録/;
function isRecordHeading(line) {
  return RECORD_HEADING.test(line);
}

export function protectedLines(text) {
  const out = [];
  let recordLevel = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (recordLevel !== null && level <= recordLevel) recordLevel = null;
      if (recordLevel === null && /記録/.test(heading[2])) {
        recordLevel = level;
        out.push(line);
        continue;
      }
    }
    if (recordLevel === null && !PLACEHOLDER.test(line.trim()) && !HORIZONTAL_RULE.test(line.trim())) out.push(line);
  }
  return out;
}

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
    if (line.trim() === "" || baseSet.has(line) || isRecordHeading(line)) return;
    problems.push(`line added outside a record section (head line ${i + 1}): ${line.slice(0, 100)}`);
  });
  if (problems.length === 0) {
    const wanted = base.filter((l) => l.trim() !== "");
    let k = 0;
    for (const line of head) {
      if (k < wanted.length && line === wanted[k]) k++;
    }
    if (k < wanted.length) problems.push(`lines outside the record sections were reordered (first out of place: ${wanted[k].slice(0, 100)})`);
  }
  return problems;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const USAGE = `usage: node scripts/check-task-sheet.mjs <base-ref> [head-ref]

A worker must not change the coordinator's part of a task sheet (AGENTS.md, 作業役の決まり).
Compares every TaskSheets/*.md that has acceptance criteria ("**AC-<n>**") at <base-ref> with the same file at
[head-ref] (default: the working tree). Outside the record sections, every non-blank line of <base-ref> must still be
there, in the same order, and no new non-blank line may appear (except the heading of a record section).
A record section starts at a heading that contains "記録" ("## 記録", "### 実装の記録 R1"), at any level, and ends at
the next heading of the same or a higher level. A horizontal rule is only a separator.
<base-ref> = the commit before the loop started; if the coordinator fixed an AC during the loop, the commit after that fix.`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [baseRef, headRef] = process.argv.slice(2);
  if (baseRef === "--help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (!baseRef) {
    console.error(USAGE);
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
