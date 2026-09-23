// orbitカメラ。左ドラッグで回転、ホイールでズーム、中ドラッグでパン。
// このファイルはReactを知らない。渡されたcanvasに直接ポインタイベントを張る
// （M1-point-rendering.md 規約3: rendererはcanvasとDataSourceだけを受け取る）。

import { lookAt, type Mat4 } from "./mat4";
import { DEFAULT_UP_AXIS, horizontalBasis, type Vec3 } from "./up-axis";
import { computeTwoPointerGesture, type TouchPoint } from "./touch-gesture";

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
  /**
   * 仰角（ラジアン）。既定値0.3（≈17°）は「少し見下ろしつつ地平線も見える」角度を
   * 意図している。M2-0b: `upAxis`が正しくZである今、この値はその意図通りに働く
   * （upAxisが誤ってYだった間は、この同じ値が「ほぼ真上からの俯瞰」になっていた。
   * 上方向のバグが直った結果としてこの角度が正しく機能するようになったので、
   * 値そのものは変えていない。`up-axis.ts`のDEFAULT_UP_AXISのコメント参照）。
   */
  pitch = 0.3;

  /**
   * パン速度の下限を決めるための基準距離（シーン全体のスケール由来）。
   * M1-5: パン速度は`distance`に比例させているため、ズームで寄って`distance`が
   * 小さくなると、そのままではパンがほとんど動かなくなってしまう。シーン全体の
   * 大きさに応じた下限を設けることで、寄った状態でも実用的な速度を保つ。
   * `setSceneScale()`で設定する。未設定（0）なら従来どおり`distance`をそのまま使う。
   */
  private minPanDistance = 0;

  /**
   * 点群の「上方向」（M2-0b）。既定値は`up-axis.ts`に集約してある。
   * カメラの姿勢(eye/viewMatrix)とパン(pan)はどちらもこの値だけを参照する。
   * `[0, 1, 0]`や`[0, 0, 1]`をここ以外に書かないこと。
   */
  private upAxis: Vec3 = DEFAULT_UP_AXIS;

  constructor(target: [number, number, number], distance: number) {
    this.target = target;
    this.distance = distance;
  }

  /**
   * 上方向を変える（M2-0b）。定数ではなく設定可能にしてあるのは、PLY/PCDのように
   * 座標系を持たないデータ（ADR-0008）ではZ-upとは限らないため。
   */
  setUpAxis(up: Vec3): void {
    this.upAxis = up;
  }

  getUpAxis(): Vec3 {
    return this.upAxis;
  }

  /**
   * 点群全体のBBOX対角線の長さなど、シーンのスケールを教える。
   * パン速度の下限（`minPanDistance`）をこれに比例させる。
   */
  setSceneScale(diagonal: number): void {
    this.minPanDistance = diagonal * MIN_PAN_DISTANCE_RATIO;
  }

  /**
   * カメラのワールド座標での位置。
   *
   * `upAxis`に直交する水平基底(`right`, `forward`)上でyawを回し(`h`)、
   * `cos(pitch)`で水平成分、`sin(pitch)`で`upAxis`成分を混ぜる。
   * `upAxis = [0, 1, 0]`のとき、この式は旧来の
   * `[cosP*sin(yaw), sinP, cosP*cos(yaw)]`と代数的に一致する
   * （`up-axis.ts`の`horizontalBasis`のコメント参照。テストでも確認済み）。
   */
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

  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, MIN_PITCH, MAX_PITCH);
  }

  /**
   * ズーム。`cursorDirection`（カーソル位置を通るワールド空間のレイの方向。正規化済み。
   * `screenPointToWorldRay()`が返す`Ray.direction`をそのまま渡せる）を渡すと、
   * targetをその方向へ動かしながら距離を縮める（カーソル位置に向かってズームする。
   * M1-5。Potree/CloudCompare/Blenderと同じ挙動）。
   *
   * `cursorDirection`を省略した場合（viewProjがまだ無い等でレイが作れないときの
   * フォールバック）は、従来どおり現在のtargetを動かさずdistanceだけ縮める。
   *
   * ## M1-5: なぜ「点」ではなく「方向」を使うのか（重要）
   *
   * 過去2回、ここは「カーソルの下にある点（`towardPoint`）」を受け取り、
   * `target += (towardPoint - target) * (1 - factor)` という式で target を
   * その点へ寄せる方式だった。この点は octree ノードの AABB とカーソルのレイの
   * 交差判定（レイキャスト）で求めていた。
   *
   * この方式は**実装のバグではなく、方式そのものが構造的に成立しない**。
   * 1ティックでの移動量は `(1 - factor) * D`（D = targetから towardPoint までの
   * 距離）になる。ところが towardPoint は「点群の点があるところ」ではなく
   * **AABB の面（箱の境界）**でしかない。カメラが箱の面に近づくほど D は
   * 0 に近づき、移動量も一緒に 0 に近づく。つまり毎ティック「残り距離の
   * 何%」ずつ進むだけで、**箱の面という何もない境界に漸近して止まる。**
   * 点群の点そのものへ到達することは方式上ありえない。
   * （実装は指示どおり正しく動いていた。指示していた方式そのものが誤りだった。）
   *
   * 今の実装はカーソル方向のベクトルだけを使い、AABB・ピッキング・深度バッファの
   * どれにも依存しない。1ティックの移動量 `step = distance * (1 - factor)` は
   * `distance`（自分がまさに縮めている量）に比例しており、target が実際に
   * どこにあるか・カーソルの下に何があるかとは無関係に決まる。`distance`は
   * 自分自身の縮小と一緒に動くので、「独立した何か」に漸近して止まることが
   * 構造的に起こりえない。止まるとしたら`MIN_DISTANCE`に当たったときだけ。
   *
   * 次に「カーソル位置にズームしたい」と思ったとき、AABB の面や深度バッファの
   * 値など「点」を求めてそこへ寄せる方式を選ばないこと。それは代理として
   * 間違っている（箱の内部は空洞、面は点群の点ではない）。方向だけを使えば
   * 間違いうる代理が一つも無い。
   */
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

  /** 画面右方向・上方向へのパン。単位は距離に比例させ、ズーム量に応じた見た目の速さにする。 */
  pan(dxScreen: number, dyScreen: number): void {
    const eye = this.eye();
    const forward = normalize(sub(this.target, eye));
    const right = normalize(cross(forward, this.upAxis));
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
   * ホイールでズームする直前に呼ばれる。カーソル位置（キャンバス上のピクセル座標、
   * 左上原点）を通るワールド空間のレイの方向（正規化済み）を返すと、
   * `OrbitCamera.zoom()`がその方向へtargetを動かしながら寄る（M1-5）。
   * 求まらない場合（viewProjがまだ無い等）はnullを返せば、従来どおりtargetを
   * 動かさずdistanceだけ縮めるフォールバックになる。
   *
   * AABBへのレイキャストやピッキングは不要（`orbit-camera.ts`の`zoom()`のコメント
   * 参照）。`screenPointToWorldRay()`（raycast.ts）が返す`Ray.direction`をそのまま
   * 返せばよい。
   */
  getCursorDirection?: (screenX: number, screenY: number) => [number, number, number] | null;
}

