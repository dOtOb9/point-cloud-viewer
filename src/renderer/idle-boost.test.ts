import { describe, expect, it } from "vitest";
import {
  cameraPoseChanged,
  IDLE_BOOST_DELAY_MS,
  INITIAL_IDLE_BOOST_STATE,
  stepIdleBoost,
  type IdleBoostState,
} from "./idle-boost";

const MAX = 26_800_000;

/** 1フレームぶんの入力を作る小さな道具。 */
function step(
  state: IdleBoostState,
  nowMs: number,
  cameraActive: boolean,
  currentBudget: number,
  autoEnabled = true,
) {
  return stepIdleBoost(state, { nowMs, cameraActive, autoEnabled, currentBudget, maxBudget: MAX });
}

describe("stepIdleBoost", () => {
  it("動いている間は何もしない", () => {
    let s = INITIAL_IDLE_BOOST_STATE;
    for (let t = 0; t < 3000; t += 16) {
      const r = step(s, t, true, 10_000_000);
      expect(r.action.kind).toBe("none");
      expect(r.aimdPaused).toBe(false);
      s = r.state;
    }
  });

  it("止まって遅延が経つまでは上げず、経ったら上限まで上げて AIMD を止める", () => {
    let s = step(INITIAL_IDLE_BOOST_STATE, 0, true, 10_000_000).state;
    const early = step(s, IDLE_BOOST_DELAY_MS - 1, false, 10_000_000);
    expect(early.action.kind).toBe("none");
    expect(early.aimdPaused).toBe(false);
    s = early.state;

    const r = step(s, IDLE_BOOST_DELAY_MS, false, 10_000_000);
    expect(r.action).toEqual({ kind: "boost", budget: MAX });
    expect(r.aimdPaused).toBe(true);
    expect(r.state.boosting).toBe(true);
    expect(r.state.savedBudget).toBe(10_000_000);
  });

  it("上げている間は追加の action を出さず、AIMD を止め続ける", () => {
    let s = step(INITIAL_IDLE_BOOST_STATE, 0, true, 10_000_000).state;
    s = step(s, IDLE_BOOST_DELAY_MS, false, 10_000_000).state;
    for (let t = 1000; t < 20_000; t += 500) {
      const r = step(s, t, false, MAX);
      expect(r.action.kind).toBe("none");
      expect(r.aimdPaused).toBe(true);
      s = r.state;
    }
    // 保存した値は、止まっている間に上書きされない
    expect(s.savedBudget).toBe(10_000_000);
  });

  it("動いたら、同じフレームで元の点予算に戻し、AIMD を再開する", () => {
    let s = step(INITIAL_IDLE_BOOST_STATE, 0, true, 10_000_000).state;
    s = step(s, IDLE_BOOST_DELAY_MS, false, 10_000_000).state;
    const r = step(s, 5000, true, MAX);
    expect(r.action).toEqual({ kind: "restore", budget: 10_000_000 });
    expect(r.aimdPaused).toBe(false);
    expect(r.state.boosting).toBe(false);
  });

  it("すでに上限なら点予算は変えないが、AIMD は止める", () => {
    let s = step(INITIAL_IDLE_BOOST_STATE, 0, true, MAX).state;
    const r = step(s, IDLE_BOOST_DELAY_MS, false, MAX);
    expect(r.action.kind).toBe("none");
    expect(r.aimdPaused).toBe(true);
    s = r.state;
    const back = step(s, 2000, true, MAX);
    expect(back.action).toEqual({ kind: "restore", budget: MAX });
  });

  it("自動調整がオフなら、止まっても上げない（利用者の指定を尊重する）", () => {
    let s = step(INITIAL_IDLE_BOOST_STATE, 0, true, 5_000_000, false).state;
    for (let t = 100; t < 10_000; t += 100) {
      const r = step(s, t, false, 5_000_000, false);
      expect(r.action.kind).toBe("none");
      expect(r.aimdPaused).toBe(false);
      s = r.state;
    }
  });

  it("上げている最中に自動調整をオフにされたら、戻さず状態だけ捨てる", () => {
    let s = step(INITIAL_IDLE_BOOST_STATE, 0, true, 10_000_000).state;
    s = step(s, IDLE_BOOST_DELAY_MS, false, 10_000_000).state;
    const r = step(s, 2000, false, MAX, false);
    expect(r.action.kind).toBe("none");
    expect(r.state.boosting).toBe(false);
    // その後オンに戻して動いても、古い保存値（10M）へ勝手に戻らない
    const r2 = step(r.state, 2100, true, MAX, true);
    expect(r2.action.kind).toBe("none");
  });

  it("止まる→動く→止まる を繰り返しても、AIMD の値は一方向にずれない", () => {
    // 呼び出し側（point-cloud-renderer.ts）の動きを模擬する。
    // 止まっている間は AIMD が止まる。AIMD の値は「動いている間」にだけ変わりうる。
    const aimdBudget = 12_000_000;
    let budget = aimdBudget;
    let s = INITIAL_IDLE_BOOST_STATE;
    let now = 0;
    const seen: number[] = [];

    for (let round = 0; round < 10; round++) {
      // 動く（1秒）。ここで AIMD が、毎回同じ値に落ち着く（模擬: 変えない）
      for (let i = 0; i < 60; i++) {
        now += 16;
        const r = step(s, now, true, budget);
        s = r.state;
        if (r.action.kind === "restore") budget = r.action.budget;
        expect(r.aimdPaused).toBe(false);
      }
      seen.push(budget);
      // 止まる（3秒）。fps が落ちても AIMD は呼ばれない（aimdPaused を確かめる）
      for (let i = 0; i < 190; i++) {
        now += 16;
        const r = step(s, now, false, budget);
        s = r.state;
        if (r.action.kind === "boost") budget = r.action.budget;
        if (r.action.kind === "restore") budget = r.action.budget;
        if (s.boosting) expect(r.aimdPaused).toBe(true);
      }
      expect(budget).toBe(MAX);
    }
    // 動き出した時点の点予算は、毎回 AIMD の値（12M）のまま。小さくも大きくもならない
    expect(seen.every((b) => b === aimdBudget)).toBe(true);
  });

  it("動き出した直後の1フレーム目でも、点予算は上げた値ではなく元の値になっている", () => {
    let s = step(INITIAL_IDLE_BOOST_STATE, 0, true, 8_000_000).state;
    s = step(s, 600, false, 8_000_000).state;
    const r = step(s, 700, true, MAX);
    expect(r.action.kind === "restore" && r.action.budget).toBe(8_000_000);
  });
});

describe("cameraPoseChanged", () => {
  const pose = { eye: [1, 2, 3] as const, target: [0, 0, 0] as const };
  it("最初は動いたとみなす", () => {
    expect(cameraPoseChanged(null, pose)).toBe(true);
  });
  it("同じなら動いていない", () => {
    expect(cameraPoseChanged(pose, { eye: [1, 2, 3], target: [0, 0, 0] })).toBe(false);
  });
  it("視点か注視点が変われば動いた", () => {
    expect(cameraPoseChanged(pose, { eye: [1, 2, 3.1], target: [0, 0, 0] })).toBe(true);
    expect(cameraPoseChanged(pose, { eye: [1, 2, 3], target: [0, 1, 0] })).toBe(true);
  });
});
