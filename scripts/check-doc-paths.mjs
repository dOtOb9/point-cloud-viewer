import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DOCS = ["TaskSheets/ARCHITECTURE.md", "TaskSheets/ROADMAP.md", "CLAUDE.md"];
export const NOT_BUILT_YET = ["src/plugin-api", "src/plugins", "src/ui/kit", "src/core/plugin-host.ts", "src/app/tea.ts"];
const PATH_RE = /(?:src|crates|src-tauri|TaskSheets|docs|e2e|scripts|vendor)\/[A-Za-z0-9_./*-]+/g;
const LINK_RE = /\]\((\.\/[^)#\s]+)/g;

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
      const isGlob = path.includes("*");
      if (isGlob) continue;
      if (notBuiltYet.includes(path)) continue;
      if (!existsSync(join(root, path))) problems.push(`${doc}: ${path}`);
    }
    for (const match of body.matchAll(LINK_RE)) {
      if (!existsSync(join(root, dirname(doc), match[1]))) problems.push(`${doc}: link ${match[1]}`);
    }
  }
  return [...new Set(problems)];
}

const USAGE = `usage: node scripts/check-doc-paths.mjs   (npm run check:docs)

Checks that the file paths and the relative links written in ${DOCS.join(", ")} exist.
It proves only that a written path exists, not that the sentence around it is true (TaskSheets/RECURRENCE.md).
Not seen: other documents; paths that do not start with src/ crates/ src-tauri/ TaskSheets/ docs/ e2e/ scripts/ vendor/
(foo.ts alone, .github/...); brace forms such as src/{a,b}/x.ts; links other than ](./something).
Text from a heading "## これから" to the end of a document is skipped (decided, not built yet).
NOT_BUILT_YET lists paths decided in ADR-0022 / ADR-0023 but not built; the check fails once one of them exists.`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkDocs(root);
  if (problems.length > 0) {
    console.error("Problems in the documents' paths:");
    for (const line of problems) console.error("  " + line);
    process.exit(1);
  }
  console.log(`OK: every path and link in ${DOCS.join(", ")} exists`);
}
