// device-recovery.tsのテスト(M3-8追加、受け入れ条件「復帰の判断を純粋関数に
// 切り出して単体テストを付ける」に対応)。

import { describe, expect, it } from "vitest";
import {
  decideDeviceRecovery,
  recordDeviceRecoveryAttempt,
  type DeviceRecoveryAttempt,
  type DeviceRecoveryLimits,
} from "./device-recovery";

const LIMITS: DeviceRecoveryLimits = { windowMs: 60_000, maxAttemptsPerWindow: 3 };

describe("decideDeviceRecovery", () => {
  it("試行履歴が無ければ復帰を試みる", () => {
    expect(decideDeviceRecovery([], 0, LIMITS)).toEqual({ shouldRecover: true });
  });

  it("窓内の試行が上限未満なら復帰を試みる", () => {
    const attempts: DeviceRecoveryAttempt[] = [{ atMs: 0 }, { atMs: 1000 }];
    expect(decideDeviceRecovery(attempts, 2000, LIMITS)).toEqual({ shouldRecover: true });
  });

  it("窓内の試行が上限に達したら諦める(理由付き)", () => {
    const attempts: DeviceRecoveryAttempt[] = [{ atMs: 0 }, { atMs: 1000 }, { atMs: 2000 }];
    const decision = decideDeviceRecovery(attempts, 3000, LIMITS);
    expect(decision.shouldRecover).toBe(false);
    if (!decision.shouldRecover) {
      expect(decision.reason).toMatch(/3回/);
    }
  });

  it("窓より古い試行は数えない(時間が経てば復帰を再び試みられる)", () => {
    const attempts: DeviceRecoveryAttempt[] = [{ atMs: 0 }, { atMs: 1000 }, { atMs: 2000 }];
    // 窓(60秒)が過ぎた後の再度の消失。
    const decision = decideDeviceRecovery(attempts, 2000 + LIMITS.windowMs + 1, LIMITS);
    expect(decision.shouldRecover).toBe(true);
  });

  it("上限がちょうど境界(2回まではOK、3回目でNG)であることを確認する", () => {
    const twoAttempts: DeviceRecoveryAttempt[] = [{ atMs: 0 }, { atMs: 1000 }];
    expect(decideDeviceRecovery(twoAttempts, 1500, LIMITS).shouldRecover).toBe(true);

    const threeAttempts: DeviceRecoveryAttempt[] = [{ atMs: 0 }, { atMs: 1000 }, { atMs: 1500 }];
    expect(decideDeviceRecovery(threeAttempts, 1600, LIMITS).shouldRecover).toBe(false);
  });
});

describe("recordDeviceRecoveryAttempt", () => {
  it("今回の試行を履歴に追加する", () => {
    const result = recordDeviceRecoveryAttempt([], 100, LIMITS);
    expect(result).toEqual([{ atMs: 100 }]);
  });

  it("windowMsより古い履歴を取り除く", () => {
    const attempts: DeviceRecoveryAttempt[] = [{ atMs: 0 }, { atMs: 1000 }];
    const result = recordDeviceRecoveryAttempt(attempts, LIMITS.windowMs + 500, LIMITS);
    // atMs=0は(windowMs+500) - 0 >= windowMsなので除外される。
    // atMs=1000は(windowMs+500) - 1000 < windowMsなので残る。
    expect(result).toEqual([{ atMs: 1000 }, { atMs: LIMITS.windowMs + 500 }]);
  });

  it("recordしてからdecideすると、記録した試行自体が次の判定に数えられる", () => {
    let attempts: DeviceRecoveryAttempt[] = [];
    attempts = recordDeviceRecoveryAttempt(attempts, 0, LIMITS);
    attempts = recordDeviceRecoveryAttempt(attempts, 1000, LIMITS);
    attempts = recordDeviceRecoveryAttempt(attempts, 2000, LIMITS);
    // 3回記録した直後、4回目の消失(3000ms時点)は上限に達しているため諦める。
    expect(decideDeviceRecovery(attempts, 3000, LIMITS).shouldRecover).toBe(false);
  });
});
