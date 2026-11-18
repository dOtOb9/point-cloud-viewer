export interface DeviceRecoveryAttempt {
  atMs: number;
}

export interface DeviceRecoveryLimits {
  windowMs: number;
  maxAttemptsPerWindow: number;
}

export type DeviceRecoveryDecision = { shouldRecover: true } | { shouldRecover: false; reason: string };

export function decideDeviceRecovery(
  recentAttempts: readonly DeviceRecoveryAttempt[],
  nowMs: number,
  limits: DeviceRecoveryLimits,
): DeviceRecoveryDecision {
  const withinWindow = recentAttempts.filter((a) => nowMs - a.atMs < limits.windowMs);
  if (withinWindow.length >= limits.maxAttemptsPerWindow) {
    return {
      shouldRecover: false,
      reason:
        `直近${Math.round(limits.windowMs / 1000)}秒以内に${withinWindow.length}回復帰を試みたため、` +
        `これ以上は試みない(上限${limits.maxAttemptsPerWindow}回)`,
    };
  }
  return { shouldRecover: true };
}

export function recordDeviceRecoveryAttempt(
  recentAttempts: readonly DeviceRecoveryAttempt[],
  nowMs: number,
  limits: DeviceRecoveryLimits,
): DeviceRecoveryAttempt[] {
  return [...recentAttempts.filter((a) => nowMs - a.atMs < limits.windowMs), { atMs: nowMs }];
}

export const DEFAULT_DEVICE_RECOVERY_LIMITS: DeviceRecoveryLimits = {
  windowMs: 60_000,
  maxAttemptsPerWindow: 3,
};
