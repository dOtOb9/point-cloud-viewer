import { describe, expect, it } from "vitest";
import { basenameOfPath, extensionOfFileName } from "./open-file-text";

describe("basenameOfPath", () => {
  it("handles both separators", () => {
    expect(basenameOfPath("C:\\data\\a.copc.laz")).toBe("a.copc.laz");
    expect(basenameOfPath("/tmp/x/b.las")).toBe("b.las");
  });
  it("returns a bare name unchanged", () => {
    expect(basenameOfPath("c.laz")).toBe("c.laz");
  });
});

describe("extensionOfFileName", () => {
  it("lower-cases the last extension", () => {
    expect(extensionOfFileName("A.LAZ")).toBe("laz");
    expect(extensionOfFileName("a.copc.laz")).toBe("laz");
  });
  it("reports unknown when there is no dot", () => {
    expect(extensionOfFileName("README")).toBe("(不明)");
  });
});
