// TP-1: projection.ts, the orthographic matrix, and the consumers that must keep working with it
// (picking math, EDL values, node selection, frustum culling, rays, screen projection).

import { describe, expect, it } from "vitest";
import {
  buildProjection,
  eyeDistanceFromDepth,
  fitDistance,
  FOV_Y_RADIANS,
  orthoDepthRange,
  orthoHalfHeight,
  orthoReferenceDistance,
  refinedProjection,
} from "./projection";
import { invert, lookAt, multiply, perspective, transformPoint } from "./mat4";
import { aabbIntersectsFrustum, frustumPlanes } from "./frustum";
import { ndcPointToWorldRay, screenPointToWorldRay } from "./raycast";
import { OrbitCamera } from "./orbit-camera";
import { cameraBasis } from "./mat4";
import { orthoCursorZoomDirection } from "./projection";
import { projectedBoundsDiagonalPixels, screenSpaceError, surfaceSpacingPixels } from "./screen-space-error";
import { projectPoint, projectSegment } from "./screen-project";
import { unprojectWindowSample, windowViewProj } from "./pick-math";

const W = 1600;
const H = 900;
const ASPECT = W / H;

/** A camera looking down at the target from above-south; Z is up. */
function viewFor(target: [number, number, number], distance: number): number[] {
  const eye: [number, number, number] = [target[0], target[1] - distance * 0.6, target[2] + distance * 0.8];
  return lookAt(eye, target, [0, 0, 1]);
}

describe("orthographicMatrix / buildProjection", () => {
  it("maps the depth range to 0..1 and keeps w = 1", () => {
    const p = buildProjection("orthographic", ASPECT, 100, 50);
    expect(p.near).toBeLessThan(0);
    for (const [d, expected] of [
      [p.near, 0],
      [100, (100 - p.near) / (p.far - p.near)],
      [p.far, 1],
    ] as const) {
      const c = transformPoint(p.matrix, [0, 0, -d]);
      expect(c[3]).toBeCloseTo(1, 12);
      expect(c[2]).toBeCloseTo(expected, 12);
    }
  });

  it("the visible half height equals what a perspective camera sees at the target plane (AC-4: same size on switch)", () => {
    const distance = 250;
    const persp = buildProjection("perspective", ASPECT, distance, 100);
    const ortho = buildProjection("orthographic", ASPECT, distance, 100);
    // A point on the target plane, one half-height above the view center.
    const half = orthoHalfHeight(distance);
    const pointOnTargetPlane: [number, number, number] = [0, half, -distance];
    const cp = transformPoint(persp.matrix, pointOnTargetPlane);
    const co = transformPoint(ortho.matrix, pointOnTargetPlane);
    expect(cp[1] / cp[3]).toBeCloseTo(1, 9);
    expect(co[1] / co[3]).toBeCloseTo(1, 9);
    // Horizontal too (same aspect handling).
    const cpx = transformPoint(persp.matrix, [half * ASPECT, 0, -distance]);
    const cox = transformPoint(ortho.matrix, [half * ASPECT, 0, -distance]);
    expect(cpx[0] / cpx[3]).toBeCloseTo(1, 9);
    expect(cox[0] / cox[3]).toBeCloseTo(1, 9);
    expect(half).toBeCloseTo(distance * Math.tan(FOV_Y_RADIANS / 2), 12);
  });

  it("the depth range is symmetric around the target and grows with the scene", () => {
    const r = orthoDepthRange(100, 500);
    expect(r.near + r.far).toBeCloseTo(200, 9); // centered on distance 100
    expect(r.far - r.near).toBeCloseTo(4 * 500, 9);
    expect(orthoDepthRange(1000, 10).far - orthoDepthRange(1000, 10).near).toBeCloseTo(4000, 9);
  });

  it("perspective keeps the old matrix (NEAR 0.01, FAR 1e7)", () => {
    const p = buildProjection("perspective", ASPECT, 100, 100);
    expect(p.matrix).toEqual(perspective(FOV_Y_RADIANS, ASPECT, 0.01, 1e7));
    expect(p.halfHeight).toBe(0);
    expect(orthoReferenceDistance(p)).toBe(0);
  });

  it("orthoReferenceDistance returns the orbit distance", () => {
    expect(orthoReferenceDistance(buildProjection("orthographic", ASPECT, 321, 10))).toBeCloseTo(321, 9);
  });
});

