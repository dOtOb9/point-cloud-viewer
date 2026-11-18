import { horizontalBasis, type Vec3 } from "./up-axis";
import { MAX_PITCH } from "./orbit-camera";

export type ViewPresetId = "top" | "front" | "back" | "left" | "right" | "isometric";

export const VIEW_PRESET_IDS: readonly ViewPresetId[] = ["top", "front", "back", "left", "right", "isometric"];

export const VIEW_PRESET_LABELS: Record<ViewPresetId, string> = {
  top: "上",
  front: "正面",
  back: "背面",
  left: "左",
  right: "右",
  isometric: "等角",
};

export const ISOMETRIC_PITCH = (35 * Math.PI) / 180;
const ISOMETRIC_YAW_OFFSET = Math.PI / 4;
const UP_IS_AN_AXIS = 0.999;

export function northOf(up: Vec3): [number, number, number] {
  const len = Math.hypot(up[0], up[1], up[2]) || 1;
  const u: [number, number, number] = [up[0] / len, up[1] / len, up[2] / len];
  if (u[2] > UP_IS_AN_AXIS) return [0, 1, 0];
  if (u[1] > UP_IS_AN_AXIS) return [0, 0, -1];
  return horizontalBasis(up).right;
}

function eastOf(up: Vec3, north: Vec3): [number, number, number] {
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

function frontYaw(up: Vec3): number {
  const n = northOf(up);
  return yawForHorizontal(up, [-n[0], -n[1], -n[2]]);
}

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

const MATCH_TOLERANCE = 0.02;

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
