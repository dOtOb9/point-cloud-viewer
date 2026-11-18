import { describe, expect, it } from "vitest";
import { isFileOpenBusy, openButtonLabel, type ViewerStatus } from "./viewer-status";

const ALL: ViewerStatus[] = [
  { kind: "idle" },
  { kind: "opening" },
  { kind: "converting" },
  { kind: "ready" },
  { kind: "error", message: "boom" },
];

describe("isFileOpenBusy", () => {
  it("is true only while opening or converting", () => {
    expect(ALL.map((s) => [s.kind, isFileOpenBusy(s)])).toEqual([
      ["idle", false],
      ["opening", true],
      ["converting", true],
      ["ready", false],
      ["error", false],
    ]);
  });
});

describe("openButtonLabel", () => {
  it("says what is happening, otherwise 開く", () => {
    expect(ALL.map((s) => [s.kind, openButtonLabel(s)])).toEqual([
      ["idle", "開く"],
      ["opening", "開いています…"],
      ["converting", "変換中…"],
      ["ready", "開く"],
      ["error", "開く"],
    ]);
  });
});
