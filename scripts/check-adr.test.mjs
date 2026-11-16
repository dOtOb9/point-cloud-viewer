// @vitest-environment node
import { describe, expect, it } from "vitest";
import { adrStatus, checkAdr, hasWord } from "./check-adr.mjs";

// 60 lines; `parentKey` on line 3, `indexByKey` on line 5, `hierarchyByKey` on line 55 (far from line 3).
const lines = Array.from({ length: 60 }, (_, i) => `// filler ${i + 1}`);
lines[2] = "export function parentKey(key) {";
lines[4] = "const indexByKey = new Map();";
lines[54] = "const hierarchyByKey = new Map();";
const FILE = lines.join("\n");
const fs = { exists: (p) => p === "src/x.ts", read: () => FILE };

function adr(rows, status = "採択") {
  return `# ADR-0099: t\n\n- 状態: ${status}\n\n## 依存するコードの確認\n\n| 場所 | 識別子 | 前提 |\n|---|---|---|\n${rows}\n\n## 整合の確認\n\nADR-0022 ADR-0023 ok\n\n## 数えた物\n\nなし\n`;
}
const GOOD =
  "| `src/x.ts:3` | `parentKey` | reads 4 parts of the key |\n| `src/x.ts:5` | `indexByKey` | builds the index by key |\n| `src/x.ts:3` | `parentKey` | returns null for others |";

describe("check-adr", () => {
  it("accepts an ADR whose references are real", () => {
    expect(checkAdr(adr(GOOD), fs)).toEqual([]);
    expect(checkAdr(adr(GOOD), fs, { changed: true })).toEqual([]);
  });

  it("rejects a missing section", () => {
    expect(checkAdr("# ADR-0099\n", fs).length).toBeGreaterThanOrEqual(3);
  });

  it("rejects too few rows", () => {
    expect(checkAdr(adr("| `src/x.ts:3` | `parentKey` | reads 4 parts |"), fs)[0]).toMatch(/at least 3/);
  });

  it("rejects a file that does not exist, a line past the end and a symbol that is not in the file", () => {
    const rows =
      "| `src/gone.ts:3` | `parentKey` | reads it carefully |\n| `src/x.ts:99` | `parentKey` | reads it carefully |\n| `src/x.ts:3` | `noSuchThing` | reads it carefully |";
    const problems = checkAdr(adr(rows), fs);
    expect(problems.some((p) => /does not exist/.test(p))).toBe(true);
    expect(problems.some((p) => /only 60 lines/.test(p))).toBe(true);
    expect(problems.some((p) => /noSuchThing.*not in the file/.test(p))).toBe(true);
  });

  it("rejects generic short names and an empty premise (the loophole found in review)", () => {
    const rows = "| `src/x.ts:3` | `key` | x |\n| `src/x.ts:3` | `if` | x |\n| `src/x.ts:3` | `a` | x |\n| `src/x.ts:3` | `parentKey` |  |";
    const problems = checkAdr(adr(rows), fs);
    expect(problems.filter((p) => /keyword or a generic word/.test(p))).toHaveLength(1); // key
    expect(problems.filter((p) => /shorter than 3/.test(p))).toHaveLength(2); // if, a
    expect(problems.some((p) => /premise cell/.test(p))).toBe(true);
  });

  it("rejects language keywords and library words even in a proposal (the loophole found in review)", () => {
    const rows = [
      "| `src/x.ts:3` | `private` | a keyword proves nothing |",
      "| `src/x.ts:3` | `Promise` | a built-in proves nothing |",
      "| `src/x.ts:3` | `interface` | a keyword proves nothing |",
    ].join("\n");
    const problems = checkAdr(adr(rows, "提案"), fs);
    expect(problems.filter((p) => /keyword or a generic word/.test(p))).toHaveLength(3);
  });

  it("requires the symbol to be declared or defined in the file, not only mentioned", () => {
    // `filler` appears in every comment line of the file but is never declared.
    const rows = [
      "| `src/x.ts:3` | `filler` | only mentioned in comments |",
      "| `src/x.ts:5` | `indexByKey` | builds the index by key |",
      "| `src/x.ts:3` | `parentKey` | returns null for others |",
    ].join("\n");
    expect(checkAdr(adr(rows, "提案"), fs).some((p) => /never declared or defined/.test(p))).toBe(true);
  });

  it("matches whole words only", () => {
    expect(hasWord("const hierarchyByKey = 1", "hierarchyByKey")).toBe(true);
    expect(hasWord("const myhierarchyByKey2 = 1", "hierarchyByKey")).toBe(false);
    expect(hasWord("parentKeys(x)", "parentKey")).toBe(false);
  });

  it("checks the distance of the line only for a proposal or a changed ADR", () => {
    // `hierarchyByKey` is in the file, but 52 lines away from line 3.
    const far = "| `src/x.ts:3` | `hierarchyByKey` | claims it is near parentKey |\n| `src/x.ts:5` | `indexByKey` | builds the index by key |\n| `src/x.ts:3` | `parentKey` | returns null for others |";
    expect(checkAdr(adr(far, "採択"), fs)).toEqual([]); // an accepted ADR nobody touched: unrelated code moving must not fail it
    expect(checkAdr(adr(far, "採択"), fs, { changed: true }).some((p) => /within 20 lines/.test(p))).toBe(true);
    expect(checkAdr(adr(far, "提案"), fs).some((p) => /within 20 lines/.test(p))).toBe(true);
  });

  it("reads the status word", () => {
    expect(adrStatus("- 状態: **提案**（草稿）")).toBe("提案");
    expect(adrStatus("- 状態: 採択（所有者）")).toBe("採択");
    expect(adrStatus("no status")).toBe(null);
  });

  it("requires the fit section to name ADR-0022 and ADR-0023", () => {
    expect(checkAdr(adr(GOOD).replace("ADR-0022 ADR-0023 ok", "fine"), fs).some((p) => /ADR-0022/.test(p))).toBe(true);
  });
});
