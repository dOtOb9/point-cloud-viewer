// ADR-0010: 点予算の自動調整（タスクB、ADR-0009由来）を「vsyncに間に合っているか」
// を信号にしたAIMD（Additive Increase / Multiplicative Decrease。緩やかに増やし、
// 外したら大きく減らす）に作り直したもの。ここではその閉ループの計算だけを、
// WebGPUにもReactにも依存しない純粋関数として切り出す。
//
// 理由: `point-cloud-renderer.ts`はWebGPUデバイスが無いと動かせない
// （規約3的にもReactを知らないが、`init()`はブラウザのWebGPU APIを直接叩く）。
// 閉ループの数式だけを独立したファイルに置けば、レンダラを一切起動せずに
// vitestで検証できる。`point-cloud-renderer.ts`はこの関数を呼んで
// `pointBudget`フィールドに代入するだけにする。
//
// ## なぜ作り直したか（旧実装の何が壊れていたか）
//
// 旧実装（`nextPointBudget`）は、`requestAnimationFrame`のコールバック間隔を
// そのまま「フレームの重さ」として使い、目標フレーム時間（固定で1000/60ms）との
// 差で増減を決めていた。これは60Hzの環境では機能しない。
//
// rAFの間隔はディスプレイのリフレッシュ周期に量子化される（60Hzなら
// 16.7 / 33.3 / 50.0 msなど、必ずその倍数になる）。普通に60fpsが出ている間は
// 間隔は常に16.7ms付近で、これは目標(16.67ms)にほぼ一致するため常に不感帯の
// 「中」に入り続ける。逆に予算を上げる条件（目標を有意に下回る間隔）は、
// 1フレームが16.7msよりさらに速く終わってもrAFは次のvsyncまで待たされるので、
// **60Hzである限り原理的に発生しない**。結果、予算は下がることはあっても
// 二度と上がらないラチェットになっていた。
//
// ## 新しい設計
//
// 間隔の絶対値ではなく、「推定したリフレッシュ周期に対して、そのフレームが
// vsyncに間に合ったかどうか」を信号にする。
//
// 1. `updateRefreshIntervalEstimate`: 観測したフレーム間隔から実際のリフレッシュ
//    周期を推定する（60Hzなら約16.7ms、144Hzなら約6.9msになるはずで、固定値
//    1000/60を目標にすることをやめる）。「これまでの最小値」を使う。
// 2. `evaluatePointBudget`: 直近ウィンドウのうち「推定周期を有意に超えた
//    （＝vsyncを1回以上落とした）」フレームの割合を見て、
//    - 割合が高ければ「外した」→ 大きく下げる（`shrinkRate`）
//    - 割合が十分低い状態が何回か連続すれば「間に合っている」→
//      緩やかに上げる（`growRate`）
//    - その中間は不感帯（増やしも減らしもしない）
//    という判定をする。

/** 点予算の直近の状態。呼び出し側はこれをフィールドとして持ち、
 *  `evaluatePointBudget`の戻り値でそのまま置き換える。 */
export interface PointBudgetState {
  /** 現在の点予算。 */
  budget: number;
  /**
   * 「間に合っている」という評価が何回連続で続いているか。
   * `sustainedHitsToGrow`回に達すると実際に予算を上げ、0に戻る。
   * 「外した」評価が出るとその場で0に戻る（また様子見からやり直す）。
   */
  consecutiveHits: number;
}

export interface PointBudgetLimits {
  /** 下限。これより下げない。 */
  min: number;
  /**
   * 上限。呼び出し側（`point-cloud-renderer.ts`）が
   * `pointBudgetMaxFromMemoryBudget`でメモリ予算から逆算して渡す。
   * この関数自体は上限の決め方を知らない。
   */
  max: number;
}

