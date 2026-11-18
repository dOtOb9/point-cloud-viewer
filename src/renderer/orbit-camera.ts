import { lookAt, type Mat4 } from "./mat4";
import { DEFAULT_UP_AXIS, horizontalBasis, type Vec3 } from "./up-axis";
import { computeTwoPointerGesture, type TouchPoint } from "./touch-gesture";
import {
  INERTIA_STOP_PAN_PX_PER_SEC,
  INERTIA_STOP_ROTATE_RAD_PER_SEC,
  DOUBLE_TAP_MAX_DISTANCE_PX,
  DOUBLE_TAP_MAX_INTERVAL_MS,
  INERTIA_TAU_MS,
  TRANSITION_DURATION_MS,
  ZOOM_SMOOTH_STOP_LOG,
  ZOOM_SMOOTH_TAU_MS,
  VelocityTracker,
  easeInOut,
  expApproachFraction,
  shortestAngleDelta,
} from "./animation";

export const DEFAULT_PITCH = 0.3;

interface Transition {
  elapsedMs: number;
  durationMs: number;
  fromTarget: [number, number, number];
  toTarget: [number, number, number];
  fromDistance: number;
  toDistance: number;
  fromYaw: number;
  yawDelta: number;
  fromPitch: number;
  toPitch: number;
}

export interface CameraGoal {
  target: readonly [number, number, number];
  distance: number;
  yaw?: number;
  pitch?: number;
}

const MIN_DISTANCE = 0.01;
const MAX_DISTANCE = 1e9;
export const MIN_PITCH = -Math.PI / 2 + 0.01;
export const MAX_PITCH = Math.PI / 2 - 0.01;
const MIN_PAN_DISTANCE_RATIO = 0.0005;

export class OrbitCamera {
  target: [number, number, number];
  distance: number;
  yaw = 0;
  pitch = DEFAULT_PITCH;

  private minPanDistance = 0;

  private upAxis: Vec3 = DEFAULT_UP_AXIS;

  motionEnabled = true;

  private inertiaYawRate = 0;
  private inertiaPitchRate = 0;
  private pendingZoomLog = 0;
  private pendingZoomDirection: readonly [number, number, number] | undefined;
  private transition: Transition | null = null;
  private inertiaPanX = 0;
  private inertiaPanY = 0;

  constructor(target: [number, number, number], distance: number) {
    this.target = target;
    this.distance = distance;
  }

  setUpAxis(up: Vec3): void {
    this.upAxis = up;
  }

  getUpAxis(): Vec3 {
    return this.upAxis;
  }

  setSceneScale(diagonal: number): void {
    this.minPanDistance = diagonal * MIN_PAN_DISTANCE_RATIO;
  }

  eye(): [number, number, number] {
    const { right, forward } = horizontalBasis(this.upAxis);
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const h: [number, number, number] = [
      forward[0] * cosY + right[0] * sinY,
      forward[1] * cosY + right[1] * sinY,
      forward[2] * cosY + right[2] * sinY,
    ];
    return [
      this.target[0] + this.distance * (cosP * h[0] + sinP * this.upAxis[0]),
      this.target[1] + this.distance * (cosP * h[1] + sinP * this.upAxis[1]),
      this.target[2] + this.distance * (cosP * h[2] + sinP * this.upAxis[2]),
    ];
  }

  viewMatrix(): Mat4 {
    return lookAt(this.eye(), this.target, this.upAxis);
  }

  startRotateInertia(yawRate: number, pitchRate: number): void {
    this.cancelInertia();
    if (!this.motionEnabled) return;
    if (Math.hypot(yawRate, pitchRate) < INERTIA_STOP_ROTATE_RAD_PER_SEC) return;
    this.inertiaYawRate = yawRate;
    this.inertiaPitchRate = pitchRate;
  }

