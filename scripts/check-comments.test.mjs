// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  compareWithBaseline,
  findCountedComments,
  formatProblems,
  isCheckedFile,
  loweredBaseline,
} from "./check-comments.mjs";

function countedLines(text, fileName) {
  return findCountedComments(text, fileName).map((comment) => comment.line);
}

function previews(text, fileName) {
  return findCountedComments(text, fileName).map((comment) => comment.preview);
}

describe("check-comments: TypeScript and JavaScript", () => {
  it("counts a line comment, a trailing comment, a block comment and a JSDoc", () => {
    const text = [
      "// line",
      "const a = 1; // trailing",
      "/* block",
      "   still block */",
      "/** jsdoc */",
      "export function f() {",
      "  return a /* inside an expression */ + 1;",
      "}",
    ].join("\n");
    expect(countedLines(text, "x.ts")).toEqual([1, 2, 3, 5, 7]);
  });

  it("counts a comment inside JSX braces and between JSX attributes", () => {
    const text = [
      "export const A = () => (",
      "  <div",
      "    // between attributes",
      '    title="t">',
      "    {/* in braces */}",
      "  </div>",
      ");",
    ].join("\n");
    expect(countedLines(text, "x.tsx")).toEqual([3, 5]);
  });

  it("does not count // or /* in JSX text", () => {
    const text = "export const A = () => <a href=\"https://x\">see https://example.com and /* this */</a>;\n";
    expect(countedLines(text, "x.tsx")).toEqual([]);
  });

  it("does not count // or /* in strings, template strings and regular expressions", () => {
    const text = [
      'const url = "https://example.com/a";',
      'const s = "a // b /* c */";',
      "const q = 'a // b';",
      "const t = `a // b ${url /* counted */} /* not */ ${`// nested ${s}`}`;",
      "const r = /\\/\\//;",
      "const r2 = /[/*]+/g;",
      "const d = 4 / 2 / 1;",
      "const after = r.test(t); // counted",
    ].join("\n");
    expect(previews(text, "x.ts")).toEqual(["/* counted */", "// counted"]);
  });

  it("does not count // in a regular expression or a template in a .js file", () => {
    const text = "const r = /https?:\\/\\//;\nconst t = `${'x'}// not`;\n";
    expect(countedLines(text, "x.mjs")).toEqual([]);
  });

  it("allows the tool directives", () => {
    const text = [
      "#!/usr/bin/env node",
      "// @ts-check",
      "/// <reference types=\"vite/client\" />",
      "// @vitest-environment jsdom",
      "/** @vitest-environment node */",
      "// eslint-disable-next-line no-console -- reason",
      "/* eslint-disable no-console */",
      "// @ts-expect-error no types",
      "console.log(1);",
    ].join("\n");
    expect(countedLines(text, "x.js")).toEqual([]);
  });

  it("counts @ts-ignore, because @ts-expect-error does the same job and fails once the error is gone", () => {
    expect(countedLines("// @ts-ignore\nconst a: number = \"x\";\n/* @ts-ignore */\n", "x.ts")).toEqual([1, 3]);
  });

  it("counts a comment that only mentions a directive later in its text", () => {
    expect(countedLines("// see @ts-expect-error below\nconst a = 1;\n", "x.ts")).toEqual([1]);
  });

  it("gives the line and the beginning of the text", () => {
    const comments = findCountedComments("const a = 1;\n\n// " + "x".repeat(200) + "\n", "x.ts");
    expect(comments).toHaveLength(1);
    expect(comments[0].line).toBe(3);
    expect(comments[0].preview).toBe("// " + "x".repeat(77));
  });
});

describe("check-comments: Rust", () => {
  it("counts //, ///, //!, a block comment and a nested block comment once", () => {
    const text = [
      "//! crate doc",
      "/// item doc",
      "fn f() -> i32 { // trailing",
      "    /* outer /* inner */ still outer */ 1",
      "}",
      "/*! inner block doc */",
    ].join("\n");
    expect(countedLines(text, "x.rs")).toEqual([1, 2, 3, 4, 6]);
    expect(previews(text, "x.rs")[3]).toBe("/* outer /* inner */ still outer */");
  });

  it("does not count // or /* in strings, raw strings, byte strings and characters", () => {
    const text = [
      'let a = "https://example.com /* x */";',
      'let b = "escaped \\" // still string";',
      'let c = r#"raw // "quoted" /* */"#;',
      'let d = r"raw // plain";',
      'let e = br##"bytes "# // "##;',
      'let f = b"bytes // x";',
      "let g = '/';",
      "let h = b'/';",
      "let i = '\\'';",
      "let j = '\"'; let k = \"// not\";",
    ].join("\n");
    expect(countedLines(text, "x.rs")).toEqual([]);
  });

  it("treats a lifetime as a lifetime, not the start of a character, so the comment after it counts", () => {
    const text = [
      "fn f<'a>(x: &'a str) -> &'a str { x } // after lifetimes",
      "'outer: loop { break 'outer; } // after a label",
      "fn g<'a, 'b>(_: &'a u8, _: &'b u8) {} /* block */",
    ].join("\n");
    expect(countedLines(text, "x.rs")).toEqual([1, 2, 3]);
  });

  it("does not take an identifier that ends in r or b for a raw or byte string prefix", () => {
    const text = 'let bar = "x"; let rb = 1; let s = format!("{}", bar); // counted\n';
    expect(countedLines(text, "x.rs")).toEqual([1]);
  });

  it("allows // SAFETY: only when the next non-empty line has unsafe", () => {
    const text = [
      "// SAFETY: the pointer is valid",
      "",
      "unsafe { f() };",
      "// SAFETY: written before an unsafe impl",
      "unsafe impl Send for X {}",
      "// SAFETY: but nothing unsafe follows",
      "let a = 1;",
      "// SAFETY: a second line",
      "// keeps the reason going",
      "unsafe { g() };",
    ].join("\n");
    expect(countedLines(text, "x.rs")).toEqual([6, 8, 9]);
  });

  it("does not allow // SAFETY: when the next non-empty line is a comment that says unsafe", () => {
    const text = [
      "// SAFETY: looks allowed",
      "// this is unsafe because of the pointer",
      "let a = 1;",
      "// SAFETY: before a block comment",
      "/* unsafe */",
      "unsafe { f() };",
    ].join("\n");
    expect(countedLines(text, "x.rs")).toEqual([1, 2, 4, 5]);
  });

  it("gives the beginning of a line comment without the \\r of a CRLF line end", () => {
    expect(previews("// crlf\r\nfn f() {} /* block */\r\n", "x.rs")).toEqual(["// crlf", "/* block */"]);
    expect(previews("// crlf\r\nconst a = 1;\r\n", "x.ts")).toEqual(["// crlf"]);
  });

  it("allows // SAFETY: before unsafe in TypeScript too, with the same rule", () => {
    expect(countedLines("// SAFETY: x\nconst a = 1;\n", "x.ts")).toEqual([1]);
  });
});

