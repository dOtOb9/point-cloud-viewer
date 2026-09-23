// point-budget.ts のテスト。WebGPUデバイスもReactも要らない純粋関数なので、
// レンダラを一切起動せずに閉ループの挙動（下げる/上げる/振動しない/回復する）を
// 確認できる。

import { describe, expect, it } from "vitest";
import {
  evaluatePointBudget,
  pointBudgetMaxFromMemoryBudget,
  updateRefreshIntervalEstimate,
  DEFAULT_POINT_BUDGET_TUNING,
  type PointBudgetState,
  type PointBudgetTuning,
  type RefreshIntervalEstimate,
} from "./point-budget";

const REFRESH_60HZ_MS = 1000 / 60; // ≈16.667ms
const REFRESH_144HZ_MS = 1000 / 144; // ≈6.944ms

const TUNING: PointBudgetTuning = {
  ...DEFAULT_POINT_BUDGET_TUNING,
  limits: { min: 200_000, max: 3_000_000 },
};

const WINDOW_SIZE = 20; // point-cloud-renderer.tsのAUTO_POINT_BUDGET_FRAME_HISTORYと同じ想定

/** `recentFrameDeltasMs`のウィンドウを模した小さなヘルパー。
 *  point-cloud-rendererのrecordFrameDelta()と同じく、直近WINDOW_SIZE本だけを
 *  保持するリングバッファとして振る舞う。 */
function makeWindow() {
  const values: number[] = [];
  return {
    push(ms: number): void {
      values.push(ms);
      if (values.length > WINDOW_SIZE) values.shift();
    },
    pushMany(ms: number, count: number): void {
      for (let i = 0; i < count; i++) this.push(ms);
    },
    get(): number[] {
      return values;
    },
  };
}

/** `updateRefreshIntervalEstimate`を配列の値で順番に呼び、最終状態を返す。
 *  point-cloud-rendererの`recordFrameDelta`が毎フレーム行っているのと同じ
 *  「継続的な更新」を、テストの中で再現するためのヘルパー。 */
function estimateFromSequence(deltasMs: readonly number[]): RefreshIntervalEstimate | null {
  let estimate: RefreshIntervalEstimate | null = null;
  for (const deltaMs of deltasMs) {
    estimate = updateRefreshIntervalEstimate(estimate, deltaMs);
  }
  return estimate;
}

describe("updateRefreshIntervalEstimate", () => {
  it("最初の観測値をそのまま推定値にする", () => {
    const estimate = updateRefreshIntervalEstimate(null, REFRESH_60HZ_MS);
    expect(estimate.intervalMs).toBe(REFRESH_60HZ_MS);
  });

  it("60Hz相当(16.7ms)の間隔が続くと、約16.7msと推定する（固定値1000/60に決め打ちしていない）", () => {
    const estimate = estimateFromSequence(Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS));
    expect(estimate!.intervalMs).toBeCloseTo(REFRESH_60HZ_MS, 5);
  });

  it("144Hz相当(6.9ms)の間隔が続くと、約6.9msと推定する（60Hz用の固定値ではない）", () => {
    const estimate = estimateFromSequence(Array(WINDOW_SIZE).fill(REFRESH_144HZ_MS));
    expect(estimate!.intervalMs).toBeCloseTo(REFRESH_144HZ_MS, 5);
    // 60Hzとはっきり異なる値として区別できていること。
    expect(estimate!.intervalMs).toBeLessThan(REFRESH_60HZ_MS / 2);
  });

  it("一度小さい値を観測したら、その後ずっと大きい値（コマ落ち）が続いても推定値は下がらない", () => {
    // これが「最小値を使う」設計の核心: 負荷が続く区間だけを見て
    // リフレッシュ周期そのものを誤推定してしまわないようにする。
    let estimate = updateRefreshIntervalEstimate(null, REFRESH_60HZ_MS);
    for (let i = 0; i < 100; i++) {
      estimate = updateRefreshIntervalEstimate(estimate, REFRESH_60HZ_MS * 2); // ずっとコマ落ち
    }
    expect(estimate.intervalMs).toBe(REFRESH_60HZ_MS);
  });

  it("さらに小さい値が来たら更新する", () => {
    let estimate = updateRefreshIntervalEstimate(null, REFRESH_60HZ_MS);
    estimate = updateRefreshIntervalEstimate(estimate, REFRESH_144HZ_MS);
    expect(estimate.intervalMs).toBe(REFRESH_144HZ_MS);
  });

  it("0以下の異常値では前の推定値を保つ（防御的）", () => {
    const estimate = updateRefreshIntervalEstimate({ intervalMs: REFRESH_60HZ_MS }, -5);
    expect(estimate.intervalMs).toBe(REFRESH_60HZ_MS);
  });
});