describe("eyeDistanceFromDepth (per projection)", () => {
  it("orthographic: the depth of a point returns its eye distance, also behind the eye plane (near < 0)", () => {
    const p = buildProjection("orthographic", ASPECT, 100, 400);
    for (const z of [-300, -1, 0, 50, 100, 700]) {
      const c = transformPoint(p.matrix, [3, 4, -z]);
      expect(eyeDistanceFromDepth(p, c[2] / c[3])).toBeCloseTo(z, 6);
    }
  });

  it("perspective: unchanged", () => {
    const p = buildProjection("perspective", ASPECT, 100, 400);
    for (const z of [0.5, 10, 3000]) {
      const c = transformPoint(p.matrix, [0, 0, -z]);
      expect(eyeDistanceFromDepth(p, c[2] / c[3])).toBeCloseTo(z, 6);
    }
  });
});

describe("refinedProjection (picking stage 2)", () => {
  it("orthographic: narrows the range around z, keeps the size, and the point stays inside", () => {
    const p = buildProjection("orthographic", ASPECT, 100, 400);
    const z = 120;
    const r = refinedProjection(p, ASPECT, z);
    expect(r.mode).toBe("orthographic");
    expect(r.far - r.near).toBeLessThan((p.far - p.near) / 10);
    expect(r.near).toBeLessThan(z);
    expect(r.far).toBeGreaterThan(z);
    expect(r.halfHeight).toBe(p.halfHeight);
    const c = transformPoint(r.matrix, [0, 0, -z]);
    expect(c[2]).toBeGreaterThan(0);
    expect(c[2]).toBeLessThan(1);
  });

  it("orthographic: the picked world point is recovered precisely through windowViewProj", () => {
    const target: [number, number, number] = [-40000, -10000, 40];
    const distance = 300;
    const view = viewFor(target, distance);
    const p = buildProjection("orthographic", ASPECT, distance, 600);
    const point: [number, number, number] = [-40000 + 12.3, -10000 + 4.5, 41.7];
    const cWorld = transformPoint(multiply(p.matrix, view), point);
    const zEye = -transformPoint(view, point)[2];
    const r = refinedProjection(p, ASPECT, zEye + 3); // a rough distance a little off
    const vp = multiply(r.matrix, view);
    const c = transformPoint(vp, point);
    const ndcX = c[0] / c[3];
    const ndcY = c[1] / c[3];
    const px = Math.floor(((ndcX + 1) / 2) * W);
    const py = Math.floor(((1 - ndcY) / 2) * H);
    const size = 5;
    const win = windowViewProj(vp, px, py, size, W, H);
    // The pixel containing the point is the window center (index 2,2). Its depth is the point's depth.
    const depth = c[2] / c[3];
    const back = unprojectWindowSample(win, 2, 2, size, depth);
    expect(back).not.toBeNull();
    // Unprojection returns the point on the pixel center's ray at that depth: within one pixel of the point.
    const pixelWorld = (2 * p.halfHeight) / H;
    expect(Math.hypot(back![0] - point[0], back![1] - point[1], back![2] - point[2])).toBeLessThan(pixelWorld * 1.5);
    expect(cWorld[3]).toBeCloseTo(1, 12);
  });
});

