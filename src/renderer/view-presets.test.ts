import { describe, expect, it } from "vitest";
import { OrbitCamera, MAX_PITCH } from "./orbit-camera";
import { ISOMETRIC_PITCH, matchViewPreset, northOf, viewPresetAngles, VIEW_PRESET_IDS, type ViewPresetId } from "./view-presets";
import type { Vec3 } from "./up-axis";

const Z_UP: Vec3 = [0, 0, 1];
const Y_UP: Vec3 = [0, 1, 0];

function eyeOffset(id: ViewPresetId, up: Vec3): [number, number, number] {
  const cam = new OrbitCamera([0, 0, 0], 100);
  cam.setUpAxis(up);
  const a = viewPresetAngles(id, up);
  cam.yaw = a.yaw;
  cam.pitch = a.pitch;
  const e = cam.eye();
  return [e[0] / 100, e[1] / 100, e[2] / 100];
}

function expectVec(actual: number[], expected: number[], digits = 6) {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

describe("viewPresetAngles (Z-up)", () => {
  it("front: the eye is on the south side (-Y), looking north, horizontal", () => {
    expectVec(eyeOffset("front", Z_UP), [0, -1, 0]);
  });
  it("back: the eye is on the north side", () => {
    expectVec(eyeOffset("back", Z_UP), [0, 1, 0]);
  });
  it("right: the eye is on the east side; left: on the west side", () => {
    expectVec(eyeOffset("right", Z_UP), [1, 0, 0]);
    expectVec(eyeOffset("left", Z_UP), [-1, 0, 0]);
  });
  it("top: the eye is straight above (within the camera's pitch limit)", () => {
    const o = eyeOffset("top", Z_UP);
    expect(o[2]).toBeGreaterThan(0.9999);
    expect(Math.hypot(o[0], o[1])).toBeLessThan(0.011);
    expect(viewPresetAngles("top", Z_UP).pitch).toBe(MAX_PITCH);
  });
  it("top: north is the top of the screen (the view's up vector projects to +Y)", () => {
    const o = eyeOffset("top", Z_UP);
    expect(o[1]).toBeLessThan(0);
  });
  it("isometric: yaw 45 degrees from the front (south-east), pitch about 35 degrees", () => {
    const a = viewPresetAngles("isometric", Z_UP);
    expect(a.pitch).toBeCloseTo(ISOMETRIC_PITCH, 9);
    expect(a.pitch).toBeGreaterThan(0.6);
    expect(a.pitch).toBeLessThan(0.62);
    const o = eyeOffset("isometric", Z_UP);
    expect(o[0]).toBeGreaterThan(0);
    expect(o[1]).toBeLessThan(0);
    expect(o[0]).toBeCloseTo(-o[1], 6);
    expect(o[2]).toBeCloseTo(Math.sin(ISOMETRIC_PITCH), 6);
  });
});

describe("viewPresetAngles (Y-up data)", () => {
  it("north is -Z; the front view looks from the south (+Z) toward -Z", () => {
    expectVec(northOf(Y_UP), [0, 0, -1]);
    expectVec(eyeOffset("front", Y_UP), [0, 0, 1]);
    expectVec(eyeOffset("back", Y_UP), [0, 0, -1]);
    expectVec(eyeOffset("right", Y_UP), [1, 0, 0]);
    expectVec(eyeOffset("left", Y_UP), [-1, 0, 0]);
  });
  it("top looks from above (+Y); isometric is up and toward south-east", () => {
    expect(eyeOffset("top", Y_UP)[1]).toBeGreaterThan(0.9999);
    const o = eyeOffset("isometric", Y_UP);
    expect(o[1]).toBeCloseTo(Math.sin(ISOMETRIC_PITCH), 6);
    expect(o[0]).toBeGreaterThan(0);
    expect(o[2]).toBeGreaterThan(0);
  });
});

describe("matchViewPreset", () => {
  it("recognizes each preset and returns null for a free view", () => {
    for (const up of [Z_UP, Y_UP]) {
      for (const id of VIEW_PRESET_IDS) {
        const a = viewPresetAngles(id, up);
        expect(matchViewPreset(a.yaw, a.pitch, up)).toBe(id);
      }
      expect(matchViewPreset(0.3, 0.3, up)).toBeNull();
    }
  });
  it("the top view is still the top view after turning around the vertical axis", () => {
    expect(matchViewPreset(1.234, MAX_PITCH, Z_UP)).toBe("top");
  });
  it("yaw wraps around (front at yaw + 2 pi)", () => {
    const a = viewPresetAngles("front", Z_UP);
    expect(matchViewPreset(a.yaw + 2 * Math.PI, a.pitch, Z_UP)).toBe("front");
  });
});
