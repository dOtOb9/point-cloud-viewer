// ADR-0009: 描画設定（まず点予算）は「実測したフレーム時間による閉ループ」で
// 継続的に調整する。ここではその閉ループの計算だけを、WebGPUにもReactにも
// 依存しない純粋関数として切り出す。
//
// 理由: `point-cloud-renderer.ts`はWebGPUデバイスが無いと動かせない
// （規約3的にもReactを知らないが、`init()`はブラウザのWebGPU APIを直接叩く）。
// 閉ループの数式だけを独立したファイルに置けば、レンダラを一切起動せずに
// vitestで検証できる。`point-cloud-renderer.ts`はこの関数を呼んで
// `pointBudget`フィールドに代入するだけにする。

export interface PointBudgetLimits {
  /** 下限。これより下げない。 */
  min: number;
  /**
   * 上限。ADR-0009では「端末情報は初期値と上限を決めるためだけに使う」として
   * いるが、この関数自体は上限の決め方を知らない。呼び出し側が
   * （端末から取れる値・保守的な固定値のどちらでもよいので）決めて渡す。
   */
  max: number;
}

export interface NextPointBudgetOptions {
  /**
   * 目標フレーム時間(ms)。ADR-0009: 「目標はフレーム時間であってfpsではない
   * （fpsは平均で均されて鈍い）」。
   */
  targetFrameMs: number;
  limits: PointBudgetLimits;
  /**
   * 不感帯(ヒステリシス)の幅(ms)。フレーム時間が
   * `targetFrameMs ± deadZoneMs` の範囲に収まっている間は予算を変えない。
   * ADR-0009: 「ヒステリシスを入れる。目標の前後に不感帯を設け、境界で
   * 往復しないようにする」。
   */
  deadZoneMs: number;
  /**
   * 1回の呼び出しで上げる量。現在値に対する割合（例: 0.05 = 5%）。
   * ADR-0009の「上げるときはゆっくり、下げるときは速く」に従い、
   * 呼び出し側は `growRate < shrinkRate` になる値を渡すこと
   * （この関数自体は大小関係を強制しない）。
   */
  growRate: number;
  /** 1回の呼び出しで下げる量。現在値に対する割合。 */
  shrinkRate: number;
}

/**
 * 次のフレームで使う点予算を返す純粋関数。
 *
 * - `recentFrameMs` が `targetFrameMs + deadZoneMs` を超えていたら、
 *   `shrinkRate` の割合だけ下げる（速く下げる）
 * - `recentFrameMs` が `targetFrameMs - deadZoneMs` を下回っていたら、
 *   `growRate` の割合だけ上げる（ゆっくり上げる）
 * - 不感帯の中（そのどちらでもない）なら変えない
 * - 結果は必ず `limits.min`〜`limits.max` に収める
 *
 * 呼び出し側は単発の重いフレーム（ノード到着時など）に反応しないよう、
 * 直近数フレームの**中央値**を`recentFrameMs`として渡すこと（ADR-0009）。
 * この関数自身は「何の値が渡されたか」を判断しない、ただの1ステップの計算。
 */
export function nextPointBudget(current: number, recentFrameMs: number, opts: NextPointBudgetOptions): number {
  const { targetFrameMs, limits, deadZoneMs, growRate, shrinkRate } = opts;

  let next = current;
  if (recentFrameMs > targetFrameMs + deadZoneMs) {
    next = current * (1 - shrinkRate);
  } else if (recentFrameMs < targetFrameMs - deadZoneMs) {
    next = current * (1 + growRate);
  }
  // 不感帯の中: next = current のまま（変えない）

  return clamp(Math.round(next), limits.min, limits.max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 中央値を取るユーティリティ。`nextPointBudget`に渡す`recentFrameMs`を
 * 直近数フレームから作るために使う（単発の重いフレームに反応しないため。
 * ADR-0009）。配列を破壊しない。
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * `nextPointBudget`のデフォルトの調整パラメータ。
 *
 * **これらの数値は実測していない。** ADR-0009の設計方針（目標はフレーム時間・
 * 上げはゆっくり下げは速く・ヒステリシスを入れる）を満たす値として経験的に
 * 選んだ初期値であり、実機でのチューニングが別途必要（未検証）。
 * `targetFrameMs`だけは60fps相当という一般的な基準から機械的に決まる値。
 */
export const DEFAULT_POINT_BUDGET_TUNING: Omit<NextPointBudgetOptions, "limits"> = {
  targetFrameMs: 1000 / 60,
  deadZoneMs: 4, // 未検証の初期値
  growRate: 0.05, // 未検証の初期値（5%/回、ゆっくり上げる）
  shrinkRate: 0.2, // 未検証の初期値（20%/回、growRateより大きく＝速く下げる）
};
