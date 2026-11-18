export const IDLE_BOOST_DELAY_MS = 500;

export interface IdleBoostState {
  boosting: boolean;
  savedBudget: number;
  lastMotionAtMs: number | null;
}

export const INITIAL_IDLE_BOOST_STATE: IdleBoostState = {
  boosting: false,
  savedBudget: 0,
  lastMotionAtMs: null,
};

export interface IdleBoostInput {
  nowMs: number;
  cameraActive: boolean;
  autoEnabled: boolean;
  currentBudget: number;
  maxBudget: number;
}

export type IdleBoostAction =
  | { kind: "none" }
  | { kind: "boost"; budget: number }
  | { kind: "restore"; budget: number };

export interface IdleBoostResult {
  state: IdleBoostState;
  action: IdleBoostAction;
  aimdPaused: boolean;
}

export function stepIdleBoost(state: IdleBoostState, input: IdleBoostInput): IdleBoostResult {
  const { nowMs, cameraActive, autoEnabled, currentBudget, maxBudget } = input;

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
    const next: IdleBoostState = { boosting: true, savedBudget: currentBudget, lastMotionAtMs: state.lastMotionAtMs };
    const action: IdleBoostAction =
      currentBudget < maxBudget ? { kind: "boost", budget: maxBudget } : { kind: "none" };
    return { state: next, action, aimdPaused: true };
  }

  return { state, action: { kind: "none" }, aimdPaused: false };
}

export interface CameraPose {
  eye: readonly [number, number, number];
  target: readonly [number, number, number];
}

export function cameraPoseChanged(previous: CameraPose | null, current: CameraPose): boolean {
  if (previous === null) return true;
  for (let i = 0; i < 3; i++) {
    if (previous.eye[i] !== current.eye[i] || previous.target[i] !== current.target[i]) return true;
  }
  return false;
}
