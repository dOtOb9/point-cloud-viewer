// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkAdr } from "./check-adr.mjs";

const FILE = ["a", "b", "export function parentKey(key) {", "c", "const indexByKey = new Map();", "d"].join("\n");
const fs = { exists: (p) => p === "src/x.ts", read: () => FILE };

function adr(rows, extra = "") {
  return `# ADR-0099: t\n\n## 依存するコードの確認\n\n| 場所 | 識別子 | 前提 |\n|---|---|---|\n${rows}\n\n## 整合の確認\n\nADR-0022 ADR-0023 ok\n\n## 数えた物\n\nなし\n${extra}`;
}
const GOOD = "| `src/x.ts:3` | `parentKey` | reads 4 parts |\n| `src/x.ts:5` | `indexByKey` | by key |\n| `src/x.ts:3` | `parentKey` | again |";

describe("check-adr", () => {
  it("accepts an ADR whose references are real", () => {
    expect(checkAdr(adr(GOOD), fs)).toEqual([]);
  });

  it("rejects a missing section", () => {
    expect(checkAdr("# ADR-0099\n", fs).length).toBeGreaterThanOrEqual(3);
  });

  it("rejects too few rows", () => {
    expect(checkAdr(adr("| `src/x.ts:3` | `parentKey` | x |"), fs)[0]).toMatch(/at least 3/);
  });

  it("rejects a file that does not exist, a line past the end and a symbol that is not there", () => {
    const rows = "| `src/gone.ts:3` | `parentKey` | x |\n| `src/x.ts:99` | `parentKey` | x |\n| `src/x.ts:3` | `hierarchyByKey` | x |";
    const problems = checkAdr(adr(rows), fs);
    expect(problems.some((p) => /does not exist/.test(p))).toBe(true);
    expect(problems.some((p) => /only 6 lines/.test(p))).toBe(true);
    expect(problems.some((p) => /hierarchyByKey.*not found/.test(p))).toBe(true);
  });

  it("requires the fit section to name ADR-0022 and ADR-0023", () => {
    expect(checkAdr(adr(GOOD).replace("ADR-0022 ADR-0023 ok", "fine"), fs).some((p) => /ADR-0022/.test(p))).toBe(true);
  });
});
