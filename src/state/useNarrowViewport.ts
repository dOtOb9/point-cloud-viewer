import { useEffect, useState } from "react";

/**
 * ADR-0017 (UIシェル再構築): ビューポート幅が768px未満かどうか。
 *
 * 768pxはタスクシートの指定値（スマホ〜小さめタブレットの境界として一般的な
 * 値だが、このプロジェクト自身で実測して決めたものではない。未検証の初期値）。
 * この値を境に、リボンはコンパクトなツールバー/メニューに畳まれ、
 * 左パネルはドロワー（開くとオーバーレイで出て、閉じると完全に隠れる）になる
 * （`Ribbon.tsx`/`LayerPanel.tsx`参照）。
 *
 * `matchMedia`の`change`イベントで追従する。`useTheme.ts`の
 * `prefersDark`と同じ形（DOM操作はuseEffect内に閉じ、フック自体は
 * ブラウザAPIが無い環境でも呼べるようフォールバックを持つ）。
 */
export function useNarrowViewport(breakpointPx = 768): boolean {
  const query = `(max-width: ${breakpointPx - 1}px)`;
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof matchMedia === "undefined") return false;
    return matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return narrow;
}
