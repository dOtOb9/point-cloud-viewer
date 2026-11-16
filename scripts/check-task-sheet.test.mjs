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
    expect(problems.some((p) => p.includes("## 記録"))).toBe(true);
  });

  it("catches an acceptance criterion added to the coordinator's part", () => {
    const head = BASE.replace("### PF-1 以降（later）", "- **AC-5** invented\n### PF-1 以降（later）");
    expect(findProtectedChanges(BASE, head).some((p) => p.includes("AC-5"))).toBe(true);
  });

  it("allows a nested implementation record under the coordinator's section (the TP-1 sheets)", () => {
    const base = "# TP\n## TP-1 視点\n- **AC-1** a\n- **AC-2** b\n## TP-2 next\n- **AC-3** c\n";
    const head =
      "# TP\n## TP-1 視点\n- **AC-1** a\n- **AC-2** b\n### 実装の記録（作業エージェント R1）\n- did x\n### 実装の記録 R2\n- did y\n## TP-2 next\n- **AC-3** c\n";
    expect(findProtectedChanges(base, head)).toEqual([]);
  });

  it("catches an acceptance criterion rewritten after a record heading was slipped in front of it", () => {
    const base = "# TP\n## TP-1\n- **AC-1** a\n- **AC-4** original\n## TP-2\n- **AC-3** c\n";
    const head = "# TP\n## TP-1\n- **AC-1** a\n### 実装の記録\n- **AC-4** rewritten\n## TP-2\n- **AC-3** c\n";
    const problems = findProtectedChanges(base, head);
    expect(problems.some((p) => p.includes("AC-4") && p.includes("original"))).toBe(true);
  });

  it("ends a nested record at the next heading of the same level", () => {
    const base = "## A\n- **AC-1** a\n### 計画\ntext\n";
    const head = "## A\n- **AC-1** a\n### 実装の記録\nnotes\n### 計画\nchanged text\n";
    expect(findProtectedChanges(base, head).some((p) => p.includes("text"))).toBe(true);
  });

  it("catches a line appended under an acceptance criterion (loosening it by adding a sentence)", () => {
    const head = BASE.replace("- **AC-4** memory limit in numbers", "- **AC-4** memory limit in numbers\n  ただし Web と Android は対象外とする");
    expect(findProtectedChanges(BASE, head).some((p) => p.includes("対象外"))).toBe(true);
  });

  it("catches a new section added outside the record", () => {
    const head = BASE.replace("## 記録", "## 補足\nAC-1 は Web だけでよい\n## 記録");
    const problems = findProtectedChanges(BASE, head);
    expect(problems.some((p) => p.includes("補足"))).toBe(true);
    expect(problems.some((p) => p.includes("Web だけ"))).toBe(true);
  });

  it("catches two acceptance criteria swapped (the order is part of the sheet)", () => {
    const head = BASE.replace("- **AC-1** time it\n- **AC-4** memory limit in numbers", "- **AC-4** memory limit in numbers\n- **AC-1** time it");
    expect(findProtectedChanges(BASE, head).some((p) => /reordered/.test(p))).toBe(true);
  });

  it("ignores a horizontal rule that a record inserted before it swallowed (the TP-1 sheet has one)", () => {
    const base = ["## TP-1", "- **AC-1** a", "", "verify text", "", "---", "", "## TP-2", "- **AC-3** c", ""].join("\n");
    const head = ["## TP-1", "- **AC-1** a", "", "verify text", "", "### 実装の記録", "- did x", "", "---", "", "## TP-2", "- **AC-3** c", "---", ""].join("\n");
    expect(findProtectedChanges(base, head)).toEqual([]);
  });

  it("ignores sheets without acceptance criteria", () => {
    expect(findProtectedChanges("# ADR\ntext\n", "# ADR\nchanged\n")).toEqual([]);
  });
});
