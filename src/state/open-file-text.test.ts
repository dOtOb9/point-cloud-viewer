import { describe, expect, it } from "vitest";
import { basenameOfPath, describeInsufficientSpaceDesktop, extensionOfFileName } from "./open-file-text";

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

describe("describeInsufficientSpaceDesktop", () => {
  it("writes both sizes in GiB with one decimal", () => {
    const text = describeInsufficientSpaceDesktop(3 * 1024 ** 3, 1.5 * 1024 ** 3);
    expect(text).toContain("必要: 約3.0GiB");
    expect(text).toContain("空き: 約1.5GiB");
  });
});
