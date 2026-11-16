// TP-1: the fixed viewpoints (top, front, back, left, right, isometric) as yaw / pitch of the orbit camera.
// Pure functions: no WebGPU, no React. The steps of "press the button" are in src/app/view.ts.
//
// Directions are defined against the up axis, not against the world axes, so they work for Z-up data (LAS/COPC)
// and for Y-up data (PLY/PCD, ADR-0008):
//  - Z-up: north = +Y, east = +X (map convention; the "front" view looks from the south to the north).
//  - Y-up: north = -Z, east = +X (the usual 3D-graphics convention for a map laid on the XZ plane).
//  - any other up axis: north = the `right` vector of horizontalBasis(up); no convention exists, only consistency.
//
// How yaw / pitch map to the eye (orbit-camera.ts eye()): the eye is at target + distance * (cos(pitch) * h +
// sin(pitch) * up), where h = forward * cos(yaw) + right * sin(yaw) is a horizontal unit vector from
// horizontalBasis(up). So "the eye is on the south side" means h = -north, and the yaw that gives a wanted h is
// atan2(dot(h, right), dot(h, forward)).

import { horizontalBasis, type Vec3 } from "./up-axis";
import { MAX_PITCH } from "./orbit-camera";

export type ViewPresetId = "top" | "front" | "back" | "left" | "right" | "isometric";

/** Order of the buttons in the dialog. */
export const VIEW_PRESET_IDS: readonly ViewPresetId[] = ["top", "front", "back", "left", "right", "isometric"];

/** Names shown on the screen (UX-8: plain Japanese words used in survey software). */
export const VIEW_PRESET_LABELS: Record<ViewPresetId, string> = {
  top: "上",
  front: "正面",
  back: "背面",
  left: "左",
  right: "右",
  isometric: "等角",
};

/** Pitch of the isometric view: about 35 degrees above the horizon. */
export const ISOMETRIC_PITCH = (35 * Math.PI) / 180;
/** Yaw offset of the isometric view from the front view (the eye moves toward the east). */
const ISOMETRIC_YAW_OFFSET = Math.PI / 4;

/** Horizontal unit vector pointing north for the given up axis (see the top of this file). */
export function northOf(up: Vec3): [number, number, number] {
  const len = Math.hypot(up[0], up[1], up[2]) || 1;
  const u: [number, number, number] = [up[0] / len, up[1] / len, up[2] / len];
  if (u[2] > 0.999) return [0, 1, 0];
  if (u[1] > 0.999) return [0, 0, -1];
  return horizontalBasis(up).right;
}

function eastOf(up: Vec3, north: Vec3): [number, number, number] {
  // east = north x up (Z-up: Y x Z = X)
  return [
    north[1] * up[2] - north[2] * up[1],
    north[2] * up[0] - north[0] * up[2],
    north[0] * up[1] - north[1] * up[0],
  ];
}

function yawForHorizontal(up: Vec3, h: Vec3): number {
  const { right, forward } = horizontalBasis(up);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.atan2(dot(h, right), dot(h, forward));
}

/** Yaw of the front view (the eye is on the south side). */
function frontYaw(up: Vec3): number {
  const n = northOf(up);
  return yawForHorizontal(up, [-n[0], -n[1], -n[2]]);
}

/**
 * Yaw / pitch of a fixed viewpoint.
 * - top: pitch is the camera's upper limit (not exactly 90 degrees: the camera cannot look along its up axis).
 *   The yaw of the front view makes the north the top of the screen.
 * - front: the eye on the south side, looking north. back: the eye on the north side.
 * - left: the eye on the west side, looking east. right: the eye on the east side.
 * - isometric: the front view turned 45 degrees toward the east, pitch 35 degrees.
 */
export function viewPresetAngles(id: ViewPresetId, up: Vec3): { yaw: number; pitch: number } {
  const n = northOf(up);
  const e = eastOf(up, n);
  switch (id) {
    case "top":
      return { yaw: frontYaw(up), pitch: MAX_PITCH };
    case "front":
      return { yaw: frontYaw(up), pitch: 0 };
    case "back":
      return { yaw: yawForHorizontal(up, n), pitch: 0 };
    case "left":
      return { yaw: yawForHorizontal(up, [-e[0], -e[1], -e[2]]), pitch: 0 };
    case "right":
      return { yaw: yawForHorizontal(up, e), pitch: 0 };
    case "isometric":
      return { yaw: normalizeAngle(frontYaw(up) + signedEastTurn(up) * ISOMETRIC_YAW_OFFSET), pitch: ISOMETRIC_PITCH };
  }
}

/** +1 if increasing the yaw moves the eye from the south toward the east, else -1 (depends on the basis handedness). */
function signedEastTurn(up: Vec3): number {
  const n = northOf(up);
  const e = eastOf(up, n);
  const quarter = yawForHorizontal(up, e) - frontYaw(up);
  return Math.sin(quarter) >= 0 ? 1 : -1;
}

function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Angle tolerance (radians, about 1.1 degrees) for "the camera is at this fixed viewpoint". */
const MATCH_TOLERANCE = 0.02;

/**
 * Which fixed viewpoint the camera is at now, or null ("free"). Shown in the status bar (UX-1), so it follows the
 * real camera, not the last button pressed. The top view ignores the yaw (turning around the vertical axis is still
 * a view from above); the others need yaw and pitch to match.
 */
export function matchViewPreset(yaw: number, pitch: number, up: Vec3): ViewPresetId | null {
  if (Math.abs(pitch - MAX_PITCH) < MATCH_TOLERANCE) return "top";
  for (const id of VIEW_PRESET_IDS) {
    if (id === "top") continue;
    const angles = viewPresetAngles(id, up);
    const dYaw = Math.abs(normalizeAngle(yaw - angles.yaw));
    if (dYaw < MATCH_TOLERANCE && Math.abs(pitch - angles.pitch) < MATCH_TOLERANCE) return id;
  }
  return null;
}
