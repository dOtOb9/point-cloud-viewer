// @vitest-environment node
// Tests of scripts/check-doc-paths.mjs (`npm run check:docs`). This file is outside tsc's include ("src" only);
// vitest and eslint still run it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script with no type declarations
import { DOCS, NOT_BUILT_YET, checkDocs } from "./check-doc-paths.mjs";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository root with the given files (path -> text). */
function fakeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pcv-docs-"));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

describe("check-doc-paths", () => {
  it("covers the documents the AGENTS.md rule is about", () => {
    expect(DOCS).toEqual(expect.arrayContaining(["TaskSheets/ARCHITECTURE.md", "TaskSheets/ROADMAP.md", "CLAUDE.md"]));
  });

  it("passes for paths and links that exist", () => {
    const root = fakeRoot({ "TaskSheets/ROADMAP.md": "see `src/a.ts` and [x](./OTHER.md)\n", "src/a.ts": "", "TaskSheets/OTHER.md": "" });
    expect(checkDocs(root, ["TaskSheets/ROADMAP.md"], [])).toEqual([]);
  });

  it("fails for a path or a link that does not exist in ROADMAP.md", () => {
    const root = fakeRoot({ "TaskSheets/ROADMAP.md": "see `src/not-here.ts` and [x](./NOPE.md)\n" });
    expect(checkDocs(root, ["TaskSheets/ROADMAP.md"], [])).toEqual([
      "TaskSheets/ROADMAP.md: src/not-here.ts",
      "TaskSheets/ROADMAP.md: link ./NOPE.md",
    ]);
  });

  it("skips text from the 'これから' heading on", () => {
    const root = fakeRoot({ "CLAUDE.md": "ok\n## これから\n`src/future.ts`\n" });
    expect(checkDocs(root, ["CLAUDE.md"], [])).toEqual([]);
  });

  it("allows only the exact NOT_BUILT_YET entries, not what is below them", () => {
    const root = fakeRoot({ "CLAUDE.md": "`src/plugins` and `src/plugins/anything/x.ts`\n" });
    expect(checkDocs(root, ["CLAUDE.md"], ["src/plugins"])).toEqual(["CLAUDE.md: src/plugins/anything/x.ts"]);
  });

  it("fails when a NOT_BUILT_YET entry exists, so the list cannot go stale", () => {
    const root = fakeRoot({ "CLAUDE.md": "nothing\n", "src/plugins/x.ts": "" });
    expect(checkDocs(root, ["CLAUDE.md"], ["src/plugins"])).toHaveLength(1);
  });

  it("the real documents are clean", () => {
    // process.cwd() is the repository root when vitest runs from it.
    expect(checkDocs(process.cwd())).toEqual([]);
    expect(NOT_BUILT_YET.length).toBeGreaterThan(0);
  });
});