export interface PointBudgetTuning {
  /**
   * 推定周期の何倍を超えたら、そのフレームは「vsyncを落とした（ミス）」と
   * みなすか。1.5にしておけば、60Hz(周期16.7ms)なら25ms超がミス、
   * 144Hz(周期6.9ms)なら10.4ms超がミスになる。vsync環境では実際のミスは
   * 「ちょうど2倍・3倍…」に量子化されて現れるので、1倍と2倍の中間に
   * 閾値を置けば十分に判別できる。
   */
  missThresholdMultiplier: number;
  /**
   * 直近ウィンドウに占めるミスフレームの割合がこれ以上なら「外した」と
   * 判定し、大きく下げる。
   */
  missRatioToShrink: number;
  /**
   * 直近ウィンドウに占めるミスフレームの割合がこれ以下なら「間に合っている」
   * と判定する。`missRatioToShrink`との間に隙間を空けることで不感帯を作り、
   * 境界付近で上げ下げを繰り返さないようにする（ADR-0009のヒステリシスの
   * 考え方を、フレーム時間の絶対値ではなく「ミス割合」に対して適用したもの）。
   */
  hitRatioToGrow: number;
  /**
   * 「間に合っている」判定が何回連続で続いたら実際に予算を上げるか。
   * 呼び出し側はこれを500ms間隔で評価しているので、
   * 例えば6なら「3秒間、間に合っている状態が続いたら上げる」ことになる。
   * ADR-0009の「上げるときはゆっくり」を、1回あたりの変化率だけでなく
   * 「上げるまでの持続時間」でも表現している。
   */
  sustainedHitsToGrow: number;
  /** 1回の増加で上げる量。現在値に対する割合（例: 0.05 = 5%）。 */
  growRate: number;
  /** 1回の減少で下げる量。現在値に対する割合。`growRate`より大きくして
   *  「上げはゆっくり、下げは速く」にすること（ADR-0009）。 */
  shrinkRate: number;
  limits: PointBudgetLimits;
}

/**
 * `updateRefreshIntervalEstimate`が推定に使う「1世代」の長さ(ms)。
 *
 * ADR-0010追記3で見つかった不具合（後述）への対策として、推定を
 * 「これまで全期間の最小値」から「直近一定期間の最小値」に変えた。
 * この期間をどれだけ長くするかのトレードオフ:
 *
 * - **短すぎる** と、負荷が続く区間（所有者の実機で数秒単位）を
 *   ウィンドウがまるごと覆ってしまい、その区間の遅い間隔自体を
 *   誤ってリフレッシュ周期だと推定してしまう（最初のバグと同じ問題）
 * - **長すぎる** と、異常値やディスプレイの切り替えからの回復が遅くなる
 *
 * 所有者の実機で確認された負荷継続時間（数秒）を十分に上回る値として、
 * 2世代分=30秒（1世代=15秒）を選んだ。**この長さは実測していない、
 * 未検証の初期値。**
 */
export const REFRESH_ESTIMATE_GENERATION_MS = 15_000;

/**
 * `updateRefreshIntervalEstimate`が推定に使う下限(ms)。これより短い観測値は
 * 計測の異常とみなし、推定の更新に使わない。
 *
 * 250Hz（4ms）は、既存の民生ディスプレイのリフレッシュレートとしては
 * かなり高い部類（一般的なゲーミングモニタでも144〜240Hz程度）だが、
 * 将来さらに高いリフレッシュレートの端末が出てくる可能性はあるため、
 * **この値は実測ではなく、いったんの安全側の設計判断。** 万一この値より
 * 高いリフレッシュレートの端末で動かした場合、真のリフレッシュ周期より
 * 少しだけ長く見積もることになるが、それ自体は「ミス判定の閾値が
 * 少し厳しめになる」だけで、下記の一方向ラチェットのような致命的な
 * 壊れ方はしない。
 */
export const MIN_PLAUSIBLE_REFRESH_INTERVAL_MS = 4;

/** `updateRefreshIntervalEstimate`が持つ推定状態。 */
export interface RefreshIntervalEstimate {
  /** 推定したリフレッシュ周期(ms)。呼び出し側はこれだけを読む。 */
  intervalMs: number;
  /** 現在集計中の世代の最小値。 */
  currentGenerationMinMs: number;
  /** 1つ前の世代の最小値。まだ1世代分経っていなければ`Infinity`
   *  （「まだ無い」を表す。`Math.min`にそのまま使えるようにするため）。 */
  previousGenerationMinMs: number;
  /** 現在の世代が始まった時刻(ms)。呼び出し側が渡す`nowMs`と同じ時間軸
   *  （`requestAnimationFrame`のタイムスタンプを想定）。 */
  currentGenerationStartMs: number;
}

