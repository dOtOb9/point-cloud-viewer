// @vitest-environment node
import { describe, expect, it } from "vitest";
import { commentsOf, hasReasonWord, linesPointingAtComments, removedCommentsWithReasons } from "./removed-comment-reasons.mjs";

describe("removed-comment-reasons: comments whose reason would be lost", () => {
  it("finds the CM-3 R1 F-1 kinds of reason (a step's why, not a number)", () => {
    expect(hasReasonWord("// Not in the `converting` status: Web progress may arrive before the status turns converting, and it must not be lost (R5).")).toBe(true);
    expect(hasReasonWord("* その中に置くと `position: fixed` の基準がパネルになってしまうため、`document.body` へ portal で出す。")).toBe(true);
    expect(hasReasonWord("// 広い画面では従来どおり開いておく(E2Eが変換の内訳の表示を待つため")).toBe(true);
    expect(hasReasonWord("// `sectionAxes` is the TypeScript twin of `SectionAxes` in crates/pcv-core/src/profile.rs")).toBe(true);
    expect(hasReasonWord("* Name of the file converted last. Not in the `converting` status: the dialog still shows it (R5).")).toBe(true);
    expect(hasReasonWord("/** Opens the DTM dialog. */")).toBe(false);
  });

  it("lists a removed comment with a reason, and not one that is still there or one without a reason", () => {
    const base = ["// kept because it is still here", "const a = 1;", "// moved away because the drawer covers the points", "// just a label", "const b = 2;"].join("\n");
    const head = ["// kept because it is still here", "const a = 1;", "const b = 2;"].join("\n");
    expect(removedCommentsWithReasons(base, head, "src/x.ts")).toEqual([{ line: 3, body: "// moved away because the drawer covers the points" }]);
  });

  it("reads JSX comments, block comments and the # lines of YAML", () => {
    expect(commentsOf("const x = <div>{/* shown because */}</div>;", "a.tsx").map((c) => c.body)).toEqual(["/* shown because */"]);
    expect(commentsOf("on:\n  # never cached, so that\n  push: {}\n", "ci.yml")).toEqual([{ line: 2, body: "# never cached, so that" }]);
    expect(commentsOf("#!/bin/sh\n# usage\n", "x.ps1").map((c) => c.body)).toEqual(["# usage"]);
  });
});

describe("removed-comment-reasons --docs: documents that send the reader to a code comment", () => {
  it("finds the lines of CM-3 R1 F-2", () => {
    const text = [
      "各 hook の先頭のコメントを読めば、何に依存しているかが分かります。",
      "  (`ci.yml`の`rust`ジョブのコメント、2026-10-07の緊急修正参照)",
      "hook の引数の型に全部出ています。",
    ].join("\n");
    expect(linesPointingAtComments(text).map((l) => l.line)).toEqual([1, 2]);
  });

  it("leaves lines that only talk about comments in general", () => {
    expect(linesPointingAtComments("確認後、コメントアウトした行を必ず元に戻すこと。`edl.ts`")).toEqual([]);
    expect(linesPointingAtComments("`StatusBar.tsx`(コメントのみ)")).toEqual([]);
  });
});
