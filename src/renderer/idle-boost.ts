// HQ-2: カメラが止まったら、点予算を上限まで上げて、最大の細かさまで読む。
// 動かし始めたら、描く前に元の点予算に戻す。
//
// このファイルは「いつ上げて、いつ戻すか」の判定だけを持つ純粋なロジックで、
// WebGPU にも React にも依存しない（規約3）。`point-cloud-renderer.ts` が毎フレーム
// `stepIdleBoost` を呼び、返ってきた `budget` を点予算に代入する。
//
// ## 一方向に張り付かないための決まり（ADR-0007・0010 で何度も失敗した形）
//
// - 上げる前の点予算（AIMD が決めた値）を `savedBudget` に**1回だけ**保存する。
//   止まっている間は AIMD を止める（呼び出し側が `aimdPaused` を見る）ので、
//   `savedBudget` は止まっている間に変わらない。動き出したらその値にそのまま戻す。
//   「上限まで上げた値」を AIMD の値として覚え直すことはない
// - 止まっている間の fps の落ち込みを AIMD に見せない。これは呼び出し側が、
//   戻すときに直近フレームの窓を捨てて AIMD を最初からやり直すことで守る
//   （`restore` の action を見て行う）
// - 利用者が自動調整をオフにしている間は何もしない（利用者の指定を尊重する）

/** カメラが動かなくなってから、最大まで上げ始めるまでの時間(ms)。**未検証の初期値。** */
export const IDLE_BOOST_DELAY_MS = 500;

export interface IdleBoostState {
  /** 止まって上限まで上げている最中なら true。 */
  boosting: boolean;
  /** 上げる前の点予算（AIMD の値）。`boosting` の間だけ意味がある。 */
  savedBudget: number;
  /** カメラが最後に動いていた時刻(ms)。まだ一度も呼ばれていなければ null。 */
  lastMotionAtMs: number | null;
}

export const INITIAL_IDLE_BOOST_STATE: IdleBoostState = {
  boosting: false,
  savedBudget: 0,
  lastMotionAtMs: null,
};

export interface IdleBoostInput {
  nowMs: number;
  /** このフレームでカメラが動いた、またはアニメーション（慣性・ズーム・視点移動）が続いている。 */
  cameraActive: boolean;
  /** 利用者が点予算の自動調整をオンにしているか。オフなら HQ-2 も働かない。 */
  autoEnabled: boolean;
  /** 今の点予算。 */
  currentBudget: number;
  /** 上げ先（今の上限）。 */
  maxBudget: number;
}

/** 呼び出し側が行うこと。 */
export type IdleBoostAction =
  | { kind: "none" }
  /** 点予算を `budget` に上げる。 */
  | { kind: "boost"; budget: number }
  /** 点予算を `budget`（上げる前の値）に戻す。AIMD は最初からやり直すこと。 */
  | { kind: "restore"; budget: number };

export interface IdleBoostResult {
  state: IdleBoostState;
  action: IdleBoostAction;
  /** true の間、AIMD の評価を呼ばない。 */
  aimdPaused: boolean;
}

/**
 * 1フレームぶんの判定。描く前（点を選ぶ前）に呼ぶこと。
 * 入力で動いたフレームでは、その同じフレームの描画前に `restore` が返る。
 */
export function stepIdleBoost(state: IdleBoostState, input: IdleBoostInput): IdleBoostResult {
  const { nowMs, cameraActive, autoEnabled, currentBudget, maxBudget } = input;

  // 利用者が自動調整をオフにした: 上げている最中でも戻さない（呼び出し側が
  // 手動設定した値、またはオフにした時点の値をそのまま尊重する）。状態だけ捨てる。
  if (!autoEnabled) {
    return {
      state: { boosting: false, savedBudget: 0, lastMotionAtMs: nowMs },
      action: { kind: "none" },
      aimdPaused: false,
    };
  }

  if (cameraActive || state.lastMotionAtMs === null) {
    const next: IdleBoostState = { boosting: false, savedBudget: 0, lastMotionAtMs: nowMs };
    if (state.boosting) {
      return { state: next, action: { kind: "restore", budget: state.savedBudget }, aimdPaused: false };
    }
    return { state: next, action: { kind: "none" }, aimdPaused: false };
  }

  if (state.boosting) {
    return { state, action: { kind: "none" }, aimdPaused: true };
  }

  if (nowMs - state.lastMotionAtMs >= IDLE_BOOST_DELAY_MS) {
    // 上げる前の値を、この1回だけ保存する。
    const next: IdleBoostState = { boosting: true, savedBudget: currentBudget, lastMotionAtMs: state.lastMotionAtMs };
    const action: IdleBoostAction =
      currentBudget < maxBudget ? { kind: "boost", budget: maxBudget } : { kind: "none" };
    return { state: next, action, aimdPaused: true };
  }

  return { state, action: { kind: "none" }, aimdPaused: false };
}

/** カメラの姿勢（視点の位置と注視点）。前のフレームと比べて動いたかの判定用。 */
export interface CameraPose {
  eye: readonly [number, number, number];
  target: readonly [number, number, number];
}

/** 2つの姿勢が（浮動小数点の誤差を超えて）違うか。 */
export function cameraPoseChanged(previous: CameraPose | null, current: CameraPose): boolean {
  if (previous === null) return true;
  for (let i = 0; i < 3; i++) {
    if (previous.eye[i] !== current.eye[i] || previous.target[i] !== current.target[i]) return true;
  }
  return false;
}