/**
 * 観測したフレーム間隔から、ディスプレイの実際のリフレッシュ周期(ms)を
 * 推定する。60Hzなら約16.7ms、144Hzなら約6.9msになるはずで、固定値
 * 1000/60を目標にすることをやめるためにこの関数を用意した。
 *
 * ## 「これまで全期間の最小値」をやめた経緯（ADR-0010追記3）
 *
 * 最初の実装は、一度観測した最小値をそのまま覚え続ける「全期間の最小値」
 * だった。理由: vsync環境では1フレームの所要時間が物理的にリフレッシュ
 * 周期を下回れないため、一度でも「詰まっていない」フレームに出会えれば、
 * その間隔がほぼ正確な周期になるはずだった。
 *
 * **しかしこれは「今回直したのと同じ形の、逆向きのラチェット」だった。**
 * 異常に短い間隔（ウィンドウが非表示から復帰した直後のrAF連続発火、
 * より高リフレッシュレートのディスプレイへウィンドウを移動した直後、
 * WebView2のリサイズ・オクルージョン変化に伴う不規則なタイミングなど）が
 * **一度でも**観測されると、その小さい値に永久に固定される。推定値が
 * 例えば2msに固定されると、`missThresholdMultiplier`(1.5)によりミス判定の
 * 閾値が3msになり、60Hzの通常の16.7msフレームが**すべて**ミス扱いになる。
 * その結果`missRatio`が常に1.0となって点予算が下限に張り付き、増加条件
 * （`missRatio ≤ hitRatioToGrow`）は推定値が壊れている限り永久に満たせない
 * ため、二度と回復しない。所有者に見える症状は最初のラチェットと同じ
 * （「近くのチャンクが精緻にならない」）になる。
 *
 * ## 新しい設計: 直近2世代（既定30秒）の最小値
 *
 * 「全期間」ではなく「直近一定時間」の最小値にすることで、異常値がいずれ
 * 期間の外へ出ていき、推定値が**上にも戻れる**ようにした。
 * `REFRESH_ESTIMATE_GENERATION_MS`(15秒)ごとに世代を交代し、常に
 * 「現世代」と「1つ前の世代」の2世代分の最小値を持つ。推定値は両世代の
 * 最小値のうち小さいほう。こうすると、ウィンドウが短すぎて負荷継続区間を
 * 誤検出する問題（最初のバグ）を避けつつ、異常値も高々2世代（最大30秒）で
 * 押し出される。
 *
 * あわせて、`MIN_PLAUSIBLE_REFRESH_INTERVAL_MS`より短い観測値は
 * 計測異常とみなして推定の材料にしない（一方向ラチェットへの二重の備え）。
 *
 * 呼び出し側は毎フレーム、直近フレームの所要時間(ms)と現在時刻(ms、
 * `requestAnimationFrame`のタイムスタンプ)でこの関数を呼び、戻り値を
 * 次回の`previous`として渡し続けること（`recordFrameDelta`の中で呼ぶ想定）。
 *
 * 既知の制限（このタスクの範囲外、[M3-8](../../TaskSheets/M3-release-and-update.md)
 * に送る）:
 * - リフレッシュレートの変化（ディスプレイの切り替え等）への追従には、
 *   最悪の場合`REFRESH_ESTIMATE_GENERATION_MS`の2倍（既定30秒）かかる。
 *   これは意図的なトレードオフ（短くしすぎると最初のバグが再発するため）
 * - `MIN_PLAUSIBLE_REFRESH_INTERVAL_MS`(4ms)より高いリフレッシュレートの
 *   端末では、真の周期よりわずかに長く見積もる（上記コメント参照）
 */
