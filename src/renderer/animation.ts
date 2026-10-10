// アニメーション（AN-1 ノードのフェードイン / AN-2 カメラの動き）で使う定数と純粋関数。
// GPU・DOM・OrbitCameraに依存しないので、vitestで直接検証できる。
//
// **ここにある時間・減速の強さ・しきい値は、どれも「未検証の初期値」。**
// 実機（特にAndroid）で触って決めた値ではない。所有者が画面で見て調整する前提で、
// 調整の入口をこのファイルの定数1か所に集めてある（TaskSheets/AN-animation.md）。

// ---- AN-1: ノードのフェードイン（ディザ） --------------------------------

/** 新しく表示するノードが、0→1まで出ていくのにかける時間(ms)。未検証の初期値。 */
export const FADE_IN_DURATION_MS = 250;

/**
 * 表示を始めてからの経過時間(ms)から、フェードの割合(0〜1)を返す。
 * 0のときは点がまったく描かれず、1のときはすべて描かれる。
 * シェーダはこの値を画面上のBayer 4x4のしきい値と比べ、超えない点を捨てる
 * （アルファブレンドではなくディザにした理由はTaskSheets/AN-animation.mdの「AN-1/AN-2 実装」）。
 */
export function fadeInFactor(elapsedMs: number, durationMs: number = FADE_IN_DURATION_MS): number {
  if (!(durationMs > 0)) return 1;
  if (!(elapsedMs > 0)) return 0;
  return Math.min(1, elapsedMs / durationMs);
}

/**
 * ノードごとのフェード係数。
 * - アニメーションが無効（設定オフ・prefers-reduced-motion）なら常に1（いきなり全部出す）
 * - まだ一度も描いていないノード（firstDrawnAtMs === null）は0から始める
 */
export function nodeFadeFactor(firstDrawnAtMs: number | null, nowMs: number, motionEnabled: boolean): number {
  if (!motionEnabled) return 1;
  if (firstDrawnAtMs === null) return 0;
  return fadeInFactor(nowMs - firstDrawnAtMs);
}

// ---- 共通: 動きを許すかどうか ---------------------------------------------

/** OSの「視差効果を減らす」が有効か。matchMediaが無い環境（vitestのnode等）ではfalse。 */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== "function") return false;
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 設定がオンで、かつOSが動きを減らす指定をしていないときだけ、動きを使う。 */
export function resolveMotionEnabled(settingEnabled: boolean, reducedMotion: boolean): boolean {
  return settingEnabled && !reducedMotion;
}

// ---- AN-2: カメラの動き ----------------------------------------------------
// 時間の扱いはどれも「実際の経過時間dt」を使う。フレームレートが違っても
// 同じ時間で同じ状態になるよう、毎フレーム掛ける固定の係数（0.95倍など）ではなく、
// 指数関数 exp(-dt/tau) の形で書いている（animation.test.tsで30fpsと144fpsを比べている）。

/** 慣性の減衰の時定数(ms)。離した後、速度が 1/e になるまでの時間。未検証の初期値。 */
export const INERTIA_TAU_MS = 325;
/** 慣性の速度を求めるときに見る、直近のポインタ位置の時間幅(ms)。未検証の初期値。 */
export const INERTIA_SAMPLE_WINDOW_MS = 100;
/** 最後の動きから離すまでにこれ以上空いたら「止めてから離した」とみなして慣性なし(ms)。未検証の初期値。 */
export const INERTIA_MAX_IDLE_MS = 60;
/** 回転の慣性を止める速さ(ラジアン/秒)。これを下回ったら止める。未検証の初期値。 */
export const INERTIA_STOP_ROTATE_RAD_PER_SEC = 0.05;
/** パンの慣性を止める速さ(ピクセル/秒)。未検証の初期値。 */
export const INERTIA_STOP_PAN_PX_PER_SEC = 8;

/** ホイールズームが目標へ近づく時定数(ms)。未検証の初期値。 */
export const ZOOM_SMOOTH_TAU_MS = 80;
/** 残りのズーム量(自然対数)がこれを下回ったら、残りを一度に適用して終える。 */
export const ZOOM_SMOOTH_STOP_LOG = 1e-3;

/** 視点の移動（全体表示・ダブルクリックで寄る）の時間(ms)。0.4〜0.6秒の範囲。未検証の初期値。 */
export const TRANSITION_DURATION_MS = 500;
/** ダブルクリックで寄るとき、距離を現在の何倍にするか。未検証の初期値。 */
export const FLY_TO_DISTANCE_RATIO = 0.5;
/** ダブルタップとみなす、2回のタップの間隔(ms)と距離(px)。未検証の初期値。 */
export const DOUBLE_TAP_MAX_INTERVAL_MS = 300;
export const DOUBLE_TAP_MAX_DISTANCE_PX = 30;

/** ゆっくり始まり、ゆっくり止まる(ease-in-out、3次)。0→0、1→1、0.5→0.5。 */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** 経過dt(ms)の間に、時定数tau(ms)の指数的な減衰で「残りのうち消える割合」。0〜1。 */
export function expApproachFraction(dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return 0;
  if (!(tauMs > 0)) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

/** 角度の差を -π〜π に畳む（視点移動で、回転の近いほうへ回すため）。 */
export function shortestAngleDelta(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let d = (to - from) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return d;
}

/**
 * 直近のポインタ位置から、離した瞬間の速度(ピクセル/秒)を求める。
 * 位置は呼び出し側が積算した値（clientX/clientY）をそのまま入れる。
 */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  add(tMs: number, x: number, y: number): void {
    this.samples.push({ t: tMs, x, y });
    // 窓より古いものは捨てる（配列が育ち続けないように）
    while (this.samples.length > 2 && tMs - this.samples[0].t > INERTIA_SAMPLE_WINDOW_MS) {
      this.samples.shift();
    }
  }

  reset(): void {
    this.samples.length = 0;
  }

  /** 離した時刻nowMsでの速度。サンプルが足りない・止めてから離した場合は[0, 0]。 */
  velocity(nowMs: number): [number, number] {
    const n = this.samples.length;
    if (n < 2) return [0, 0];
    const last = this.samples[n - 1];
    if (nowMs - last.t > INERTIA_MAX_IDLE_MS) return [0, 0];
    // 窓の中で最も古いサンプルを起点にする
    let first = this.samples[0];
    for (const s of this.samples) {
      if (last.t - s.t <= INERTIA_SAMPLE_WINDOW_MS) {
        first = s;
        break;
      }
    }
    const spanSec = (last.t - first.t) / 1000;
    if (!(spanSec > 0)) return [0, 0];
    return [(last.x - first.x) / spanSec, (last.y - first.y) / spanSec];
  }
}
