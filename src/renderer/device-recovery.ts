// M3-8追加: WebGPUデバイス消失(device.lost)から復帰を試みるかどうかを決める
// 純粋関数。GPUもReactも知らない(point-budget.tsのAIMD判定と同じ方針で、
// 「頻度の判断」だけをここに切り出し、実際のデバイス再取得・リソース再構築は
// gpu-resources.ts(WebGPUのAPIを直接叩くのはこのファイルだけ、という規約3の
// 補足に従う唯一の場所)が行う)。
//
// ## 経緯
//
// 所有者の実機(OPPO Pad Air)で「WebGPUデバイスが失われました」というエラー
// バナー(ADR-0011)が出た後、画面が固まったまま二度と復帰しないという報告が
// あった。以前は`device.lost`を受けてもエラーを報告するだけで、デバイスを
// 取り直す経路が無かったため、一度失われると`isReady()`が恒久的にfalseの
// ままになり、以後は毎フレーム描画がスキップされ続けていた。
//
// WebGPUの推奨(MDN "Handling device loss")どおり、`device.lost`を受けたら
// アダプタとデバイスを取り直し、デバイスに紐づくリソースをすべて作り直す
// ことで復帰を試みる。ただし**無限に繰り返さない**: 短時間に何度も失われる
// 場合はハードウェア/ドライバ側の深刻な問題である可能性が高く、復帰を
// 繰り返してもユーザ体験が悪化するだけなので、ある回数を超えたら諦めて
// バナーで知らせる。

/** 1回の復帰試行の記録。呼び出し側(gpu-resources.ts)がタイムスタンプだけを持つ。 */
export interface DeviceRecoveryAttempt {
  /** 試行した時刻(ms)。`Date.now()`を想定(rAFのタイムスタンプとは無関係な、
   *  デバイス消失というレンダーループの外側で起きるイベントのため)。 */
  atMs: number;
}

export interface DeviceRecoveryLimits {
  /** この時間窓(ms)以内の試行回数だけを数える(それより古い試行は無視する)。 */
  windowMs: number;
  /** 窓内の試行がこの回数に達したら、それ以上は試みない。 */
  maxAttemptsPerWindow: number;
}

export type DeviceRecoveryDecision = { shouldRecover: true } | { shouldRecover: false; reason: string };

/**
 * 直近の復帰試行履歴(`recentAttempts`)から、「もう一度復帰を試みてよいか」を
 * 判定する。`windowMs`より古い試行は無視するので、`recentAttempts`自体を
 * 呼び出し側で事前に刈り込んでおく必要はない(`recordDeviceRecoveryAttempt`が
 * まとめて行う)。
 *
 * **`reason === "destroyed"`(こちらが意図的にdeviceを破棄した場合)は復帰
 * しない、という判断はこの関数の外(呼び出し側)で行う。** 理由: この関数は
 * 「頻度」だけを見る責務に絞ることで、テストが「時刻と回数」だけの単純な
 * 入出力になる(「意図的な破棄かどうか」という別の軸の判定を混ぜない)。
 */
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

/**
 * 復帰試行の履歴に今回の試行(`nowMs`)を追加し、`windowMs`より古い履歴を
 * 取り除いた新しい配列を返す(履歴が際限なく伸びないようにする)。
 * 呼び出し側は`decideDeviceRecovery`で「試みてよい」と判定した直後に
 * これを呼び、戻り値をフィールドとして持ち続けること。
 */
export function recordDeviceRecoveryAttempt(
  recentAttempts: readonly DeviceRecoveryAttempt[],
  nowMs: number,
  limits: DeviceRecoveryLimits,
): DeviceRecoveryAttempt[] {
  return [...recentAttempts.filter((a) => nowMs - a.atMs < limits.windowMs), { atMs: nowMs }];
}

/**
 * 既定の復帰制限。**未検証の初期値。** 「1分間に3回」を上限にした。
 * 所有者の実機での再現頻度が分からない段階での、経験的な最初の見立てに
 * すぎない。頻繁すぎる/緩すぎると感じた場合は所有者の判断で調整してよい。
 */
export const DEFAULT_DEVICE_RECOVERY_LIMITS: DeviceRecoveryLimits = {
  windowMs: 60_000,
  maxAttemptsPerWindow: 3,
};