export function updateRefreshIntervalEstimate(
  previous: RefreshIntervalEstimate | null,
  observedFrameDeltaMs: number,
  nowMs: number,
): RefreshIntervalEstimate {
  // 物理的にありえない短さは計測異常とみなし、下限で切り上げる。
  const clampedDeltaMs = Math.max(observedFrameDeltaMs, MIN_PLAUSIBLE_REFRESH_INTERVAL_MS);

  if (previous === null) {
    return {
      intervalMs: clampedDeltaMs,
      currentGenerationMinMs: clampedDeltaMs,
      previousGenerationMinMs: Infinity, // まだ1つ前の世代が無い
      currentGenerationStartMs: nowMs,
    };
  }

  let { currentGenerationMinMs, previousGenerationMinMs, currentGenerationStartMs } = previous;

  if (nowMs - currentGenerationStartMs >= REFRESH_ESTIMATE_GENERATION_MS) {
    // 世代交代: 現世代を「1つ前」に格上げし、新しい世代をこの観測値から始める。
    previousGenerationMinMs = currentGenerationMinMs;
    currentGenerationMinMs = clampedDeltaMs;
    currentGenerationStartMs = nowMs;
  } else {
    currentGenerationMinMs = Math.min(currentGenerationMinMs, clampedDeltaMs);
  }

  return {
    intervalMs: Math.min(currentGenerationMinMs, previousGenerationMinMs),
    currentGenerationMinMs,
    previousGenerationMinMs,
    currentGenerationStartMs,
  };
}

/**
 * 直近ウィンドウのフレーム間隔から、次の点予算の状態を返す純粋関数。
 *
 * - 推定周期(`refreshIntervalMs`)の`missThresholdMultiplier`倍を超えた
 *   フレームの割合が`missRatioToShrink`以上なら「外した」→
 *   `shrinkRate`の割合だけ即座に下げ、連続ヒット数を0に戻す
 * - その割合が`hitRatioToGrow`以下なら「間に合っている」→連続ヒット数を
 *   1増やし、`sustainedHitsToGrow`に達していたら`growRate`の割合だけ上げて
 *   連続ヒット数を0に戻す（達していなければ予算はまだ変えない）
 * - その中間（不感帯）なら、予算はそのまま。連続ヒット数は0に戻す
 *   （「間に合っている」が申告どおり連続していないと数えない）
 * - 結果の予算は必ず`limits.min`〜`limits.max`に収める
 *
 * 呼び出し側は`recentFrameDeltasMs`に単発の重いフレーム（ノード到着時など）
 * だけを混ぜないよう、直近数十フレームのウィンドウを渡すこと。
 */
export function evaluatePointBudget(
  state: PointBudgetState,
  recentFrameDeltasMs: readonly number[],
  refreshIntervalMs: number,
  tuning: PointBudgetTuning,
): PointBudgetState {
  if (recentFrameDeltasMs.length === 0) return state;

  const missThresholdMs = refreshIntervalMs * tuning.missThresholdMultiplier;
  const missCount = recentFrameDeltasMs.filter((deltaMs) => deltaMs > missThresholdMs).length;
  const missRatio = missCount / recentFrameDeltasMs.length;

  if (missRatio >= tuning.missRatioToShrink) {
    // 外した: 速やかに下げる。また様子見からやり直す。
    return {
      budget: clamp(Math.round(state.budget * (1 - tuning.shrinkRate)), tuning.limits),
      consecutiveHits: 0,
    };
  }

  if (missRatio > tuning.hitRatioToGrow) {
    // 不感帯: 外してはいないが、「間に合っている」と胸を張れるほどでもない。
    // 増やしも減らしもしない。連続ヒットは途切れたものとしてリセットする。
    return { budget: state.budget, consecutiveHits: 0 };
  }

  // 間に合っている。
  const consecutiveHits = state.consecutiveHits + 1;
  if (consecutiveHits >= tuning.sustainedHitsToGrow) {
    return {
      budget: clamp(Math.round(state.budget * (1 + tuning.growRate)), tuning.limits),
      consecutiveHits: 0,
    };
  }
  return { budget: state.budget, consecutiveHits };
}

function clamp(value: number, limits: PointBudgetLimits): number {
  return Math.min(limits.max, Math.max(limits.min, value));
}

