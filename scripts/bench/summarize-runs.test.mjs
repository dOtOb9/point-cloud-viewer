// @vitest-environment node
import { describe, expect, it } from "vitest";
import { summarizeRuns } from "./summarize-runs.mjs";

describe("summarize-runs", () => {
  it("gives min and max over all runs of a scenario (PF-0: 32 ms was one scenario's value, not the range)", () => {
    const runs = [
      { name: "autzen-copc-1", json: { first_node_read_ms: 51.6, outcome: "settled" } },
      { name: "autzen-copc-2", json: { first_node_read_ms: 40.4, outcome: "settled" } },
      { name: "autzen-copc-3", json: { first_node_read_ms: 45.8, outcome: "settled" } },
      { name: "shibuya10-web", json: { first_node_read_ms: 31.8, outcome: "settled" } },
    ];
    const s = summarizeRuns(runs);
    expect(s["autzen-copc"].first_node_read_ms).toEqual([40.4, 51.6, 3]);
    expect(s["shibuya10-web"].first_node_read_ms).toEqual([31.8, 31.8, 1]);
  });

  it("reports outcomes so a failed run is not averaged away", () => {
    const s = summarizeRuns([{ name: "x-1", json: { outcome: "viewer-error: no space" } }, { name: "x-2", json: { outcome: "settled" } }]);
    expect(s.x.outcomes).toEqual(["viewer-error: no space", "settled"]);
  });
});
