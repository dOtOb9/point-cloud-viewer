import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective } from "../renderer/mat4";
import { OrbitCamera } from "../renderer/orbit-camera";
import { horizontalBasis } from "../renderer/up-axis";
import { displayLengthToFile, heightRange, pixelToNdc, projectToNdc, sectionBox, sectionYaw } from "./tool-math";

describe("pixelToNdc", () => {
  it("maps the canvas corners and the centre (y is flipped)", () => {
    expect(pixelToNdc(0, 0, 200, 100)).toEqual([-1, 1]);
    expect(pixelToNdc(200, 100, 200, 100)).toEqual([1, -1]);
    expect(pixelToNdc(100, 50, 200, 100)).toEqual([0, 0]);
  });
});

describe("projectToNdc with real file coordinates", () => {
  // autzen-like coordinates (x about 6.4e5, y about 8.5e5): a camera looking at a target from the south-east.
  const target: [number, number, number] = [637905.5, 851209.9, 2733.9];
  const eye: [number, number, number] = [target[0] + 3000, target[1] - 4000, target[2] + 3000];
  const viewProj = multiply(perspective((60 * Math.PI) / 180, 2, 0.01, 1e7), lookAt(eye, target, [0, 0, 1]));

  it("the look-at target lands in the middle of the screen", () => {
    const ndc = projectToNdc(viewProj, target);
    expect(ndc).not.toBeNull();
    expect(ndc![0]).toBeCloseTo(0, 6);
    expect(ndc![1]).toBeCloseTo(0, 6);
  });

  it("a point to the right of the target (camera right) has a positive x", () => {
    // The camera looks along (-3000, +4000, -3000); right = forward x up, so for this camera it points to (+4, +3, 0)/5.
    const right: [number, number, number] = [target[0] + 40, target[1] + 30, target[2]];
    const ndc = projectToNdc(viewProj, right);
    expect(ndc![0]).toBeGreaterThan(0);
    expect(ndc![1]).toBeCloseTo(0, 3);
  });

  it("a point above the target has a positive y", () => {
    const ndc = projectToNdc(viewProj, [target[0], target[1], target[2] + 50]);
    expect(ndc![1]).toBeGreaterThan(0);
  });

  it("a point behind the camera is null", () => {
    expect(projectToNdc(viewProj, [eye[0] + 3000, eye[1] - 4000, eye[2] + 3000])).toBeNull();
  });
});

describe("displayLengthToFile", () => {
  it("converts from the display unit to the file unit", () => {
    expect(displayLengthToFile(1, 1, "meter")).toBe(1);
    expect(displayLengthToFile(1, 0.3048, "meter")).toBeCloseTo(3.2808399, 6); // 1 m in international feet
    expect(displayLengthToFile(10, 0.3048, "foot")).toBeCloseTo(10, 12); // 10 ft in a feet file
  });
  it("takes the number as it is when the file unit is unknown", () => {
    expect(displayLengthToFile(7, null, "foot")).toBe(7);
  });
});

describe("heightRange", () => {
  it("is the z range for the default up axis", () => {
    expect(heightRange([0, 0, 406], [10, 10, 615], [0, 0, 1])).toEqual({ min: 406, max: 615 });
  });
  it("uses the y range for a y-up cloud", () => {
    expect(heightRange([0, -5, 0], [10, 20, 10], [0, 1, 0])).toEqual({ min: -5, max: 20 });
  });
});

describe("sectionBox", () => {
  it("builds a vertical slab along the line", () => {
    const box = sectionBox([100, 200, 50], [100, 300, 80], [0, 0, 1], 2, 0, 100);
    expect(box).not.toBeNull();
    const f = box!.filter;
    expect(f.center).toEqual([100, 250, 50]);
    expect(f.halfExtents).toEqual([50, 1, 50]);
    expect(f.axes[0]).toEqual([0, 1, 0]); // along the line
    expect(f.axes[2]).toEqual([0, 0, 1]); // up
    // The normal is horizontal and perpendicular to the line: up x along = (0,0,1) x (0,1,0) = (-1,0,0)
    expect(f.axes[1][0]).toBeCloseTo(-1, 12);
    expect(f.axes[1][1]).toBeCloseTo(0, 12);
  });

  it("ignores the height difference of the two picks (the line is taken horizontally)", () => {
    const box = sectionBox([0, 0, 0], [30, 40, 999], [0, 0, 1], 1, 0, 10)!;
    expect(box.filter.halfExtents[0]).toBeCloseTo(25, 12);
  });

  it("returns null when both points are on the same vertical line", () => {
    expect(sectionBox([1, 2, 3], [1, 2, 99], [0, 0, 1], 1, 0, 10)).toBeNull();
  });

  it("a point on the line inside the thickness and height is inside the box, and one outside is not", () => {
    const f = sectionBox([0, 0, 0], [100, 0, 0], [0, 0, 1], 2, 0, 10)!.filter;
    const inside = (p: [number, number, number]) => {
      const d = [p[0] - f.center[0], p[1] - f.center[1], p[2] - f.center[2]];
      return f.axes.every((ax, i) => Math.abs(d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) <= f.halfExtents[i] + 1e-9);
    };
    expect(inside([50, 0.9, 5])).toBe(true);
    expect(inside([50, 1.1, 5])).toBe(false);
    expect(inside([50, 0, 11])).toBe(false);
    expect(inside([101, 0, 5])).toBe(false);
  });
});

describe("sectionYaw", () => {
  it("puts the orbit camera's eye on the normal side at pitch 0", () => {
    const up: [number, number, number] = [0, 0, 1];
    const { right, forward } = horizontalBasis(up);
    const normal: [number, number, number] = [-0.6, 0.8, 0];
    const camera = new OrbitCamera([0, 0, 0], 10);
    camera.yaw = sectionYaw(normal, right, forward);
    camera.pitch = 0;
    camera.distance = 10;
    camera.target = [0, 0, 0];
    const eye = camera.eye();
    expect(eye[0]).toBeCloseTo(-6, 9);
    expect(eye[1]).toBeCloseTo(8, 9);
    expect(eye[2]).toBeCloseTo(0, 9);
  });
});
