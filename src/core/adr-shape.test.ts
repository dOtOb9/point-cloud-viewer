import { describe, expect, it } from "vitest";
import type { PluginHost } from "../plugin-api";
import { createPluginHost } from "./plugin-host";

const RAW = import.meta.glob(["../../TaskSheets/ADR-0022-tea-architecture.md", "../../TaskSheets/ADR-0023-plugins.md", "../app/tea.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function withLfLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

const ADR_0022 = withLfLineEndings(RAW["../../TaskSheets/ADR-0022-tea-architecture.md"]);
const ADR_0023 = withLfLineEndings(RAW["../../TaskSheets/ADR-0023-plugins.md"]);
const TEA_SOURCE = withLfLineEndings(RAW["../app/tea.ts"]);

const PLUGIN_HOST_PARTS_MARK = "口の一覧:";

function lastTsBlockMentioning(markdown: string, word: string): string {
  const blocks = [...withLfLineEndings(markdown).matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes(word));
  return blocks[blocks.length - 1] ?? "";
}

function codeLines(block: string): string[] {
  return withLfLineEndings(block)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/^export /, "").replace(/\s*[{;]$/, ""));
}

function interfaceMembers(lines: string[], name: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(`interface ${name}`));
  if (start < 0) return [];
  const end = lines.indexOf("}", start);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function lastPluginHostPartsInAdr(markdown: string): string[] {
  const lines = withLfLineEndings(markdown)
    .split("\n")
    .filter((line) => line.includes(PLUGIN_HOST_PARTS_MARK));
  const last = lines[lines.length - 1] ?? "";
  const listed = last.slice(last.indexOf(PLUGIN_HOST_PARTS_MARK) + PLUGIN_HOST_PARTS_MARK.length).split(/[（(]/)[0];
  return [...listed.matchAll(/`(\w+)`/g)].map((m) => m[1]);
}

function hostGivenToPlugins(): PluginHost {
  let given: PluginHost | null = null;
  createPluginHost({ reportError: () => {} }).activate([{ id: "probe", name: "probe", apiVersion: 1, activate: (host) => void (given = host) }]);
  return given!;
}

describe("the API in the ADRs is the API in the code", () => {
  it('ADR-0023: the parts in the last "口の一覧:" line are the parts the host gives to plugins', () => {
    const named = lastPluginHostPartsInAdr(ADR_0023);
    expect(named.length).toBeGreaterThan(0);
    expect(Object.keys(hostGivenToPlugins()).sort()).toEqual(named.sort());
  });

  it('ADR-0023: a later revision with its own "口の一覧:" line replaces the earlier list', () => {
    const later = ADR_0023 + "\n## 改訂（PL-1）\n\n- 口の一覧: `ribbon`・`layers`（説明の `view` は数えない）\n";
    expect(lastPluginHostPartsInAdr(later)).toEqual(["ribbon", "layers"]);
  });

  it("ADR-0023: reads the parts the same way from a CRLF checkout", () => {
    expect(lastPluginHostPartsInAdr(ADR_0023.replace(/\n/g, "\r\n"))).toEqual(lastPluginHostPartsInAdr(ADR_0023));
  });

  it("ADR-0022: every line of the latest createProgram signature is in src/app/tea.ts", () => {
    const adrLines = codeLines(lastTsBlockMentioning(ADR_0022, "Failures"));
    expect(adrLines.length).toBeGreaterThan(0);
    const sourceLines = codeLines(TEA_SOURCE);
    for (const line of adrLines.filter((l) => l !== "}")) expect(sourceLines).toContain(line);
  });

  it("ADR-0022: interface Failures has the same members in the ADR and in src/app/tea.ts, both ways", () => {
    const inAdr = interfaceMembers(codeLines(lastTsBlockMentioning(ADR_0022, "Failures")), "Failures");
    expect(inAdr.length).toBeGreaterThan(0);
    expect(interfaceMembers(codeLines(TEA_SOURCE), "Failures")).toEqual(inAdr);
  });
});

describe("audit PL-0-RP R1: the ADR check does not depend on line endings", () => {
  it("reads the createProgram signature from ADR-0022 checked out with CRLF (core.autocrlf=true on Windows)", () => {
    const crlf = ADR_0022.replace(/\r?\n/g, "\r\n");
    expect(codeLines(lastTsBlockMentioning(crlf, "Failures"))).toEqual(codeLines(lastTsBlockMentioning(ADR_0022, "Failures")));
  });
});
