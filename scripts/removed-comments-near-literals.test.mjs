// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findRemovedCommentsNearLiterals } from "./removed-comments-near-literals.mjs";

describe("removed-comments-near-literals", () => {
  it("lists a removed comment above a number that is still bare (CM-5 F-1)", () => {
    const base = [
      "fn params() -> CopcWriterParams {",
      "    // A small memory budget makes the octree split on disk.",
      "    CopcWriterParams::new(500).with_memory_budget_bytes(256 * 1024)",
      "}",
    ].join("\n");
    const head = [
      "fn params() -> CopcWriterParams {",
      "    CopcWriterParams::new(500).with_memory_budget_bytes(256 * 1024)",
      "}",
    ].join("\n");
    const found = findRemovedCommentsNearLiterals(base, head, "a.rs");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2, literals: ["500", "256", "1024"] });
  });

  it("lists a removed doc comment whose function still has a bare short string (CM-5 F-2)", () => {
    const base = [
      "/// The dev server origin differs from pcv://, so without this the fetch fails.",
      "fn response() -> Response {",
      "    Response::builder()",
      '        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")',
      "        .unwrap()",
      "}",
    ].join("\n");
    const head = base.split("\n").slice(1).join("\n");
    const found = findRemovedCommentsNearLiterals(base, head, "lib.rs");
    expect(found.map((item) => item.literals)).toEqual([['"*"']]);
  });

  it("gives every bare number of the line, not only the first one", () => {
    const base = ["// The budget is small so that the octree splits on disk.", "let p = new(500).budget(64 * 1024);"].join("\n");
    const head = "let p = new(500).budget(64 * 1024);";
    const [item] = findRemovedCommentsNearLiterals(base, head, "a.rs");
    expect(item.literals).toEqual(["500", "64", "1024"]);
  });

  it("does not list the comment once the literal is named", () => {
    const base = [
      "fn params() -> CopcWriterParams {",
      "    // A small memory budget makes the octree split on disk.",
      "    CopcWriterParams::new(x).with_memory_budget_bytes(256 * 1024)",
      "}",
    ].join("\n");
    const head = [
      "const MEMORY_BUDGET_SMALL_ENOUGH_TO_SPLIT_THE_OCTREE_ON_DISK: u64 = 256 * 1024;",
      "fn params() -> CopcWriterParams {",
      "    CopcWriterParams::new(x).with_memory_budget_bytes(MEMORY_BUDGET_SMALL_ENOUGH_TO_SPLIT_THE_OCTREE_ON_DISK)",
      "}",
    ].join("\n");
    expect(findRemovedCommentsNearLiterals(base, head, "a.rs")).toEqual([]);
  });

  it("does not list a comment that is kept, or one next to 0, 1 and 2 only", () => {
    const base = ["// kept: 4096 is the stride", "const STRIDE: u64 = 4096;", "// gone", "let x = vec![0, 1, 2];"].join(
      "\n",
    );
    const head = ["// kept: 4096 is the stride", "const STRIDE: u64 = 4096;", "let x = vec![0, 1, 2];"].join("\n");
    expect(findRemovedCommentsNearLiterals(base, head, "a.rs")).toEqual([]);
  });

  it("does not list the allowed // SAFETY: line, and reads TypeScript comments", () => {
    const rust = ["// SAFETY: fine", "let p = unsafe { f(8) };"].join("\n");
    expect(findRemovedCommentsNearLiterals(rust, "let p = unsafe { f(8) };", "a.rs")).toEqual([]);
    const ts = ["// 1420 is the dev server port", "const url = `http://localhost:${port}`;", "const port = 1420;"].join("\n");
    const tsHead = ["const url = `http://localhost:${port}`;", "const port = 1420;"].join("\n");
    expect(findRemovedCommentsNearLiterals(ts, tsHead, "a.ts").map((item) => item.literals)).toEqual([["1420"]]);
  });

  it("lists one entry per bare line even when a doc comment has many lines", () => {
    const base = ["/// first line", "/// second line", "const LIMIT: u64 = 512 * 1024 * 1024;"].join("\n");
    const head = "const LIMIT: u64 = 512 * 1024 * 1024;";
    expect(findRemovedCommentsNearLiterals(base, head, "a.rs")).toHaveLength(1);
  });
});
