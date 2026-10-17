import { describe, expect, it } from "vitest";
import { isFileOpenBusy, isOpenRunningOrDone, openButtonLabel, statusErrorMessage, type ViewerStatus } from "./viewer-status";

// One row per kind. A new kind must be added here too (the helpers would not compile without it).
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

describe("statusErrorMessage", () => {
  it("returns the message only for the error kind", () => {
    expect(ALL.map((s) => [s.kind, statusErrorMessage(s)])).toEqual([
      ["idle", null],
      ["opening", null],
      ["converting", null],
      ["ready", null],
      ["error", "boom"],
    ]);
  });
});

describe("isOpenRunningOrDone", () => {
  it("is false for idle (nothing or cancelled) and error", () => {
    expect(ALL.map((s) => [s.kind, isOpenRunningOrDone(s)])).toEqual([
      ["idle", false],
      ["opening", true],
      ["converting", true],
      ["ready", true],
      ["error", false],
    ]);
  });
});
