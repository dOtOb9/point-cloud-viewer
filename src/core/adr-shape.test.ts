import { describe, expect, it } from "vitest";
import type { PluginHost } from "../plugin-api";
import { createPluginHost } from "./plugin-host";

const RAW = import.meta.glob(["../../TaskSheets/ADR-0022-tea-architecture.md", "../../TaskSheets/ADR-0023-plugins.md", "../app/tea.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ADR_0022 = RAW["../../TaskSheets/ADR-0022-tea-architecture.md"];
const ADR_0023 = RAW["../../TaskSheets/ADR-0023-plugins.md"];
const TEA_SOURCE = RAW["../app/tea.ts"];

function lastTsBlockMentioning(markdown: string, word: string): string {
  const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes(word));
  return blocks[blocks.length - 1] ?? "";
}

function codeLines(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/^export /, "").replace(/\s*[{;]$/, ""));
}

function hostGivenToPlugins(): PluginHost {
  let given: PluginHost | null = null;
  createPluginHost({ reportError: () => {} }).activate([{ id: "probe", name: "probe", apiVersion: 1, activate: (host) => void (given = host) }]);
  return given!;
}

describe("the API in the ADRs is the API in the code", () => {
  it("ADR-0023: the PL-0 parts of PluginHost are the ones the host gives", () => {
    const line = ADR_0023.split("\n").find((l) => l.includes("PL-0 の口は")) ?? "";
    const named = [...line.slice(0, line.indexOf("だけ")).matchAll(/`(\w+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(Object.keys(hostGivenToPlugins()).sort()).toEqual(named.sort());
  });

  it("ADR-0022: every line of the latest createProgram signature is in src/app/tea.ts", () => {
    const adrLines = codeLines(lastTsBlockMentioning(ADR_0022, "Failures"));
    expect(adrLines.length).toBeGreaterThan(0);
    const sourceLines = codeLines(TEA_SOURCE);
    for (const line of adrLines.filter((l) => l !== "}")) expect(sourceLines).toContain(line);
  });
});
