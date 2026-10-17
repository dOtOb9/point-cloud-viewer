import { describe, expect, it } from "vitest";
import { describeInsufficientSpaceDesktop } from "./prepare-outcome";

describe("describeInsufficientSpaceDesktop", () => {
  it("writes both sizes in GiB with one decimal", () => {
    const text = describeInsufficientSpaceDesktop(3 * 1024 ** 3, 1.5 * 1024 ** 3);
    expect(text).toContain("必要: 約3.0GiB");
    expect(text).toContain("空き: 約1.5GiB");
  });
});