  startPanInertia(vxPxPerSec: number, vyPxPerSec: number): void {
    this.cancelInertia();
    if (!this.motionEnabled) return;
    if (Math.hypot(vxPxPerSec, vyPxPerSec) < INERTIA_STOP_PAN_PX_PER_SEC) return;
    this.inertiaPanX = vxPxPerSec;
    this.inertiaPanY = vyPxPerSec;
  }

  animateTo(goal: CameraGoal, durationMs: number = TRANSITION_DURATION_MS): void {
    this.cancelMotion();
    const toYaw = goal.yaw ?? this.yaw;
    const toPitch = clamp(goal.pitch ?? this.pitch, MIN_PITCH, MAX_PITCH);
    const toDistance = clamp(goal.distance, MIN_DISTANCE, MAX_DISTANCE);
    if (!this.motionEnabled || !(durationMs > 0)) {
      this.target = [goal.target[0], goal.target[1], goal.target[2]];
      this.distance = toDistance;
      this.yaw = toYaw;
      this.pitch = toPitch;
      return;
    }
    this.transition = {
      elapsedMs: 0,
      durationMs,
      fromTarget: [this.target[0], this.target[1], this.target[2]],
      toTarget: [goal.target[0], goal.target[1], goal.target[2]],
      fromDistance: this.distance,
      toDistance,
      fromYaw: this.yaw,
      yawDelta: shortestAngleDelta(this.yaw, toYaw),
      fromPitch: this.pitch,
      toPitch,
    };
  }

  cancelTransition(): void {
    this.transition = null;
  }

  private updateTransition(dtMs: number): void {
    const tr = this.transition;
    if (!tr) return;
    tr.elapsedMs += dtMs;
    const t = tr.elapsedMs / tr.durationMs;
    if (t >= 1) {
      this.target = tr.toTarget;
      this.distance = tr.toDistance;
      this.yaw = tr.fromYaw + tr.yawDelta;
      this.pitch = tr.toPitch;
      this.transition = null;
      return;
    }
    const s = easeInOut(t);
    this.target = [
      tr.fromTarget[0] + (tr.toTarget[0] - tr.fromTarget[0]) * s,
      tr.fromTarget[1] + (tr.toTarget[1] - tr.fromTarget[1]) * s,
      tr.fromTarget[2] + (tr.toTarget[2] - tr.fromTarget[2]) * s,
    ];
    this.distance = Math.exp(Math.log(tr.fromDistance) + (Math.log(tr.toDistance) - Math.log(tr.fromDistance)) * s);
    this.yaw = tr.fromYaw + tr.yawDelta * s;
    this.pitch = tr.fromPitch + (tr.toPitch - tr.fromPitch) * s;
  }

  cancelMotion(): void {
    this.transition = null;
    this.cancelInertia();
    this.pendingZoomLog = 0;
    this.pendingZoomDirection = undefined;
  }

  zoomSmooth(factor: number, cursorDirection?: readonly [number, number, number]): void {
    if (!this.motionEnabled) {
      this.zoom(factor, cursorDirection);
      return;
    }
    this.pendingZoomLog += Math.log(factor);
    this.pendingZoomDirection = cursorDirection;
  }

  cancelInertia(): void {
    this.inertiaYawRate = 0;
    this.inertiaPitchRate = 0;
    this.inertiaPanX = 0;
    this.inertiaPanY = 0;
  }

  private hasInertia(): boolean {
    return this.inertiaYawRate !== 0 || this.inertiaPitchRate !== 0 || this.inertiaPanX !== 0 || this.inertiaPanY !== 0;
  }

  update(dtMs: number): void {
    if (!(dtMs > 0)) return;
    if (this.transition) {
      this.updateTransition(dtMs);
      return;
    }
    if (this.hasInertia()) this.updateInertia(dtMs);
    if (this.pendingZoomLog !== 0) this.updateSmoothZoom(dtMs);
  }

