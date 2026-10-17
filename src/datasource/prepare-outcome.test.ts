import { describe, expect, it } from "vitest";
import { describeInsufficientSpaceDesktop, toPrepareOutcome } from "./prepare-outcome";

describe("describeInsufficientSpaceDesktop", () => {
  it("writes both sizes in GiB with one decimal", () => {
    const text = describeInsufficientSpaceDesktop(3 * 1024 ** 3, 1.5 * 1024 ** 3);
    expect(text).toContain("必要: 約3.0GiB");
    expect(text).toContain("空き: 約1.5GiB");
  });
});

describe("toPrepareOutcome", () => {
  it("alreadyCopc and cached are ready", () => {
    expect(toPrepareOutcome({ kind: "alreadyCopc", path: "a.copc.laz" }, false)).toEqual({ kind: "ready", path: "a.copc.laz" });
    expect(toPrepareOutcome({ kind: "cached", outputPath: "out.copc.laz" }, true)).toEqual({ kind: "ready", path: "out.copc.laz" });
  });
  it("converting stays converting", () => {
    expect(toPrepareOutcome({ kind: "converting" }, false)).toEqual({ kind: "converting" });
  });
  it("desktop insufficient space: short summary, long text in details", () => {
    const outcome = toPrepareOutcome({ kind: "insufficientSpace", requiredBytes: 3 * 1024 ** 3, availableBytes: 1024 ** 3 }, false);
    expect(outcome).toEqual({
      kind: "failed",
      summary: "空き容量が足りません",
      details: describeInsufficientSpaceDesktop(3 * 1024 ** 3, 1024 ** 3),
    });
  });
  it("Web insufficient space: short summary, long text in details", () => {
    const outcome = toPrepareOutcome(
      { kind: "insufficientSpaceWeb", requiredBytes: 20, quotaBytes: 10, usageBytes: 5, persisted: false, reclaimableBytes: 1 },
      false,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.summary).toBe("空き容量が足りません");
      expect(outcome.details).not.toBe(outcome.summary);
    }
  });
  it("OPFS unavailable: the single and multi texts differ and are used for both fields", () => {
    const single = toPrepareOutcome({ kind: "opfsUnavailable" }, false);
    const multi = toPrepareOutcome({ kind: "opfsUnavailable" }, true);
    if (single.kind !== "failed" || multi.kind !== "failed") throw new Error("expected failed");
    expect(single.summary).toBe(single.details);
    expect(single.details).toContain("デスクトップ版でCOPC(.copc.laz)に変換");
    expect(multi.details).toContain("デスクトップ版でまとめてCOPC(.copc.laz)に変換");
  });
});
