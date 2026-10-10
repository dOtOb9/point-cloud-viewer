// orbitカメラ。左ドラッグで回転、ホイールでズーム、中ドラッグでパン。
// このファイルはReactを知らない。渡されたcanvasに直接ポインタイベントを張る
// （M1-point-rendering.md 規約3: rendererはcanvasとDataSourceだけを受け取る）。

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

/** 初期の仰角。視点のリセット(全体表示)がここへ戻す。 */
export const DEFAULT_PITCH = 0.3;

/** 進行中の視点移動。from→toをeaseInOutで補間する。 */
interface Transition {
  elapsedMs: number;
  durationMs: number;
  fromTarget: [number, number, number];
  toTarget: [number, number, number];
  fromDistance: number;
  toDistance: number;
  fromYaw: number;
  /** 回す量（最短経路）。toYaw = fromYaw + yawDelta。 */
  yawDelta: number;
  fromPitch: number;
  toPitch: number;
}

/** 視点移動の行き先。yaw/pitchを省くと、今の向きのまま移動する。 */
export interface CameraGoal {
  target: readonly [number, number, number];
  distance: number;
  yaw?: number;
  pitch?: number;
}

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
  pitch = DEFAULT_PITCH;

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

  /**
   * AN-2: 動き（慣性・なめらかなズーム・視点の移動）を使うか。falseなら今までどおり
   * 操作に即座に反応する。設定オフ・prefers-reduced-motionのときはfalseにする
   * （point-cloud-renderer.tsが毎フレーム設定する）。
   */
  motionEnabled = true;

  /** 慣性の回転速度（ラジアン/秒）。0なら慣性なし。 */
  private inertiaYawRate = 0;
  private inertiaPitchRate = 0;
  /**
   * なめらかなズームの「まだ適用していない残り」（倍率の自然対数。縮める向きが負）。
   * ホイール1段ごとにlog(factor)を足し、update()が指数的に0へ近づけながらzoom()に渡す。
   * 倍率を対数で持つので、何段か重ねても「掛け合わせた倍率」がそのまま目標になる。
   */
  private pendingZoomLog = 0;
  /** 残りのズームを適用するときのカーソル方向（最後のホイールのもの）。 */
  private pendingZoomDirection: readonly [number, number, number] | undefined;
  /** 進行中の視点移動（全体表示・ダブルクリックで寄る）。nullなら無し。 */
  private transition: Transition | null = null;
  /** 慣性のパン速度（画面ピクセル/秒）。 */
  private inertiaPanX = 0;
  private inertiaPanY = 0;

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

  /**
   * AN-2: ドラッグを離した後の回転の慣性を始める。速度は離す直前のポインタ位置から
   * 求めた値（ラジアン/秒）。動きが無効、または遅すぎるときは何もしない。
   */
  startRotateInertia(yawRate: number, pitchRate: number): void {
    this.cancelInertia();
    if (!this.motionEnabled) return;
    if (Math.hypot(yawRate, pitchRate) < INERTIA_STOP_ROTATE_RAD_PER_SEC) return;
    this.inertiaYawRate = yawRate;
    this.inertiaPitchRate = pitchRate;
  }

  /** AN-2: パンの慣性を始める。速度は画面ピクセル/秒（pan()の引数と同じ単位）。 */
  startPanInertia(vxPxPerSec: number, vyPxPerSec: number): void {
    this.cancelInertia();
    if (!this.motionEnabled) return;
    if (Math.hypot(vxPxPerSec, vyPxPerSec) < INERTIA_STOP_PAN_PX_PER_SEC) return;
    this.inertiaPanX = vxPxPerSec;
    this.inertiaPanY = vyPxPerSec;
  }

  /**
   * AN-2: 視点をgoalへ、ease-in-outで動かす。動きが無効なら即座に移す（今までのリセットと同じ）。
   * 始めると、慣性・ズームの残りは捨てる（視点移動が主導権を持つ）。
   */
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

  /** 視点移動だけを止める（その場に留まる）。ユーザーの新しい操作で呼ぶ。 */
  cancelTransition(): void {
    this.transition = null;
  }

  private updateTransition(dtMs: number): void {
    const tr = this.transition;
    if (!tr) return;
    tr.elapsedMs += dtMs;
    const t = tr.elapsedMs / tr.durationMs;
    if (t >= 1) {
      // 終点はちょうどの値に置く（誤差を残さない）
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
    // 距離は対数で補間する（遠くから近くへ寄るとき、見た目の速さが一定に感じられる）
    this.distance = Math.exp(Math.log(tr.fromDistance) + (Math.log(tr.toDistance) - Math.log(tr.fromDistance)) * s);
    this.yaw = tr.fromYaw + tr.yawDelta * s;
    this.pitch = tr.fromPitch + (tr.toPitch - tr.fromPitch) * s;
  }

  /** 慣性・ズームの残り・視点移動を、すべて即座に止める（動きを無効にしたとき用）。 */
  cancelMotion(): void {
    this.transition = null;
    this.cancelInertia();
    this.pendingZoomLog = 0;
    this.pendingZoomDirection = undefined;
  }

  /**
   * AN-2: ホイールのなめらかなズーム。倍率factor(zoom()と同じ向き)を目標に積み、
   * 数フレームかけて近づける。動きが無効なら今までどおりzoom()で即座に適用する。
   */
  zoomSmooth(factor: number, cursorDirection?: readonly [number, number, number]): void {
    if (!this.motionEnabled) {
      this.zoom(factor, cursorDirection);
      return;
    }
    this.pendingZoomLog += Math.log(factor);
    this.pendingZoomDirection = cursorDirection;
  }

  /** 慣性を即座に止める。新しいポインタ操作の開始（pointerdown）で呼ぶ。 */
  cancelInertia(): void {
    this.inertiaYawRate = 0;
    this.inertiaPitchRate = 0;
    this.inertiaPanX = 0;
    this.inertiaPanY = 0;
  }

  /** 慣性で動いているか。 */
  private hasInertia(): boolean {
    return this.inertiaYawRate !== 0 || this.inertiaPitchRate !== 0 || this.inertiaPanX !== 0 || this.inertiaPanY !== 0;
  }

  /**
   * AN-2: 実際の経過時間dt(ms)ぶんだけ、カメラのアニメーションを進める。毎フレーム1回呼ぶ。
   *
   * 慣性は速度が v(t) = v0 * exp(-t/tau) で減る。dtの間の移動量は積分して
   * v * tau * (1 - exp(-dt/tau)) で、これは1フレームでも小刻みでも合計が同じになる
   * （フレームレートに依存しない）。
   */
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
    // 残りのうち、このdtで消化する割合。指数的に近づくのでdtの刻み方によらない。
    let apply = this.pendingZoomLog * expApproachFraction(dtMs, ZOOM_SMOOTH_TAU_MS);
    // 残りがごくわずかになったら、一度に適用して終える（いつまでも0に漸近しないように）
    if (Math.abs(this.pendingZoomLog - apply) < ZOOM_SMOOTH_STOP_LOG) apply = this.pendingZoomLog;
    this.pendingZoomLog -= apply;
    if (apply === 0) this.pendingZoomLog = 0;
    this.zoom(Math.exp(apply), this.pendingZoomDirection);
    if (this.pendingZoomLog === 0) this.pendingZoomDirection = undefined;
  }

  /** カメラがアニメーションで動いている（または動く予定の）間true。点予算の調整やHQ-2の「止まった」判定に使う。 */
  isAnimating(): boolean {
    return this.transition !== null || this.hasInertia() || this.pendingZoomLog !== 0;
  }

  private updateInertia(dtMs: number): void {
    const tauSec = INERTIA_TAU_MS / 1000;
    const move = tauSec * expApproachFraction(dtMs, INERTIA_TAU_MS);
    const keep = Math.exp(-dtMs / INERTIA_TAU_MS);

    if (this.inertiaYawRate !== 0 || this.inertiaPitchRate !== 0) {
      this.rotate(this.inertiaYawRate * move, this.inertiaPitchRate * move);
      // 仰角の端に当たったら、その方向の慣性は止める（端に押し付け続けない）
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
  /**
   * AN-2: ダブルクリック（マウス）/ダブルタップ（タッチ）されたときに呼ばれる。
   * 座標はキャンバス上のCSSピクセル（左上原点）。呼び出し側がレイキャストして
   * `camera.animateTo()`で寄る。
   */
  onFlyTo?: (screenX: number, screenY: number) => void;
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
  // AN-2: 1本指/1ボタンのドラッグの速度を求めるための、ポインタ位置の履歴。
  const velocity = new VelocityTracker();
  // AN-2: ダブルタップ判定用。直近のタップ（短く、ほぼ動かさずに離した指）と、押した位置・時刻。
  let tapDown: { t: number; x: number; y: number } | null = null;
  let lastTap: { t: number; x: number; y: number } | null = null;
  let lastTouchFlyAt = -Infinity;

  const onPointerDown = (e: PointerEvent) => {
    // AN-2: 新しい操作は、慣性を即座に止める
    camera.cancelInertia();
    camera.cancelTransition();
    tapDown = pointers.size === 0 && e.pointerType === "touch" ? { t: e.timeStamp, x: e.clientX, y: e.clientY } : null;
    // 2本目が置かれたら、1本のドラッグの履歴は捨てる（慣性は1本ドラッグだけ）
    velocity.reset();
    if (pointers.size === 0) velocity.add(e.timeStamp, e.clientX, e.clientY);
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
        velocity.add(e.timeStamp, e.clientX, e.clientY);
      } else if (prevPoint.button === 1) {
        // 中ドラッグ: パン
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
    // 3本以上は無視する（このポインタの位置だけは更新し、指が離れて2本に戻ったときに
    // 破綻しないようにする）。

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: prevPoint.button });
  };

  const onPointerUp = (e: PointerEvent) => {
    const released = pointers.get(e.pointerId);
    const wasOnlyPointer = pointers.size === 1 && released !== undefined;
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture(e.pointerId);

    // AN-2: 1本のドラッグを離したら、直前の速度で慣性を始める（pointercancelでは始めない）
    if (wasOnlyPointer && e.type === "pointerup") {
      const [vx, vy] = velocity.velocity(e.timeStamp);
      if (released.button === 0) {
        camera.startRotateInertia(-vx * ROTATE_SPEED, vy * ROTATE_SPEED);
      } else if (released.button === 1) {
        camera.startPanInertia(vx, vy);
      }
    }
    velocity.reset();

    // AN-2: ダブルタップ（タッチ）。短く・ほぼ動かさず離したタップが2回、近くで続いたら寄る。
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

  // AN-2: マウスのダブルクリック。タッチのダブルタップで同時にdblclickが来るブラウザがあるため、
  // タッチで寄った直後のdblclickは無視する。
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
