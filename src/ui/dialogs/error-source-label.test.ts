import { describe, expect, it } from "vitest";
import { ERROR_SOURCE_LABEL } from "./error-source-label";

describe("ERROR_SOURCE_LABEL", () => {
  it("heads a failure of the browser storage as storage, not as a conversion error", () => {
    expect(ERROR_SOURCE_LABEL.storage).toBe("保存領域のエラー");
    expect(ERROR_SOURCE_LABEL.storage).not.toBe(ERROR_SOURCE_LABEL.conversion);
  });

  it("gives every source its own heading", () => {
    const labels = Object.values(ERROR_SOURCE_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
