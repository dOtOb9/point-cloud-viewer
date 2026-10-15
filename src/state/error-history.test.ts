import { describe, expect, it } from "vitest";
import type { GpuErrorEntry } from "../renderer/gpu-error-log";
import { mergeErrorHistory } from "./error-history";

const entry = (id: number, firstAt: number, count = 1): GpuErrorEntry => ({
  id,
  message: `m${id}`,
  source: "gpu",
  count,
  firstAt,
  lastAt: firstAt,
});

describe("mergeErrorHistory", () => {
  it("keeps entries that are no longer in the current list", () => {
    const merged = mergeErrorHistory([entry(1, 10), entry(2, 20)], [entry(2, 20)]);
    expect(merged.map((e) => e.id)).toEqual([1, 2]);
  });
  it("updates an entry with the same id (count grows)", () => {
    const merged = mergeErrorHistory([entry(1, 10, 1)], [entry(1, 10, 4)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].count).toBe(4);
  });
  it("sorts oldest first", () => {
    const merged = mergeErrorHistory([entry(2, 20)], [entry(1, 10)]);
    expect(merged.map((e) => e.id)).toEqual([1, 2]);
  });
});
