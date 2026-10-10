import { useEffect, useState } from "react";

/**
 * ADR-0017 (AN-3): 出る/消えるときのCSS transitionを、アニメーションライブラリ無しで
 * 実現するための小さなフック。
 *
 * 問題: `open`がfalseになった瞬間にDOMから消すと、閉じるアニメーションが見えない。
 * そこで「DOMに居るか(`mounted`)」と「見せている状態か(`shown`)」を分ける。
 * - 開く: `mounted`をすぐtrueにして描画し、次の描画のあとに`shown`をtrueにする
 *   (最初のフレームは`shown=false`の見た目で描かれ、そこからtransitionが走る)。
 * - 閉じる: `shown`をすぐfalseにし(透明・縮小へtransition)、`exitMs`後に`mounted`をfalseにしてDOMから消す。
 * 呼び出し側は`mounted`がfalseなら何も描かず、`shown`でopacity/transformのクラスを切り替える。
 *
 * - 最初から開いている(`open`の初期値がtrue)ときは、アニメーション無しでそのまま表示する
 *   (起動直後に左パネルが滑り込んだりしないように)。
 * - OSの「視差効果を減らす」(prefers-reduced-motion)が有効なら、待たずに即座に消す
 *   (CSS側もtransition時間を0にしている。index.cssの`--motion-*`)。
 */
export function useTransitionMount(open: boolean, exitMs: number): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(open);

  // 描画中のstate調整(Reactが推奨する書き方。effect内の同期setStateを避けられる)。
  if (open && !mounted) setMounted(true);
  if (!open && entered) setEntered(false);

  useEffect(() => {
    if (!open || entered) return;
    // マウント直後の描画を1フレーム見せてから`entered`にする(2回のrAFで確実に別フレームにする)。
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, entered]);

  useEffect(() => {
    if (open || !mounted) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setMounted(false), reduce ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted, shown: open && entered };
}