describe("evaluatePointBudget", () => {
  it("60Hz相当でも144Hz相当でも、それぞれの推定周期を基準に「間に合っている」と正しく判定する", () => {
    // 目標を1000/60に決め打ちしていないことの確認。144Hzの生の間隔(6.9ms)を
    // 60Hz用の閾値と比べてしまうと「間に合っている」判定を誤る。
    const state: PointBudgetState = { budget: 1_000_000, consecutiveHits: 0 };

    const window60 = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS);
    const refresh60 = estimateFromSequence(window60)!.intervalMs;
    const result60 = evaluatePointBudget(state, window60, refresh60, TUNING);
    expect(result60.budget).toBe(1_000_000); // 間に合っているので下がらない
    expect(result60.consecutiveHits).toBe(1); // 「間に合った」がカウントされる

    const window144 = Array(WINDOW_SIZE).fill(REFRESH_144HZ_MS);
    const refresh144 = estimateFromSequence(window144)!.intervalMs;
    const result144 = evaluatePointBudget(state, window144, refresh144, TUNING);
    expect(result144.budget).toBe(1_000_000);
    expect(result144.consecutiveHits).toBe(1);
  });

  it("外した（vsyncを落とした）フレームが続くと、予算が下限に向かって単調に減る", () => {
    let state: PointBudgetState = { budget: 3_000_000, consecutiveHits: 0 };
    const window = makeWindow();
    window.pushMany(REFRESH_60HZ_MS * 2, WINDOW_SIZE); // 全フレームがコマ落ち(2倍)＝完全にミス

    const history = [state.budget];
    for (let i = 0; i < 50; i++) {
      state = evaluatePointBudget(state, window.get(), REFRESH_60HZ_MS, TUNING);
      history.push(state.budget);
    }

    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeLessThanOrEqual(history[i - 1]);
    }
    expect(state.budget).toBe(TUNING.limits.min);
  });

  it("結果は常にlimitsの範囲に収まる", () => {
    const window = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS * 5); // 極端に重い
    const shrunk = evaluatePointBudget({ budget: TUNING.limits.min, consecutiveHits: 0 }, window, REFRESH_60HZ_MS, TUNING);
    expect(shrunk.budget).toBeGreaterThanOrEqual(TUNING.limits.min);

    const lightWindow = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS);
    let state: PointBudgetState = { budget: TUNING.limits.max, consecutiveHits: 0 };
    for (let i = 0; i < TUNING.sustainedHitsToGrow + 5; i++) {
      state = evaluatePointBudget(state, lightWindow, REFRESH_60HZ_MS, TUNING);
    }
    expect(state.budget).toBeLessThanOrEqual(TUNING.limits.max);
  });

  it("不感帯（ミス割合がhitRatioToGrowとmissRatioToShrinkの間）では振動しない", () => {
    // 20フレーム中2本がミス(10%)。hitRatioToGrow=0.05より大きく
    // missRatioToShrink=0.15より小さいので、増やしも減らしもしない不感帯に入る。
    const window = Array(WINDOW_SIZE - 2).fill(REFRESH_60HZ_MS);
    window.push(REFRESH_60HZ_MS * 2, REFRESH_60HZ_MS * 2);

    let state: PointBudgetState = { budget: 3_000_000, consecutiveHits: 0 };
    for (let i = 0; i < 20; i++) {
      state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
      expect(state.budget).toBe(3_000_000);
      expect(state.consecutiveHits).toBe(0); // 「間に合っている」とは数えていない
    }
  });

  it("20フレームの窓にミスが1枚混ざっても、「間に合っている」の積み上げが台無しにならない（ADR-0010追記分）", () => {
    // 所有者の実機では、hitRatioToGrow=0（ミス0のときしか積まない）だと
    // カメラ操作中の単発ミス（ノード到着等）でconsecutiveHitsが毎回0に
    // リセットされ、sustainedHitsToGrow回連続でミス0を達成できる場面が
    // ほとんど無く、点予算が実質一度も増えなかった。
    // hitRatioToGrow=0.05（20フレーム中1枚まで許容）にしたことで、
    // 1枚だけミスが混ざる状態が続いても連続ヒットが積み上がり、最終的に
    // 上げる判断に到達することを確認する。
    const window = Array(WINDOW_SIZE - 1).fill(REFRESH_60HZ_MS);
    window.push(REFRESH_60HZ_MS * 2); // 20フレーム中1枚だけミス(5%)

    let state: PointBudgetState = { budget: 1_000_000, consecutiveHits: 0 };
    for (let i = 0; i < TUNING.sustainedHitsToGrow - 1; i++) {
      state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
      expect(state.consecutiveHits).toBe(i + 1); // リセットされず積み上がる
      expect(state.budget).toBe(1_000_000); // まだ上げる回数には達していない
    }
    // ちょうどsustainedHitsToGrow回目で、単発ミスが混ざったままでも上げる。
    state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
    expect(state.budget).toBeGreaterThan(1_000_000);
  });

  it("間に合っている状態が sustainedHitsToGrow 回続くまでは上げない（緩やかに上げる）", () => {
    const window = Array(WINDOW_SIZE).fill(REFRESH_60HZ_MS);
    let state: PointBudgetState = { budget: 1_000_000, consecutiveHits: 0 };

    for (let i = 0; i < TUNING.sustainedHitsToGrow - 1; i++) {
      state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
      expect(state.budget).toBe(1_000_000); // まだ上げない
    }
    // ちょうどsustainedHitsToGrow回目で上げる。
    state = evaluatePointBudget(state, window, REFRESH_60HZ_MS, TUNING);
    expect(state.budget).toBeGreaterThan(1_000_000);
    expect(state.consecutiveHits).toBe(0); // 上げたのでカウントはリセットされる
  });

  it(
    "【最重要】vsyncに量子化されたフレーム間隔の列を与えたとき、" +
      "コマ落ち区間の後に予算が元の水準へ向かって回復する",
    () => {
      // 直す前の実装（`nextPointBudget`。このコミットで削除済み）は、rAFの
      // コールバック間隔（＝vsyncの周期）をそのまま「フレームの重さ」として
      // 目標フレーム時間(1000/60ms固定)と比較していた。60Hz環境では間隔は
      // 常に16.7ms付近に量子化されるため、通常時は常に不感帯の「中」に入り、
      // 予算を上げる条件（目標を有意に下回る間隔）は原理的に発生しなかった。
      // そのため、このテストと同じ入力（安定→コマ落ち→安定に戻る）を
      // 旧実装(`nextPointBudget`)に与えても、コマ落ち後に予算が下がったまま
      // 二度と回復しない（このテストは失敗する）。
      //
      // 新実装は「間隔の絶対値」ではなく「vsyncに間に合っているか」を信号に
      // する。さらにリフレッシュ周期の推定を「これまでの最小値」にすることで
      // （`updateRefreshIntervalEstimate`）、コマ落ちが続く区間の間隔自体を
      // 誤ってリフレッシュ周期だと推定してしまう問題も避けている
      // （このテストを書く過程で、直近ウィンドウの最頻値から推定する版では
      // このテストが失敗することを実際にvitestで確認した）。

      const window = makeWindow();
      let state: PointBudgetState = { budget: 3_000_000, consecutiveHits: 0 };
      let refreshEstimate: RefreshIntervalEstimate | null = null;

      function stepOnce(deltaMs: number): void {
        window.push(deltaMs);
        refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, deltaMs);
        state = evaluatePointBudget(state, window.get(), refreshEstimate.intervalMs, TUNING);
      }

      // フェーズ1: 安定して60fpsが出ている(16.7ms一定)。
      for (let i = 0; i < WINDOW_SIZE + 5; i++) stepOnce(REFRESH_60HZ_MS);

      // フェーズ2: コマ落ちが数秒相当続く(33.3ms一定)。予算が下がる。
      for (let i = 0; i < WINDOW_SIZE + 20; i++) stepOnce(REFRESH_60HZ_MS * 2);
      const budgetAfterDrop = state.budget;
      expect(budgetAfterDrop).toBeLessThan(3_000_000);

      // フェーズ3: 再び60fpsが安定して出るようになる(16.7ms一定)。
      // ここが直したかった箇所: 予算が元の水準に向かって回復すること。
      // 「緩やかに上げる」設計（sustainedHitsToGrow回の連続ヒットごとに
      // growRate分だけ）なので、下限(200,000)から上限(3,000,000)まで戻るには
      // 相応の回数がかかる（log(15)/log(1.05)≈55.5回の増加×6回/回≈333回。
      // ウィンドウが入れ替わる分の余裕を見て500回評価する）。
      for (let i = 0; i < 500; i++) stepOnce(REFRESH_60HZ_MS);

      expect(state.budget).toBeGreaterThan(budgetAfterDrop);
      // 十分な回数「間に合っている」が続けば、元の3,000,000（=このテストの
      // limits.maxでもある）まで回復する。
      expect(state.budget).toBe(3_000_000);
    },
  );

  it("上限から始めてミスの多い列を与えると、数ステップで適正域まで落ちる（ADR-0010追記分: 楽観的に高く始める設計の確認）", () => {
    // ADR-0010の追記: 所有者の実機での実際の症状は「点予算が一度も動かなかった」
    // ことだった。修正方針は「低い値から上限を探り上げる」のではなく
    // 「楽観的に上限から始めて、外したら即座に大きく下げる」に変えたので、
    // 上限スタートでも実際に短時間で適正域まで落ちることを確認しておく
    // （高く始める設計が「落ちるのに時間がかかりすぎる」形で破綻しないことの確認）。
    const CAPACITY_POINTS = 500_000; // このモデルでの「ちょうど1周期に収まる」点数
    const START_BUDGET = 6_710_886; // 旧デフォルトのメモリ予算(256MiB)から逆算した上限相当
    const LIMITS = { min: 200_000, max: START_BUDGET };

    function simulateFrameMs(budget: number): number {
      const renderCostMs = REFRESH_60HZ_MS * (budget / CAPACITY_POINTS);
      const vsyncMultiples = Math.max(1, Math.ceil(renderCostMs / REFRESH_60HZ_MS));
      return vsyncMultiples * REFRESH_60HZ_MS;
    }

    const tuning: PointBudgetTuning = { ...TUNING, limits: LIMITS };
    let state: PointBudgetState = { budget: START_BUDGET, consecutiveHits: 0 };
    // 実機では、起動直後に重い点予算を試す前からすでに何フレームか描画しており、
    // リフレッシュ周期の推定(updateRefreshIntervalEstimate)は真の値(16.7ms)を
    // 既に掴んでいるはず。ここでもその前提を置く（初回サンプルがいきなり
    // 過負荷なフレームだと、最小値そのものが過負荷値に汚染されてしまうため）。
    let refreshEstimate: RefreshIntervalEstimate | null = { intervalMs: REFRESH_60HZ_MS };
    let stepsToReachNearCapacity = -1;

    for (let i = 0; i < 30; i++) {
      const frameMs = simulateFrameMs(state.budget);
      refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, frameMs);
      const window = Array(WINDOW_SIZE).fill(frameMs);
      state = evaluatePointBudget(state, window, refreshEstimate.intervalMs, tuning);
      if (stepsToReachNearCapacity === -1 && state.budget <= CAPACITY_POINTS * 1.5) {
        stepsToReachNearCapacity = i + 1;
      }
    }

    // shrinkRateは持続要求なしで即座に効く(20%/回)ので、上限(6,710,886)から
    // 適正域(CAPACITY_POINTSの1.5倍以内)まで、数ステップ(評価間隔500ms換算で
    // 数秒)で落ちるはず。数十ステップもかかるようでは「楽観的に高く始める」
    // 設計が実用にならない。
    expect(stepsToReachNearCapacity).toBeGreaterThan(0);
    expect(stepsToReachNearCapacity).toBeLessThanOrEqual(15);
  });

  it("予算を増やした結果コマ落ちするようになったら下げ、その付近で落ち着く（際限なく増え続けない）", () => {
    // シミュレーション: 「描画コストは点予算に比例する」という単純なモデルを使う。
    // vsync環境なので、描画コストが1周期を超えたら次のvsyncまで丸ごと1周期分
    // 余分にかかる（=フレーム時間は周期の整数倍に量子化される）。
    const CAPACITY_POINTS = 2_000_000; // このモデルでの「ちょうど1周期に収まる」点数
    const REFRESH_MS = REFRESH_60HZ_MS;
    const LIMITS = { min: 200_000, max: 10_000_000 }; // 上限はcapacityよりずっと高くしておく

    function simulateFrameMs(budget: number): number {
      const renderCostMs = REFRESH_MS * (budget / CAPACITY_POINTS);
      const vsyncMultiples = Math.max(1, Math.ceil(renderCostMs / REFRESH_MS));
      return vsyncMultiples * REFRESH_MS;
    }

    const tuning: PointBudgetTuning = { ...TUNING, limits: LIMITS };
    let state: PointBudgetState = { budget: 200_000, consecutiveHits: 0 };
    let refreshEstimate: RefreshIntervalEstimate | null = null;
    let sawDecreaseAfterGrowth = false;
    let maxBudgetSeen = state.budget;

    for (let i = 0; i < 500; i++) {
      const frameMs = simulateFrameMs(state.budget);
      refreshEstimate = updateRefreshIntervalEstimate(refreshEstimate, frameMs);
      const window = Array(WINDOW_SIZE).fill(frameMs);
      const before = state.budget;
      state = evaluatePointBudget(state, window, refreshEstimate.intervalMs, tuning);
      if (state.budget > maxBudgetSeen) maxBudgetSeen = state.budget;
      if (state.budget < before) sawDecreaseAfterGrowth = true;
    }

    // 際限なく増え続けてハード上限に張り付いてはいない
    // （このモデルの「限界」であるCAPACITY_POINTSの近くで頭打ちになるはず）。
    expect(state.budget).toBeLessThan(LIMITS.max);
    expect(maxBudgetSeen).toBeLessThan(CAPACITY_POINTS * 1.5);
    // 増やしすぎてコマ落ちし、実際に下げるという訂正が少なくとも1回起きている。
    expect(sawDecreaseAfterGrowth).toBe(true);
    // 最終的にはCAPACITY_POINTS付近（意味のある範囲）に落ち着いている。
    expect(state.budget).toBeGreaterThan(CAPACITY_POINTS * 0.3);
  });
});

describe("pointBudgetMaxFromMemoryBudget", () => {
  it("メモリ予算をキャッシュ倍率つきの1点あたりバイト数で割った点数を返す", () => {
    // 20バイト/点(POINT_STRIDE) × キャッシュ倍率2倍で256MiBのメモリ予算なら、
    // 256*1024*1024 / (20*2) = 6,710,886.4 → 切り捨てで6,710,886。
    expect(pointBudgetMaxFromMemoryBudget(256 * 1024 * 1024, 20, 2)).toBe(6_710_886);
  });

  it("結果は常に整数（端数を切り捨てる）", () => {
    const result = pointBudgetMaxFromMemoryBudget(1_000, 3, 1);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(Math.floor(1_000 / 3));
  });
});
