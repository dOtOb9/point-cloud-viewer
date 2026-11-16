// Checks that the file paths and relative links written in the architecture documents exist.
// RF-0 had this as a shell one-liner in a task sheet; it is a script now so that CI runs it
// (`npm run check:docs`) and a path in ARCHITECTURE.md cannot go stale unnoticed.
//
// Scope: it only proves that a written path exists. It does NOT prove that the sentence around it is true
// (what a file does, versions, counts). Those are checked by hand against the code; see TaskSheets/RECURRENCE.md.
//
// Text from a heading named "これから" (things decided but not built yet, e.g. src/plugins/) to the end of a
// file is skipped: those paths do not exist yet on purpose.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["TaskSheets/ARCHITECTURE.md", "CLAUDE.md"];
// Decided in ADR-0022 / ADR-0023 but not built yet. Remove an entry when the file appears.
const NOT_BUILT_YET = ["src/plugin-api", "src/plugins", "src/ui/kit", "src/core/plugin-host.ts", "src/app/tea.ts"];
const PATH_RE = /(?:src|crates|src-tauri|TaskSheets|docs|e2e|scripts|vendor)\/[A-Za-z0-9_./*-]+/g;
const LINK_RE = /\]\((\.\/[^)#\s]+)/g;

const missing = [];
for (const doc of DOCS) {
  const text = readFileSync(join(root, doc), "utf8").split(/\r?\n/);
  const end = text.findIndex((line) => /^##\s+これから/.test(line));
  const body = (end < 0 ? text : text.slice(0, end)).join("\n");

  for (const match of body.matchAll(PATH_RE)) {
    const path = match[0].replace(/[.,]+$/, "");
    if (path.includes("*")) continue; // a glob such as src/state/use*
    if (NOT_BUILT_YET.some((p) => path === p || path.startsWith(p + "/"))) continue;
    if (!existsSync(join(root, path))) missing.push(`${doc}: ${path}`);
  }
  for (const match of body.matchAll(LINK_RE)) {
    const target = join(root, dirname(doc), match[1]);
    if (!existsSync(target)) missing.push(`${doc}: link ${match[1]}`);
  }
}

if (missing.length > 0) {
  console.error("Paths written in the documents that do not exist:");
  for (const line of [...new Set(missing)]) console.error("  " + line);
  process.exit(1);
}
console.log(`OK: every path and link in ${DOCS.join(", ")} exists`);
