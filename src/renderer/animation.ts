// アニメーション（AN-1 ノードのフェードイン / AN-2 カメラの動き）で使う定数と純粋関数。
// GPU・DOM・OrbitCameraに依存しないので、vitestで直接検証できる。
//
// **ここにある時間・減速の強さ・しきい値は、どれも「未検証の初期値」。**
// 実機（特にAndroid）で触って決めた値ではない。所有者が画面で見て調整する前提で、
// 調整の入口をこのファイルの定数1か所に集めてある（TaskSheets/AN-animation.md）。

// ---- AN-1: ノードのフェードイン（ディザ） --------------------------------

/** 新しく表示するノードが、0→1まで出ていくのにかける時間(ms)。未検証の初期値。 */
export const FADE_IN_DURATION_MS = 250;

/**
 * 表示を始めてからの経過時間(ms)から、フェードの割合(0〜1)を返す。
 * 0のときは点がまったく描かれず、1のときはすべて描かれる。
 * シェーダはこの値を画面上のBayer 4x4のしきい値と比べ、超えない点を捨てる
 * （アルファブレンドではなくディザにした理由はTaskSheets/AN-animation.mdの「AN-1/AN-2 実装」）。
 */
export function fadeInFactor(elapsedMs: number, durationMs: number = FADE_IN_DURATION_MS): number {
  if (!(durationMs > 0)) return 1;
  if (!(elapsedMs > 0)) return 0;
  return Math.min(1, elapsedMs / durationMs);
}

/**
 * ノードごとのフェード係数。
 * - アニメーションが無効（設定オフ・prefers-reduced-motion）なら常に1（いきなり全部出す）
 * - まだ一度も描いていないノード（firstDrawnAtMs === null）は0から始める
 */
export function nodeFadeFactor(firstDrawnAtMs: number | null, nowMs: number, motionEnabled: boolean): number {
  if (!motionEnabled) return 1;
  if (firstDrawnAtMs === null) return 0;
  return fadeInFactor(nowMs - firstDrawnAtMs);
}

// ---- 共通: 動きを許すかどうか ---------------------------------------------

/** OSの「視差効果を減らす」が有効か。matchMediaが無い環境（vitestのnode等）ではfalse。 */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== "function") return false;
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 設定がオンで、かつOSが動きを減らす指定をしていないときだけ、動きを使う。 */
export function resolveMotionEnabled(settingEnabled: boolean, reducedMotion: boolean): boolean {
  return settingEnabled && !reducedMotion;
}
