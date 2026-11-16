// Checks on the shape of the code that no reviewer should have to remember (TaskSheets/RECURRENCE.md, TP-1).
// They run with `npm test`, so CI catches them.
//
// 1. File size. TP-1 added code to point-cloud-renderer.ts (already over 1000 lines) instead of putting it in a pure
//    module. A file over LIMIT lines may not grow, and no new file may pass LIMIT. The numbers in BASELINE are the
//    sizes when this check was added; lower them when a file shrinks (the test says so), never raise them.
// 2. "Is the user typing in this element?" has one answer: src/app/typing-target.ts. Four copies that disagreed
//    (some forgot SELECT) were found in TP-1.
import { describe, expect, it } from "vitest";

const LIMIT = 800;

/** Files already over LIMIT, with the most lines they may have. Only ever lowered. */
const BASELINE: Record<string, number> = {
  "src/datasource/copc.worker.ts": 1733,
  "src/datasource/opfs.ts": 857,
  "src/datasource/web.ts": 901,
  "src/renderer/gpu-resources.ts": 1235,
  "src/renderer/point-cloud-renderer.ts": 1309,
};

// Vite reads every source file as text (the generated wasm glue is left out). Keys look like "./app/view.ts".
const RAW = import.meta.glob(["./**/*.{ts,tsx}", "!./wasm/**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** [repo path, text] of every source file. */
const FILES: [string, string][] = Object.entries(RAW).map(([key, text]) => ["src/" + key.slice(2), text]);
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

function lineCount(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
describe("file size", () => {
  const files = FILES.filter(([path]) => !isTest(path));

  it(`no file passes ${LIMIT} lines, and the ones that do (BASELINE) do not grow`, () => {
    const problems: string[] = [];
    for (const [path, text] of files) {
      const lines = lineCount(text);
      const cap = BASELINE[path] ?? LIMIT;
      if (lines > cap) {
        problems.push(
          `${path}: ${lines} lines (limit ${cap}). Put the new code in its own module (a pure function with a test) instead of adding to this file.`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("BASELINE has no stale entry: every listed file exists and is still over the limit by at least a little", () => {
    const stale: string[] = [];
    for (const [path, cap] of Object.entries(BASELINE)) {
      const file = files.find(([p]) => p === path);
      if (!file) {
        stale.push(`${path}: file not found, remove it from BASELINE`);
      } else if (lineCount(file[1]) <= LIMIT) {
        stale.push(`${path}: now ${lineCount(file[1])} lines (<= ${LIMIT}), remove it from BASELINE`);
      } else if (lineCount(file[1]) < cap) {
        stale.push(`${path}: shrank to ${lineCount(file[1])} lines, lower BASELINE from ${cap}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe("typing target", () => {
  it("only src/app/typing-target.ts decides whether an element takes typed keys", () => {
    const offenders: string[] = [];
    for (const [path, text] of FILES) {
      // Tests build fake elements ({ tagName: "INPUT" }); only code that decides is checked.
      if (path === "src/app/typing-target.ts" || isTest(path)) continue;
      if (/tagName[^\n]*["'](INPUT|TEXTAREA|SELECT)["']/i.test(text)) offenders.push(path);
    }
    expect(offenders, "use isTypingTarget() from src/app/typing-target.ts").toEqual([]);
  });
});
