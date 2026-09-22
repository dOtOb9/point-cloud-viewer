// orbitカメラ。左ドラッグで回転、ホイールでズーム、中ドラッグでパン。
// このファイルはReactを知らない。渡されたcanvasに直接ポインタイベントを張る
// （M1-point-rendering.md 規約3: rendererはcanvasとDataSourceだけを受け取る）。

import { lookAt, type Mat4 } from "./mat4";

const MIN_DISTANCE = 0.01;
const MAX_DISTANCE = 1e9; // COPCの世界座標は大きいことがあるので、上限は緩くしておく
const MIN_PITCH = -Math.PI / 2 + 0.01;
const MAX_PITCH = Math.PI / 2 - 0.01;
/** パン速度下限（`minPanDistance`）を、シーンBBOXの対角線の何割にするか。 */
const MIN_PAN_DISTANCE_RATIO = 0.0005;

export class OrbitCamera {
  /** 注視点。ワールド座標（f64のまま持つ。COPCの座標は大きいことがある）。 */
  target: [number, number, number];
  distance: number;
  /** 水平回転角（ラジアン）。 */
  yaw = 0;
  /** 仰角（ラジアン）。 */
  pitch = 0.3;

  /**
   * パン速度の下限を決めるための基準距離（シーン全体のスケール由来）。
   * M1-5: パン速度は`distance`に比例させているため、ズームで寄って`distance`が
   * 小さくなると、そのままではパンがほとんど動かなくなってしまう。シーン全体の
   * 大きさに応じた下限を設けることで、寄った状態でも実用的な速度を保つ。
   * `setSceneScale()`で設定する。未設定（0）なら従来どおり`distance`をそのまま使う。
   */
  private minPanDistance = 0;

  constructor(target: [number, number, number], distance: number) {
    this.target = target;
    this.distance = distance;
  }

  /**
   * 点群全体のBBOX対角線の長さなど、シーンのスケールを教える。
   * パン速度の下限（`minPanDistance`）をこれに比例させる。
   */
  setSceneScale(diagonal: number): void {
    this.minPanDistance = diagonal * MIN_PAN_DISTANCE_RATIO;
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

  /**
   * ズーム。`towardPoint`を渡すと、targetをその点へ向けて寄せながら距離を縮める
   * （カーソル位置に向かってズームする。M1-5。Potree/CloudCompare/Blenderと同じ挙動）。
   *
   * `towardPoint`を省略した場合（カーソルの下にhierarchyのノードが無い＝空を指している
   * 場合のフォールバック）は、従来どおり現在のtargetへ向かって寄るだけになる。
   *
   * targetをtowardPointへ寄せる割合は、distanceを縮める割合（`1 - factor`）と揃えている。
   * こうすると、towardPointがちょうどtargetと一致するとき（＝画面中心にカーソルがある
   * とき）は移動量0になり、旧来の「targetに向かって寄る」動きにそのまま一致する。
   * また、寄るたびにtargetが実際の対象へ近づいていくので、`distance`が0に漸近するのと
   * 連動してtargetとの距離も縮まり続け、「近づいているのに対象に到達しない」という
   * 旧実装の不具合（targetが固定だったため）が起きない。
   */
  zoom(factor: number, towardPoint?: readonly [number, number, number]): void {
    if (towardPoint) {
      const shrink = 1 - factor;
      this.target = [
        this.target[0] + (towardPoint[0] - this.target[0]) * shrink,
        this.target[1] + (towardPoint[1] - this.target[1]) * shrink,
        this.target[2] + (towardPoint[2] - this.target[2]) * shrink,
      ];
    }
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
    // ただし寄りすぎて`distance`がシーン全体からすると無視できるくらい小さくなると、
    // このままではパンがほぼ止まって見えるので、シーン規模由来の下限で床を張る（M1-5）。
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
  /**
   * ホイールでズームする直前に呼ばれる。カーソルの下（キャンバス上のピクセル座標、
   * 左上原点）にあるワールド座標の点を返すと、`OrbitCamera.zoom()`がその点へ向かって
   * 寄る（M1-5）。判定できない場合（hierarchyがまだ無い、カーソルが空を指している等）は
   * nullを返せば、従来どおり現在のtargetへ向かって寄るだけになる。
   *
   * 正確なピッキングである必要はない。octreeのノードAABBへの粗いレイキャストで十分
   * （M1-point-rendering.md M1-5）。
   */
  pickPointUnderCursor?: (screenX: number, screenY: number) => [number, number, number] | null;
}

/**
 * canvasにポインタ/ホイールイベントを張り、OrbitCameraを操作できるようにする。
 * 返り値のdispose()でイベントを外せる。
 */
export function attachOrbitControls(
  canvas: HTMLCanvasElement,
  camera: OrbitCamera,
  options: OrbitControlsOptions = {},
): () => void {
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

    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const towardPoint = options.pickPointUnderCursor?.(screenX, screenY) ?? undefined;

    camera.zoom(factor, towardPoint);
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