  private updateSmoothZoom(dtMs: number): void {
    let apply = this.pendingZoomLog * expApproachFraction(dtMs, ZOOM_SMOOTH_TAU_MS);
    if (Math.abs(this.pendingZoomLog - apply) < ZOOM_SMOOTH_STOP_LOG) apply = this.pendingZoomLog;
    this.pendingZoomLog -= apply;
    if (apply === 0) this.pendingZoomLog = 0;
    this.zoom(Math.exp(apply), this.pendingZoomDirection);
    if (this.pendingZoomLog === 0) this.pendingZoomDirection = undefined;
  }

  isAnimating(): boolean {
    return this.transition !== null || this.hasInertia() || this.pendingZoomLog !== 0;
  }

  private updateInertia(dtMs: number): void {
    const tauSec = INERTIA_TAU_MS / 1000;
    const move = tauSec * expApproachFraction(dtMs, INERTIA_TAU_MS);
    const keep = Math.exp(-dtMs / INERTIA_TAU_MS);

    if (this.inertiaYawRate !== 0 || this.inertiaPitchRate !== 0) {
      this.rotate(this.inertiaYawRate * move, this.inertiaPitchRate * move);
      if (this.pitch === MIN_PITCH || this.pitch === MAX_PITCH) this.inertiaPitchRate = 0;
      this.inertiaYawRate *= keep;
      this.inertiaPitchRate *= keep;
      if (Math.hypot(this.inertiaYawRate, this.inertiaPitchRate) < INERTIA_STOP_ROTATE_RAD_PER_SEC) {
        this.inertiaYawRate = 0;
        this.inertiaPitchRate = 0;
      }
    }
    if (this.inertiaPanX !== 0 || this.inertiaPanY !== 0) {
      this.pan(this.inertiaPanX * move, this.inertiaPanY * move);
      this.inertiaPanX *= keep;
      this.inertiaPanY *= keep;
      if (Math.hypot(this.inertiaPanX, this.inertiaPanY) < INERTIA_STOP_PAN_PX_PER_SEC) {
        this.inertiaPanX = 0;
        this.inertiaPanY = 0;
      }
    }
  }

  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, MIN_PITCH, MAX_PITCH);
  }

  zoom(factor: number, cursorDirection?: readonly [number, number, number]): void {
    const step = this.distance * (1 - factor);
    if (cursorDirection) {
      this.target = [
        this.target[0] + cursorDirection[0] * step,
        this.target[1] + cursorDirection[1] * step,
        this.target[2] + cursorDirection[2] * step,
      ];
    }
    this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  pan(dxScreen: number, dyScreen: number): void {
    const eye = this.eye();
    const forward = normalize(sub(this.target, eye));
    const right = normalize(cross(forward, this.upAxis));
    const up = normalize(cross(right, forward));

    const speed = Math.max(this.distance, this.minPanDistance) * 0.0015;
    const move: [number, number, number] = [
      -right[0] * dxScreen * speed + up[0] * dyScreen * speed,
      -right[1] * dxScreen * speed + up[1] * dyScreen * speed,
      -right[2] * dxScreen * speed + up[2] * dyScreen * speed,
    ];
    this.target = [this.target[0] + move[0], this.target[1] + move[1], this.target[2] + move[2]];
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function sub(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

const ROTATE_SPEED = 0.005;
const ZOOM_STEP = 1.1;

export interface OrbitControlsOptions {
  getCursorDirection?: (screenX: number, screenY: number) => [number, number, number] | null;
  onFlyTo?: (screenX: number, screenY: number) => void;
}

interface TrackedPointer extends TouchPoint {
  button: number;
}

export function attachOrbitControls(
  canvas: HTMLCanvasElement,
  camera: OrbitCamera,
  options: OrbitControlsOptions = {},
): () => void {
  canvas.style.touchAction = "none";

  const pointers = new Map<number, TrackedPointer>();
  const velocity = new VelocityTracker();
  let tapDown: { t: number; x: number; y: number } | null = null;
  let lastTap: { t: number; x: number; y: number } | null = null;
  let lastTouchFlyAt = -Infinity;

  const onPointerDown = (e: PointerEvent) => {
    camera.cancelInertia();
    camera.cancelTransition();
    tapDown = pointers.size === 0 && e.pointerType === "touch" ? { t: e.timeStamp, x: e.clientX, y: e.clientY } : null;
    velocity.reset();
    if (pointers.size === 0) velocity.add(e.timeStamp, e.clientX, e.clientY);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const prevPoint = pointers.get(e.pointerId);
    if (!prevPoint) return;

    if (pointers.size === 1) {
      const dx = e.clientX - prevPoint.x;
      const dy = e.clientY - prevPoint.y;
      if (prevPoint.button === 0) {
        camera.rotate(-dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        velocity.add(e.timeStamp, e.clientX, e.clientY);
      } else if (prevPoint.button === 1) {
        camera.pan(dx, dy);
        velocity.add(e.timeStamp, e.clientX, e.clientY);
      }
    } else if (pointers.size === 2) {
      const otherId = [...pointers.keys()].find((id) => id !== e.pointerId);
      const other = otherId !== undefined ? pointers.get(otherId) : undefined;
      if (other) {
        const prevPair: [TouchPoint, TouchPoint] = [prevPoint, other];
        const currPair: [TouchPoint, TouchPoint] = [{ x: e.clientX, y: e.clientY }, other];
        const gesture = computeTwoPointerGesture(prevPair, currPair);

        camera.pan(gesture.panDeltaX, gesture.panDeltaY);

        const rect = canvas.getBoundingClientRect();
        const cursorDirection =
          options.getCursorDirection?.(gesture.midpoint.x - rect.left, gesture.midpoint.y - rect.top) ??
          undefined;
        camera.zoom(gesture.zoomFactor, cursorDirection);
      }
    }

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: prevPoint.button });
  };

  const onPointerUp = (e: PointerEvent) => {
    const released = pointers.get(e.pointerId);
    const wasOnlyPointer = pointers.size === 1 && released !== undefined;
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture(e.pointerId);

    if (wasOnlyPointer && e.type === "pointerup") {
      const [vx, vy] = velocity.velocity(e.timeStamp);
      if (released.button === 0) {
        camera.startRotateInertia(-vx * ROTATE_SPEED, vy * ROTATE_SPEED);
      } else if (released.button === 1) {
        camera.startPanInertia(vx, vy);
      }
    }
    velocity.reset();

    if (wasOnlyPointer && e.type === "pointerup" && e.pointerType === "touch" && tapDown) {
      const moved = Math.hypot(e.clientX - tapDown.x, e.clientY - tapDown.y);
      if (moved < 10 && e.timeStamp - tapDown.t < DOUBLE_TAP_MAX_INTERVAL_MS) {
        const prev = lastTap;
        if (
          prev &&
          e.timeStamp - prev.t < DOUBLE_TAP_MAX_INTERVAL_MS &&
          Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_MAX_DISTANCE_PX
        ) {
          lastTap = null;
          lastTouchFlyAt = e.timeStamp;
          const rect = canvas.getBoundingClientRect();
          options.onFlyTo?.(e.clientX - rect.left, e.clientY - rect.top);
        } else {
          lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
        }
      } else {
        lastTap = null;
      }
    }
    tapDown = null;
  };

  const onDoubleClick = (e: MouseEvent) => {
    if (e.timeStamp - lastTouchFlyAt < 600) return;
    const rect = canvas.getBoundingClientRect();
    options.onFlyTo?.(e.clientX - rect.left, e.clientY - rect.top);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;

    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const cursorDirection = options.getCursorDirection?.(screenX, screenY) ?? undefined;

    camera.cancelTransition();
    camera.zoomSmooth(factor, cursorDirection);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("dblclick", onDoubleClick);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}
