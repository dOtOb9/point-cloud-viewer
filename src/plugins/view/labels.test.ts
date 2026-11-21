import { describe, expect, it } from "vitest";
import { VIEW_PRESET_IDS } from "../../plugin-api";
import { shortcutKeyOfPreset, viewStatusText, VIEW_BUTTON_TITLE, VIEW_SHORTCUTS } from "./labels";

describe("view shortcuts (UX-4)", () => {
  it("F / 1 / 2 / 3 / 4 / 5 / 6 / 7 are fit, top, front, right, isometric, projection, back, left", () => {
    expect(VIEW_SHORTCUTS.map((s) => [s.key, s.msg])).toEqual([
      ["F", { type: "fitRequested" }],
      ["1", { type: "presetRequested", id: "top" }],
      ["2", { type: "presetRequested", id: "front" }],
      ["3", { type: "presetRequested", id: "right" }],
      ["4", { type: "presetRequested", id: "isometric" }],
      ["5", { type: "projectionToggled" }],
      ["6", { type: "presetRequested", id: "back" }],
      ["7", { type: "presetRequested", id: "left" }],
    ]);
  });

  it("every preset has a key and no key is used twice", () => {
    for (const id of VIEW_PRESET_IDS) expect(shortcutKeyOfPreset(id)).not.toBe("");
    const keys = VIEW_SHORTCUTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the ribbon tooltip names every key with what it does", () => {
    for (const s of VIEW_SHORTCUTS) expect(VIEW_BUTTON_TITLE).toContain(`${s.key}: ${s.label}`);
  });
});

describe("viewStatusText (UX-1)", () => {
  it("names the viewpoint and the projection", () => {
    expect(viewStatusText("front", "perspective", false)).toBe("視点: 正面（透視投影）");
    expect(viewStatusText("top", "orthographic", false)).toBe("視点: 上（平行投影）");
  });

  it("says 自由 when the camera is not at a fixed viewpoint", () => {
    expect(viewStatusText(null, "perspective", false)).toBe("視点: 自由（透視投影）");
  });

  it("is short on a narrow screen", () => {
    expect(viewStatusText("isometric", "orthographic", true)).toBe("等角・平行");
  });
});
