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

/** `updateRefreshIntervalEstimate`が持つ推定状態。 */
export interface RefreshIntervalEstimate {
  /** 推定したリフレッシュ周期(ms)。 */
  intervalMs: number;
}

/**
 * 観測したフレーム間隔から、ディスプレイの実際のリフレッシュ周期(ms)を
 * 推定する。60Hzなら約16.7ms、144Hzなら約6.9msになるはずで、固定値
 * 1000/60を目標にすることをやめるためにこの関数を用意した。
 *
 * **「これまでに観測した最小の間隔」を使う。** 理由: vsync環境では、
 * 1フレームの所要時間は物理的にリフレッシュ周期を下回れない
 * （下回るとしたら1周期のちょうど整数倍か、タイマーの分解能によるごく
 * わずかな誤差のみ）。つまりどれだけ描画が重くても、間隔がリフレッシュ
 * 周期より短くなることは無い。逆に言えば、**一度でも「詰まっていない」
 * フレームに出会えれば、そのときの間隔がほぼ正確なリフレッシュ周期になる。**
 *
 * 直近の短いウィンドウだけを見て最頻値・最小値を取る方式も検討したが、
 * 「負荷が続いている区間全体を短いウィンドウで見てしまうと、その区間の
 * 遅い間隔自体を誤ってリフレッシュ周期だと推定してしまう」という問題が
 * vitestで実際に再現した（`point-budget.test.ts`の回復テストが最初は
 * この理由で失敗した）。負荷が数秒単位で続くことは珍しくない
 * （所有者の診断どおり）ため、ウィンドウの長さでは解決できない。
 * 「一度観測した最小値を覚えておいて、それより小さい値が来たときだけ
 * 更新する」ようにすれば、負荷が続いている間はその値に引きずられず、
 * 一度でも空いた瞬間の値を正しく覚え続けられる。
 *
 * 呼び出し側は毎フレーム、直近フレームの所要時間(ms)でこの関数を呼び、
 * 戻り値を次回の`previous`として渡し続けること（`recordFrameDelta`の中で
 * 呼ぶ想定）。
 *
 * 既知の制限（このタスクの範囲外、[M3-8](../../TaskSheets/M3-release-and-update.md)
 * に送る）:
 * - アプリ実行中にウィンドウを別のリフレッシュレートのディスプレイへ
 *   移動した場合、前のディスプレイで観測した最小値が残り続けて追従しない。
 * - **起動直後の最初の1フレーム目が異常に遅い場合**（シェーダのコンパイル・
 *   パイプライン構築中のGPUストール等）、その値がそのまま推定値として
 *   固定され、以後しばらく本来より緩い(遅い)閾値でミス判定することになる。
 *   ADR-0010で開始値を上限に変更したこととの組み合わせで理論上は起こり得るが、
 *   実際には点群のロード自体に時間がかかるため、開始直後の数フレームは
 *   キャッシュが埋まっておらず描画コスト自体が軽いことが多い
 *   （所有者の実機報告でも、この経路が問題として顕在化した形跡は無い）。
 */
export function updateRefreshIntervalEstimate(
  previous: RefreshIntervalEstimate | null,
  observedFrameDeltaMs: number,
): RefreshIntervalEstimate {
  if (observedFrameDeltaMs <= 0) {
    // 計測誤差等でありえない値が来ても壊れないようにする（防御的）。
    return previous ?? { intervalMs: observedFrameDeltaMs };
  }
  if (previous === null || observedFrameDeltaMs < previous.intervalMs) {
    return { intervalMs: observedFrameDeltaMs };
  }
  return previous;
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
