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
  "src/datasource/copc.worker.ts": 1376,
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

/**
 * Ways of deciding "does this element take typed keys?" that must only exist in src/app/typing-target.ts:
 * the upper-case tag names INPUT / TEXTAREA / SELECT (as in `tag === "INPUT"`, also on a line of their own),
 * `isContentEditable` (a type declaration line `isContentEditable?: boolean` is not a use), and
 * `instanceof HTMLInputElement / HTMLTextAreaElement / HTMLSelectElement`. Lower-case words are not looked at
 * ("select" is also a tool mode name). Returns what was found, so a test can show it finds each form.
 *
 * What it does NOT see (a text search cannot): `el.matches("input, textarea, select")`, `el.closest(...)`, a list of
 * lower-case tag names, or any other new way of asking. Those are covered by the rule in AGENTS.md ("call
 * isTypingTarget(), do not compare tag names yourself"), which the auditor checks in the diff.
 */
export function findTypingTargetCopies(text: string): string[] {
  const found: string[] = [];
  const patterns: [string, RegExp][] = [
    ["tag name string", /["'](INPUT|TEXTAREA|SELECT)["']/],
    ["isContentEditable", /isContentEditable(?!\??\s*:\s*boolean)/],
    ["instanceof HTML*Element", /instanceof\s+HTML(Input|TextArea|Select)Element/],
  ];
  for (const [name, re] of patterns) if (re.test(text)) found.push(name);
  return found;
}

describe("typing target", () => {
  it("finds each form of a copy (so the check below is not blind to them)", () => {
    // A: tag name and string on the same line
    expect(findTypingTargetCopies('return target.tagName === "INPUT" || x;')).toEqual(["tag name string"]);
    // B: the layer-delete-key.ts shape before TP-1: the comparison is on the line after tagName
    expect(findTypingTargetCopies('const tag = target.tagName?.toUpperCase();\n  return tag === "INPUT" || tag === "SELECT";')).toEqual([
      "tag name string",
    ]);
    // C: contenteditable, and instanceof
    expect(findTypingTargetCopies("if (el.isContentEditable) return true;")).toEqual(["isContentEditable"]);
    expect(findTypingTargetCopies("return t instanceof HTMLInputElement;")).toEqual(["instanceof HTML*Element"]);
    expect(findTypingTargetCopies("return t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;")).toEqual(["instanceof HTML*Element"]);
  });

  it("does not flag a type declaration or a tool mode called select", () => {
    expect(findTypingTargetCopies("interface T { tagName?: string; isContentEditable?: boolean }")).toEqual([]);
    expect(findTypingTargetCopies('const mode = "select"; if (mode === "select") {}')).toEqual([]);
  });

  it("only src/app/typing-target.ts decides whether an element takes typed keys", () => {
    const offenders: string[] = [];
    for (const [path, text] of FILES) {
      // Tests build fake elements ({ tagName: "INPUT" }); only code that decides is checked.
      if (path === "src/app/typing-target.ts" || isTest(path)) continue;
      const found = findTypingTargetCopies(text);
      if (found.length > 0) offenders.push(`${path} (${found.join(", ")})`);
    }
    expect(offenders, "use isTypingTarget() from src/app/typing-target.ts").toEqual([]);
  });
});

describe("which typing check a key uses", () => {
  // Audit trendpoint-parity-PR R2 F-1: keys that destroy or decide something must keep the safe check (isFormControl:
  // any form control keeps them); only the harmless view keys use the narrower isTypingTarget. See typing-target.ts.
  it("Delete (layer) and Enter / Esc (measure, selection tools) use isFormControl, never isTypingTarget", () => {
    for (const path of ["src/ui/layers/layer-delete-key.ts", "src/state/useMeasureTool.ts", "src/state/useLayerTool.ts"]) {
      const text = FILES.find(([p]) => p === path)?.[1] ?? "";
      expect(text, path).toContain("isFormControl(");
      expect(text, path).not.toContain("isTypingTarget(");
    }
  });
  it("the view keys use isTypingTarget", () => {
    expect(FILES.find(([p]) => p === "src/app/view.ts")?.[1] ?? "").toContain("isTypingTarget(");
  });
});
