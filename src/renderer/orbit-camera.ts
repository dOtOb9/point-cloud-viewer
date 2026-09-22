// orbitカメラ。左ドラッグで回転、ホイールでズーム、中ドラッグでパン。
// このファイルはReactを知らない。渡されたcanvasに直接ポインタイベントを張る
// （M1-point-rendering.md 規約3: rendererはcanvasとDataSourceだけを受け取る）。

import { lookAt, type Mat4 } from "./mat4";

const MIN_DISTANCE = 0.01;
const MAX_DISTANCE = 1e9; // COPCの世界座標は大きいことがあるので、上限は緩くしておく
const MIN_PITCH = -Math.PI / 2 + 0.01;
const MAX_PITCH = Math.PI / 2 - 0.01;

export class OrbitCamera {
  /** 注視点。ワールド座標（f64のまま持つ。COPCの座標は大きいことがある）。 */
  target: [number, number, number];
  distance: number;
  /** 水平回転角（ラジアン）。 */
  yaw = 0;
  /** 仰角（ラジアン）。 */
  pitch = 0.3;

  constructor(target: [number, number, number], distance: number) {
    this.target = target;
    this.distance = distance;
  }

  /** カメラのワールド座標での位置。 */
  eye(): [number, number, number] {
    const cosP = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cosP * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cosP * Math.cos(this.yaw),
    ];
  }

  viewMatrix(): Mat4 {
    return lookAt(this.eye(), this.target, [0, 1, 0]);
  }

  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, MIN_PITCH, MAX_PITCH);
  }

  zoom(factor: number): void {
    this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  /** 画面右方向・上方向へのパン。単位は距離に比例させ、ズーム量に応じた見た目の速さにする。 */
  pan(dxScreen: number, dyScreen: number): void {
    const eye = this.eye();
    const forward = normalize(sub(this.target, eye));
    const worldUp: [number, number, number] = [0, 1, 0];
    const right = normalize(cross(forward, worldUp));
    const up = normalize(cross(right, forward));

    // 距離に比例させることで、寄っているときは小さく、引いているときは大きく動く
    // （マウスの見た目の移動量とパン量が一致するようにするための簡易な近似）。
    const speed = this.distance * 0.0015;
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

/**
 * canvasにポインタ/ホイールイベントを張り、OrbitCameraを操作できるようにする。
 * 返り値のdispose()でイベントを外せる。
 */
export function attachOrbitControls(canvas: HTMLCanvasElement, camera: OrbitCamera): () => void {
  let dragButton: number | null = null;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    dragButton = e.button;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (dragButton === null) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (dragButton === 0) {
      // 左ドラッグ: 回転
      camera.rotate(-dx * ROTATE_SPEED, dy * ROTATE_SPEED);
    } else if (dragButton === 1) {
      // 中ドラッグ: パン
      camera.pan(dx, dy);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    dragButton = null;
    canvas.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    camera.zoom(factor);
  };

  const onContextMenu = (e: MouseEvent) => {
    // 中ボタンドラッグ中に右クリックメニューが出ると操作しづらいので抑える。
    e.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}
