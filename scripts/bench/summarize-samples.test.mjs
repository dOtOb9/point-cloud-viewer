// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSamples, summarizeSamples } from "./summarize-samples.mjs";

describe("summarize-samples", () => {
  it("reads plain numbers and reports the peak above 1 GiB", () => {
    const rows = parseSamples("t,private_mib,procs,free_gb\n0.5,480,8,272.8\n1.0,1040,8,271.0\n1.5,974,8,270.9\n");
    expect(summarizeSamples(rows)).toEqual({ samples: 3, peakPrivateMib: 1040, minFreeGb: 270.9 });
  });

  it("rejects digit grouping instead of dropping the value (the PF-0 mistake)", () => {
    expect(() => parseSamples("t,private_mib,procs,free_gb\n5.2,1,319,8,271.6\n")).toThrow(/5 columns, expected 4/);
    expect(() => parseSamples('t,private_mib\n1.0,"1,040"\n')).toThrow(/columns/);
  });

  it("rejects a value that is not a plain number", () => {
    expect(() => parseSamples("t,private_mib\n1.0,1 040\n")).toThrow(/not a plain number/);
    expect(() => parseSamples("t,private_mib\n1.0,\n")).toThrow(/not a plain number/);
  });

  it("rejects an empty file and a file without a private_mib column", () => {
    expect(() => parseSamples("")).toThrow(/empty/);
    expect(() => summarizeSamples(parseSamples("t,free_gb\n1.0,200\n"))).toThrow(/private_mib/);
  });
});
