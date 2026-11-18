import { describe, expect, it } from "vitest";
import benchScript from "../../scripts/igpu-bench/bench.mjs?raw";
import rendererSource from "./point-cloud-renderer.ts?raw";

function rendererMethodsCalledByBench(script: string): string[] {
  const names = new Set<string>();
  for (const match of script.matchAll(/\b(?:r|__pcvRenderer)\.([a-zA-Z]\w*)\(/g)) names.add(match[1]);
  return [...names].sort();
}

describe("PointCloudRenderer methods that scripts/igpu-bench/bench.mjs calls by name", () => {
  it("finds the methods the bench calls", () => {
    expect(rendererMethodsCalledByBench(benchScript)).toContain("getPointBudget");
    expect(rendererMethodsCalledByBench(benchScript)).toContain("setRenderScale");
  });

  it("every one of them is still a method of PointCloudRenderer (a reference search cannot see these calls)", () => {
    const lines = rendererSource.split("\n").map((line) => line.trimStart());
    const missing = rendererMethodsCalledByBench(benchScript).filter((name) => !lines.some((line) => line.startsWith(`${name}(`)));
    expect(missing).toEqual([]);
  });
});
