import { describe, expect, it } from "vitest";

const LIMIT = 800;

const BASELINE: Record<string, number> = {
  "src/datasource/copc.worker.ts": 1376,
  "src/renderer/point-cloud-renderer.ts": 867,
};

const RAW = import.meta.glob(["./**/*.{ts,tsx}", "!./wasm/**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

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
    expect(findTypingTargetCopies('return target.tagName === "INPUT" || x;')).toEqual(["tag name string"]);
    expect(findTypingTargetCopies('const tag = target.tagName?.toUpperCase();\n  return tag === "INPUT" || tag === "SELECT";')).toEqual([
      "tag name string",
    ]);
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
      if (path === "src/app/typing-target.ts" || isTest(path)) continue;
      const found = findTypingTargetCopies(text);
      if (found.length > 0) offenders.push(`${path} (${found.join(", ")})`);
    }
    expect(offenders, "use isTypingTarget() from src/app/typing-target.ts").toEqual([]);
  });
});

describe("which typing check a key uses", () => {
  it("Delete (layer) and Enter / Esc (measure, selection tools) use isFormControl, never isTypingTarget", () => {
    for (const path of ["src/ui/layers/layer-delete-key.ts", "src/state/useMeasureTool.ts", "src/state/useLayerTool.ts"]) {
      const text = FILES.find(([p]) => p === path)?.[1] ?? "";
      expect(text, path).toContain("isFormControl(");
      expect(text, path).not.toContain("isTypingTarget(");
    }
  });
  it("the view keys are harmless plugin shortcuts, which the host checks with isTypingTarget", () => {
    expect(FILES.find(([p]) => p === "src/plugins/view/index.ts")?.[1] ?? "").toContain('kind: "harmless"');
    expect(FILES.find(([p]) => p === "src/core/plugin-host.ts")?.[1] ?? "").toContain('kind === "harmless" ? isTypingTarget(target) : isFormControl(target)');
  });
});

function hasWgslEntryPoint(text: string): boolean {
  return /@(vertex|fragment|compute)\b/.test(text);
}

describe("shaders stay in src/renderer/shaders/*.wgsl", () => {
  it("finds a WGSL entry point in a TypeScript string, marked or not", () => {
    expect(hasWgslEntryPoint("const SHADER = /* wgsl */ `\n@compute @workgroup_size(1)\nfn main() {}\n`;")).toBe(true);
    expect(hasWgslEntryPoint("const SRC = `\n@vertex\nfn vs_main() {}\n`;")).toBe(true);
    expect(hasWgslEntryPoint('const s = "@fragment fn fs_main() {}";')).toBe(true);
    expect(hasWgslEntryPoint("import skyWgsl from \"./shaders/sky.wgsl?raw\";")).toBe(false);
  });

  it("no TypeScript source outside tests has a WGSL entry point (@vertex, @fragment, @compute)", () => {
    const offenders = FILES.filter(([path, text]) => !isTest(path) && hasWgslEntryPoint(text)).map(([path]) => path);
    expect(offenders, "put the shader in src/renderer/shaders/<name>.wgsl and import it with ?raw").toEqual([]);
  });
});