describe("check-comments: WGSL", () => {
  it("counts //, a block comment and a nested block comment once in a .wgsl file", () => {
    const text = [
      "// line",
      "@group(0) @binding(0) var<uniform> u: vec4<f32>; // trailing",
      "/* outer /* inner */ still outer */",
      "@fragment",
      "fn fs_main() -> @location(0) vec4<f32> {",
      "  return u / 2.0;",
      "}",
    ].join("\n");
    expect(countedLines(text, "src/renderer/shaders/x.wgsl")).toEqual([1, 2, 3]);
  });

  it("does not count a division", () => {
    expect(countedLines("fn f(a: f32) -> f32 { return a / 2.0 / 3.0; }\n", "x.wgsl")).toEqual([]);
  });
});

describe("check-comments: which files are checked", () => {
  it("checks the source extensions and skips vendor, generated wasm glue, generated tsx and documents", () => {
    expect(isCheckedFile("src/app/a.ts")).toBe(true);
    expect(isCheckedFile("src/ui/A.tsx")).toBe(true);
    expect(isCheckedFile("scripts/a.mjs")).toBe(true);
    expect(isCheckedFile("scripts/a.cjs")).toBe(true);
    expect(isCheckedFile("eslint.config.js")).toBe(true);
    expect(isCheckedFile("crates/pcv-core/src/lib.rs")).toBe(true);
    expect(isCheckedFile("src/renderer/shaders/points.wgsl")).toBe(true);
    expect(isCheckedFile("vendor/copc-writer/src/lib.rs")).toBe(false);
    expect(isCheckedFile("src/wasm/pcv-wasm/pcv_wasm.js")).toBe(false);
    expect(isCheckedFile("src/ui/icons.generated.tsx")).toBe(false);
    expect(isCheckedFile("docs/book/index.html")).toBe(false);
    expect(isCheckedFile("docs/book/chapter.md")).toBe(false);
    expect(isCheckedFile("TaskSheets/x.ts")).toBe(false);
    expect(isCheckedFile("src/ui/a.css")).toBe(false);
    expect(isCheckedFile("Cargo.toml")).toBe(false);
  });
});

describe("check-comments: code under docs is still code", () => {
  it("checks the video tools scripts that CM-3 has to clean", () => {
    expect(isCheckedFile("docs/video/tools/render.mjs")).toBe(true);
    expect(isCheckedFile("docs/video/tools/lib/captions.mjs")).toBe(true);
  });
});

describe("check-comments: the baseline only goes down", () => {
  const comment = (line) => ({ line, preview: "// x" });

  it("fails a file over its limit and a file with no entry, and lists every comment with file:line", () => {
    const result = compareWithBaseline({ "a.ts": [comment(1), comment(5)], "new.ts": [comment(3)] }, { "a.ts": 1 });
    expect(result.tooMany.map((entry) => entry.file)).toEqual(["a.ts", "new.ts"]);
    const lines = formatProblems(result);
    expect(lines).toContain("  a.ts:5: // x");
    expect(lines).toContain("  new.ts:3: // x");
  });

  it("asks to lower a limit that is above the count, and to remove an entry that reached 0", () => {
    const result = compareWithBaseline({ "a.ts": [comment(1)] }, { "a.ts": 3, "gone.ts": 2 });
    expect(result.tooMany).toEqual([]);
    expect(result.lowerTheLimit).toEqual([
      { file: "a.ts", limit: 3, count: 1 },
      { file: "gone.ts", limit: 2, count: 0 },
    ]);
    const lines = formatProblems(result).join("\n");
    expect(lines).toMatch(/a\.ts: 1 comments but the limit is 3: lower it to 1/);
    expect(lines).toMatch(/gone\.ts: 0 comments but the limit is 2: remove the entry/);
  });

  it("passes when every count equals its limit", () => {
    const result = compareWithBaseline({ "a.ts": [comment(1)] }, { "a.ts": 1 });
    expect(formatProblems(result)).toEqual([]);
  });

  it("lowers the baseline without ever raising it or adding a file", () => {
    const lowered = loweredBaseline(
      { "a.ts": [comment(1)], "b.ts": [comment(1), comment(2), comment(3)], "new.ts": [comment(1)] },
      { "a.ts": 2, "b.ts": 1, "gone.ts": 4 },
    );
    expect(lowered).toEqual({ "a.ts": 1, "b.ts": 1 });
  });
});