/** 追跡中の1ポインタの状態。マウスもタッチも同じ形で扱う。 */
interface TrackedPointer extends TouchPoint {
  /**
   * pointerdown時のe.button。タッチは常に0になる（Pointer Events仕様）ため、
   * 「左ドラッグ=0」の分岐は指1本のタッチでもそのまま回転として働く。
   * 中ドラッグ(button===1)はマウス専用（タッチでは発生しない値）。
   */
  button: number;
}

/**
 * canvasにポインタ/ホイールイベントを張り、OrbitCameraを操作できるようにする。
 * 返り値のdispose()でイベントを外せる。
 *
 * M3-6: マウスとタッチを同じコードで扱うため、`pointerType`では分岐せず、
 * **同時に押されているポインタの数**で操作を決める（タスクシート M3-6参照）。
 * - 1本（指1本 or マウス左ボタン）: 回転
 * - 1本（マウス中ボタン）: パン（button===1はタッチでは発生しないので、
 *   この分岐に指が迷い込むことはない）
 * - 2本（ピンチ/2本指ドラッグ）: ズーム（中点が先）とパンを同時に行う
 *   （現実の2本指操作は「広げながらずらす」ことが普通にあるため。
 *   ズーム倍率とパン量の計算そのものは`touch-gesture.ts`の純粋関数に切り出してある）
 * - 3本以上: 何もしない（スコープ外）
 */
export function attachOrbitControls(
  canvas: HTMLCanvasElement,
  camera: OrbitCamera,
  options: OrbitControlsOptions = {},
): () => void {
  // ブラウザ標準のタッチジェスチャ（ページのスクロール・ピンチズーム）が
  // 自前のジェスチャ処理と競合しないようにする。マウスには影響しない。
  canvas.style.touchAction = "none";

  const pointers = new Map<number, TrackedPointer>();

  const onPointerDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const prevPoint = pointers.get(e.pointerId);
    if (!prevPoint) return; // pointerdownより前(ホバー等)のmoveは無視

    if (pointers.size === 1) {
      const dx = e.clientX - prevPoint.x;
      const dy = e.clientY - prevPoint.y;
      if (prevPoint.button === 0) {
        // 左ドラッグ or 指1本: 回転
        camera.rotate(-dx * ROTATE_SPEED, dy * ROTATE_SPEED);
      } else if (prevPoint.button === 1) {
        // 中ドラッグ: パン
        camera.pan(dx, dy);
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
    // 3本以上は無視する（このポインタの位置だけは更新し、指が離れて2本に戻ったときに
    // 破綻しないようにする）。

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: prevPoint.button });
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;

    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const cursorDirection = options.getCursorDirection?.(screenX, screenY) ?? undefined;

    camera.zoom(factor, cursorDirection);
  };

  const onContextMenu = (e: MouseEvent) => {
    // 中ボタンドラッグ中に右クリックメニューが出ると操作しづらいので抑える。
    e.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  // pointercancel（OSのジェスチャ認識に取られる等）でもポインタを確実に外す。
  // 外し忘れると、次にその指番号が再利用されたときに古い位置が残って
  // 「遷移で操作が破綻する」原因になる。
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}
