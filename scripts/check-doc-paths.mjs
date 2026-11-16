// Checks that the file paths and relative links written in the architecture documents exist.
// RF-0 had this as a shell one-liner in a task sheet; it is a script now so that CI runs it
// (`npm run check:docs`) and a path in these documents cannot go stale unnoticed.
//
// Scope: it only proves that a written path exists. It does NOT prove that the sentence around it is true
// (what a file does, versions, counts). Those are checked by hand against the code; see TaskSheets/RECURRENCE.md.
//
// Limits (what it does not see):
//   - only the documents in DOCS;
//   - only paths that start with src/ crates/ src-tauri/ TaskSheets/ docs/ e2e/ scripts/ vendor/ (not `foo.ts`
//     alone, not `.github/...`), and not brace forms such as `src/{a,b}/x.ts`;
//   - only links that look like `](./something)`; `](ADR-x.md)` and `](../x)` are not checked.
// Text from a heading named "これから" (things decided but not built yet, e.g. src/plugins/) to the end of a
// file is skipped: those paths do not exist yet on purpose.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DOCS = ["TaskSheets/ARCHITECTURE.md", "TaskSheets/ROADMAP.md", "CLAUDE.md"];
// Decided in ADR-0022 / ADR-0023 but not built yet. Matched exactly. When one of them exists, the check fails
// and says to remove it from this list, so the list cannot go stale.
export const NOT_BUILT_YET = ["src/plugin-api", "src/plugins", "src/ui/kit", "src/core/plugin-host.ts", "src/app/tea.ts"];
const PATH_RE = /(?:src|crates|src-tauri|TaskSheets|docs|e2e|scripts|vendor)\/[A-Za-z0-9_./*-]+/g;
const LINK_RE = /\]\((\.\/[^)#\s]+)/g;

/** Returns the lines to report: paths and links that do not exist, and NOT_BUILT_YET entries that now exist. */
export function checkDocs(root, docs = DOCS, notBuiltYet = NOT_BUILT_YET) {
  const problems = [];
  for (const entry of notBuiltYet) {
    if (existsSync(join(root, entry))) problems.push(`${entry} exists now: remove it from NOT_BUILT_YET in scripts/check-doc-paths.mjs`);
  }
  for (const doc of docs) {
    const text = readFileSync(join(root, doc), "utf8").split(/\r?\n/);
    const end = text.findIndex((line) => /^##\s+これから/.test(line));
    const body = (end < 0 ? text : text.slice(0, end)).join("\n");

    for (const match of body.matchAll(PATH_RE)) {
      const path = match[0].replace(/[.,]+$/, "").replace(/\/+$/, "");
      if (path.includes("*")) continue; // a glob such as src/state/use*
      if (notBuiltYet.includes(path)) continue;
      if (!existsSync(join(root, path))) problems.push(`${doc}: ${path}`);
    }
    for (const match of body.matchAll(LINK_RE)) {
      if (!existsSync(join(root, dirname(doc), match[1]))) problems.push(`${doc}: link ${match[1]}`);
    }
  }
  return [...new Set(problems)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkDocs(root);
  if (problems.length > 0) {
    console.error("Problems in the documents' paths:");
    for (const line of problems) console.error("  " + line);
    process.exit(1);
  }
  console.log(`OK: every path and link in ${DOCS.join(", ")} exists`);
}