describe("fitDistance", () => {
  it("wide screen with the 60 degree FOV: perspective gives the diagonal, orthographic 0.866 * diagonal", () => {
    expect(fitDistance("perspective", 100, ASPECT)).toBeCloseTo(100, 6);
    // ortho: radius / tan(30 deg) = 50 / 0.577 = 86.6; the visible half height at that distance is 50
    const d = fitDistance("orthographic", 100, ASPECT);
    expect(orthoHalfHeight(d)).toBeCloseTo(50, 9);
  });

  it("a tall screen needs a larger distance (the horizontal direction limits the fit)", () => {
    expect(fitDistance("perspective", 100, 0.5)).toBeGreaterThan(fitDistance("perspective", 100, ASPECT));
    expect(fitDistance("orthographic", 100, 0.5)).toBeCloseTo(2 * fitDistance("orthographic", 100, 1), 9);
  });

  it("the whole bounding sphere is inside the view at the fit distance", () => {
    for (const mode of ["perspective", "orthographic"] as const) {
      const diagonal = 80;
      const distance = fitDistance(mode, diagonal, ASPECT);
      const proj = buildProjection(mode, ASPECT, distance, diagonal);
      const view = viewFor([0, 0, 0], distance);
      const vp = multiply(proj.matrix, view);
      // Points on the sphere of radius diagonal / 2 around the target.
      for (const [x, y, z] of [[40, 0, 0], [-40, 0, 0], [0, 0, 40], [0, 0, -40], [0, 40, 0], [0, -40, 0]]) {
        const c = transformPoint(vp, [x, y, z]);
        expect(Math.abs(c[0] / c[3])).toBeLessThanOrEqual(1.0001);
        expect(Math.abs(c[1] / c[3])).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});

describe("orthographic with the consumers that read the view-projection matrix", () => {
  const target: [number, number, number] = [637000, 851000, 120];
  const distance = 400;
  const view = viewFor(target, distance);
  const proj = buildProjection("orthographic", ASPECT, distance, 800);
  const vp = multiply(proj.matrix, view);

  it("the ray of a pixel has the view direction for every pixel (parallel rays) and hits the target at the center", () => {
    const center = screenPointToWorldRay(vp, W / 2, H / 2, W, H)!;
    const corner = screenPointToWorldRay(vp, 10, 10, W, H)!;
    for (let i = 0; i < 3; i++) expect(corner.direction[i]).toBeCloseTo(center.direction[i], 9);
    // The center ray passes through the target.
    const t = (target[0] - center.origin[0]) * center.direction[0] +
      (target[1] - center.origin[1]) * center.direction[1] +
      (target[2] - center.origin[2]) * center.direction[2];
    const closest = [0, 1, 2].map((i) => center.origin[i] + center.direction[i] * t);
    expect(Math.hypot(closest[0] - target[0], closest[1] - target[1], closest[2] - target[2])).toBeLessThan(1e-3);
    // The origin is on the near plane, which is behind the target by the depth range (R), so outside nearby boxes.
    const back = Math.hypot(center.origin[0] - target[0], center.origin[1] - target[1], center.origin[2] - target[2]);
    expect(back).toBeGreaterThan(1000);
  });

  it("ndcPointToWorldRay works with the orthographic matrix", () => {
    expect(ndcPointToWorldRay(vp, 0.3, -0.2)).not.toBeNull();
    expect(invert(vp)).not.toBeNull();
  });

  it("screen size of a box does not depend on its depth (LOD selection: same pixels per world unit everywhere)", () => {
    const box = (offset: number): [number[], number[]] => [
      [target[0] - 5, target[1] - 5 + offset, target[2] - 5],
      [target[0] + 5, target[1] + 5 + offset, target[2] + 5],
    ];
    const nearBox = box(0);
    const farViewDir = [0, 0.6, -0.8]; // away from the eye, along the view direction
    const shifted: [number[], number[]] = [
      nearBox[0].map((v, i) => v + farViewDir[i] * 200),
      nearBox[1].map((v, i) => v + farViewDir[i] * 200),
    ];
    const a = projectedBoundsDiagonalPixels(vp, nearBox[0] as [number, number, number], nearBox[1] as [number, number, number], W, H);
    const b = projectedBoundsDiagonalPixels(vp, shifted[0] as [number, number, number], shifted[1] as [number, number, number], W, H);
    expect(a).toBeGreaterThan(1);
    expect(b).toBeCloseTo(a, 6);
  });

  it("the pixel size matches the half height: a 10 m wide box on the target plane is 10 * H / (2 * halfHeight) px wide", () => {
    // A box wide in the screen-horizontal direction only would need the basis; use the pixels-per-world-unit instead.
    const min: [number, number, number] = [target[0] - 5, target[1] - 5, target[2] - 5];
    const max: [number, number, number] = [target[0] + 5, target[1] + 5, target[2] + 5];
    const px = projectedBoundsDiagonalPixels(vp, min, max, W, H);
    const pxPerUnit = H / (2 * proj.halfHeight);
    // The screen diagonal of a box is between 10*sqrt(2) and 10*sqrt(3) world units times the scale.
    expect(px).toBeGreaterThan(10 * pxPerUnit);
    expect(px).toBeLessThan(10 * Math.sqrt(3) * pxPerUnit * 1.01);
  });

  it("screenSpaceError and surfaceSpacingPixels are finite and positive (no division by w)", () => {
    const min: [number, number, number] = [target[0] - 20, target[1] - 20, target[2] - 20];
    const max: [number, number, number] = [target[0] + 20, target[1] + 20, target[2] + 20];
    expect(screenSpaceError(vp, min, max, 1000, W, H)).toBeGreaterThan(0);
    expect(surfaceSpacingPixels(vp, min, max, 1000, W, H)).toBeGreaterThan(0);
  });

  it("a deeper level (half the spacing) halves the error, like in perspective", () => {
    const min: [number, number, number] = [target[0] - 20, target[1] - 20, target[2] - 20];
    const max: [number, number, number] = [target[0] + 20, target[1] + 20, target[2] + 20];
    const coarse = screenSpaceError(vp, min, max, 1000, W, H);
    const fine = screenSpaceError(vp, min, max, 8000, W, H); // 8x points = half the spacing
    expect(fine).toBeCloseTo(coarse / 2, 6);
  });

  it("frustum culling: a box near the target is kept, a box far to the side is dropped, a box behind the eye plane is kept", () => {
    const planes = frustumPlanes(vp);
    expect(aabbIntersectsFrustum(planes, [target[0] - 1, target[1] - 1, target[2] - 1], [target[0] + 1, target[1] + 1, target[2] + 1])).toBe(true);
    const side = 5 * proj.halfHeight * ASPECT;
    expect(aabbIntersectsFrustum(planes, [target[0] + side, target[1], target[2]], [target[0] + side + 1, target[1] + 1, target[2] + 1])).toBe(false);
    // Behind the eye plane (view-space z > 0) but inside the orthographic depth range: still visible.
    const eye = [target[0], target[1] - distance * 0.6, target[2] + distance * 0.8];
    const behind = [eye[0], eye[1] - 0.6 * 50, eye[2] + 0.8 * 50]; // 50 behind the eye along -forward
    expect(aabbIntersectsFrustum(planes, [behind[0] - 1, behind[1] - 1, behind[2] - 1], [behind[0] + 1, behind[1] + 1, behind[2] + 1])).toBe(true);
  });

  it("measurement overlay projection: the target is at the screen center; points behind the eye plane still project", () => {
    const c = projectPoint(vp, target, W, H)!;
    expect(c.x).toBeCloseTo(W / 2, 6);
    expect(c.y).toBeCloseTo(H / 2, 6);
    const eye = [target[0], target[1] - distance * 0.6, target[2] + distance * 0.8];
    const behind: [number, number, number] = [eye[0], eye[1] - 30, eye[2] + 40];
    expect(projectPoint(vp, behind, W, H)).not.toBeNull();
    expect(projectSegment(vp, target, behind, W, H)).not.toBeNull();
  });
});

describe("orthographic zoom toward the cursor (OrbitCamera.zoom with orthoCursorZoomDirection)", () => {
  /** Screen position (NDC) of a world point for the camera as it is now. */
  function ndcOf(cam: OrbitCamera, point: [number, number, number], sceneDiagonal: number) {
    const proj = buildProjection("orthographic", ASPECT, cam.distance, sceneDiagonal);
    const c = transformPoint(multiply(proj.matrix, cam.viewMatrix()), point);
    return [c[0] / c[3], c[1] / c[3]];
  }

  /** The world point on the target plane under a cursor at (ndcX, ndcY). */
  function pointUnderCursor(cam: OrbitCamera, ndcX: number, ndcY: number): [number, number, number] {
    const { right, up } = cameraBasis(cam.eye(), cam.target, cam.getUpAxis());
    const half = orthoHalfHeight(cam.distance);
    return [0, 1, 2].map((i) => cam.target[i] + right[i] * ndcX * ASPECT * half + up[i] * ndcY * half) as [number, number, number];
  }

  it("the world point under the cursor stays under the cursor, for zoom in and out and several cursor positions", () => {
    for (const [ndcX, ndcY] of [[0.6, 0.3], [-0.8, -0.5], [0, 0.9]]) {
      for (const factor of [1 / 1.1, 1.1, 0.5, 3]) {
        const cam = new OrbitCamera([637000, 851000, 120], 300);
        cam.yaw = 0.7;
        cam.pitch = 0.5;
        const p = pointUnderCursor(cam, ndcX, ndcY);
        const { right, up } = cameraBasis(cam.eye(), cam.target, cam.getUpAxis());
        const dir = orthoCursorZoomDirection(right, up, ndcX, ndcY, ASPECT, orthoHalfHeight(cam.distance), cam.distance);
        cam.zoom(factor, dir);
        const [x, y] = ndcOf(cam, p, 500);
        expect(x).toBeCloseTo(ndcX, 6);
        expect(y).toBeCloseTo(ndcY, 6);
      }
    }
  });

  it("the cursor vector has no part along the view direction (the target does not slide along the view)", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.pitch = 0.4;
    const { forward, right, up } = cameraBasis(cam.eye(), cam.target, cam.getUpAxis());
    const dir = orthoCursorZoomDirection(right, up, 0.5, -0.5, ASPECT, orthoHalfHeight(100), 100);
    expect(dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2]).toBeCloseTo(0, 12);
  });

  it("the cursor at the screen center gives the zero vector (plain zoom about the target)", () => {
    const dir = orthoCursorZoomDirection([1, 0, 0], [0, 0, 1], 0, 0, ASPECT, 50, 100);
    expect(dir).toEqual([0, 0, 0]);
  });

  it("the data stays inside the depth range after zooming far out, turning around and zooming far in (F-3)", () => {
    const diag = 1000;
    const center: [number, number, number] = [0, 0, 0];
    const cam = new OrbitCamera([0, 0, 0], diag);
    // Zoom out 20x about a cursor, turn 180 degrees, zoom in to 0.05 x the diagonal about the same cursor.
    const zoomAbout = (factor: number) => {
      const { right, up } = cameraBasis(cam.eye(), cam.target, cam.getUpAxis());
      cam.zoom(factor, orthoCursorZoomDirection(right, up, 0.7, 0.2, ASPECT, orthoHalfHeight(cam.distance), cam.distance));
    };
    for (let i = 0; i < 30; i++) zoomAbout(1.1);
    cam.yaw += Math.PI;
    for (let i = 0; i < 70; i++) zoomAbout(1 / 1.1);
    const target = cam.target;
    const offset = Math.hypot(target[0] - center[0], target[1] - center[1], target[2] - center[2]);
    const proj = buildProjection("orthographic", ASPECT, cam.distance, diag, offset);
    // Every corner of the scene box has an eye distance inside [near, far].
    const view = cam.viewMatrix();
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const corner: [number, number, number] = [sx * diag / 2, sy * diag / 2, sz * diag / 2];
      const z = -transformPoint(view, corner)[2];
      expect(z).toBeGreaterThan(proj.near);
      expect(z).toBeLessThan(proj.far);
    }
  });

  it("orthoDepthRange grows with the distance of the target from the scene center", () => {
    const a = orthoDepthRange(100, 500, 0);
    const b = orthoDepthRange(100, 500, 800);
    expect(b.far - b.near).toBeCloseTo(a.far - a.near + 4 * 800, 9);
  });
});
