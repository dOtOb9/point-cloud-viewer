// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findProtectedChanges } from "./check-task-sheet.mjs";

const BASE = `# PF
## 段階
### PF-0
- **AC-1** time it
- **AC-4** memory limit in numbers
### PF-1 以降（later）
## 記録
（作業エージェントが日本語で足す）
`;

describe("check-task-sheet", () => {
  it("allows the worker to write the record and drop the placeholder", () => {
    const head = BASE.replace("（作業エージェントが日本語で足す）", "### PF-0 record\n- AC-1 table\n");
    expect(findProtectedChanges(BASE, head)).toEqual([]);
  });

  it("allows record edits in later rounds", () => {
    const r1 = BASE.replace("（作業エージェントが日本語で足す）", "numbers: 688");
    const r2 = BASE.replace("（作業エージェントが日本語で足す）", "numbers: 974");
    expect(findProtectedChanges(r1, r2)).toEqual([]);
  });

  it("catches a rewritten acceptance criterion (PF-0 R2: a5626f4)", () => {
    const head = BASE.replace("- **AC-4** memory limit in numbers", "- **AC-4** (revised) the design summary");
    const problems = findProtectedChanges(BASE, head);
    expect(problems.some((p) => p.includes("AC-4"))).toBe(true);
  });

  it("catches removed headings and a removed record section", () => {
    const head = BASE.replace("### PF-1 以降（later）\n## 記録\n（作業エージェントが日本語で足す）\n", "");
    const problems = findProtectedChanges(BASE, head);
    expect(problems.some((p) => p.includes("PF-1 以降"))).toBe(true);
    expect(problems).toContain("a record heading was removed");
  });

  it("catches text added to the coordinator's part", () => {
    const head = BASE.replace("### PF-1 以降（later）", "- **AC-5** invented\n### PF-1 以降（later）");
    expect(findProtectedChanges(BASE, head).some((p) => p.includes("AC-5"))).toBe(true);
  });

  it("ignores sheets without acceptance criteria", () => {
    expect(findProtectedChanges("# ADR\ntext\n", "# ADR\nchanged\n")).toEqual([]);
  });
});