/**
 * メモリ予算(バイト)から、点予算の上限を逆算する。
 *
 * `node-cache.ts`のキャッシュは、点予算そのものではなく
 * `点予算 × cacheBudgetMultiplier`点分のバッファをGPUメモリに保持する
 * （視点を少し動かしただけで直前まで見えていたノードを再取得しないための
 * 余裕分。`point-cloud-renderer.ts`の`CACHE_BUDGET_MULTIPLIER`）。
 * つまり実際にメモリを使うのは点予算ではなくその`cacheBudgetMultiplier`倍
 * なので、上限を決めるにはそこから逆算する必要がある:
 *
 * ```
 * 上限点数 = メモリ予算バイト数 / (1点あたりのバイト数 × cacheBudgetMultiplier)
 * ```
 */
export function pointBudgetMaxFromMemoryBudget(
  memoryBudgetBytes: number,
  pointStrideBytes: number,
  cacheBudgetMultiplier: number,
): number {
  return Math.floor(memoryBudgetBytes / (pointStrideBytes * cacheBudgetMultiplier));
}

/**
 * `evaluatePointBudget`のデフォルトの調整パラメータ（`limits`を除く。
 * `limits`は呼び出し側がメモリ予算等から決めて渡す）。
 *
 * **これらの数値は実測していない。** ADR-0009の設計方針（上げより下げを
 * 速くする・不感帯を設ける）を満たす形で経験的に選んだ初期値であり、
 * 実機でのチューニングが別途必要（未検証）。
 *
 * ## 追記（ADR-0010、所有者の実機で確定した事実を受けての修正）
 *
 * 所有者の実機では、開始値だった`hitRatioToGrow: 0`（ミスフレームが厳密に0の
 * ときしか「間に合っている」を積まない）が実質的に機能不全だった。カメラ操作中は
 * ノード到着などで単発のミスフレームが混ざりやすく、
 * `sustainedHitsToGrow`回連続でミス0を達成できる場面がほとんど無いため、
 * 点予算が一度も増えなかった（下がったのではなく、そもそも動かなかった）。
 *
 * `hitRatioToGrow`を0より大きくし（直近ウィンドウが20フレーム想定なら
 * 1/20=5%までは「1フレームのミス」として許容する）、単発のノイズで
 * 連続ヒット数がリセットされないようにした。あわせて、`missRatioToShrink`
 * (15%=3/20)との間に実際に成立する不感帯（10%=2/20がちょうど収まる）を
 * 残すため、こちらも0.1から0.15へ調整した。
 *
 * また、呼び出し側（`point-cloud-renderer.ts`）の開始値を、以前の固定値
 * 3,000,000（症状の直接の原因だった）から`AUTO_POINT_BUDGET_MAX`（上限）へ
 * 変更した。**低い値から上限を探り上げるのではなく、楽観的に上限から始めて
 * 「外したら即座に大きく下げる」側で実機に合った値を素早く見つけるほうが、
 * 体感が良い。** これに伴い、上げる側（`growRate`/`sustainedHitsToGrow`）は
 * 「開始直後に効く」役割ではなく「一時的に下がった後の緩やかな回復」役割が
 * 主になったため、`sustainedHitsToGrow`を6→3、`growRate`を0.05→0.1に
 * 変更し、それでも`shrinkRate`(0.2)より遅い、という非対称性は保っている。
 * 具体的な到達秒数の計算は`point-cloud-renderer.ts`の
 * `AUTO_POINT_BUDGET_MIN`/`MAX`近くのコメントを参照。
 */
export const DEFAULT_POINT_BUDGET_TUNING: Omit<PointBudgetTuning, "limits"> = {
  missThresholdMultiplier: 1.5, // 未検証の初期値（1倍と2倍の中間）
  missRatioToShrink: 0.15, // 未検証の初期値（直近ウィンドウ20フレーム換算で3/20=15%以上がミスなら「外した」）
  hitRatioToGrow: 0.05, // 未検証の初期値（20フレーム換算で1/20=5%までは単発ミスとして許容する）
  sustainedHitsToGrow: 3, // 未検証の初期値（500ms間隔の呼び出しを想定し、1.5秒間の持続を要求）
  growRate: 0.1, // 未検証の初期値（10%/回。開始値を上限にしたため、増加は主に一時的な低下からの回復用）
  shrinkRate: 0.2, // 未検証の初期値（20%/回、growRateより大きく＝速く下げる）
};
