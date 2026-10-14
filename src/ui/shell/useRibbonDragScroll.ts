import { useEffect, useRef } from "react";
import { moveDrag, shouldSuppressClick, startDrag, type DragState } from "./ribbon-drag";

/**
 * L1-A: リボンの横スクロールに「マウス左ボタンのドラッグ」と「ホイール縦回転→横」を足す。
 * 判定そのものは ribbon-drag.ts(純粋関数)。ここはDOMイベントとの接続だけ。
 * タッチは素のoverflow-xで動くので扱わない(pointerType==="mouse"のときだけ働く)。
 *
 * ポインタキャプチャは使わず、押している間だけwindowにmove/upを付ける。
 * キャプチャするとclickの宛先が変わり、閾値未満のクリックまで壊れうるため。
 * ドラッグ後のclickは、返り値のonClickCaptureが握りつぶす。
 */
export function useRibbonDragScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let drag: DragState | null = null;

    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const r = moveDrag(drag, e.clientX);
      drag = r.state;
      if (r.scrollLeft !== null) el.scrollLeft = r.scrollLeft;
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    function onUp() {
      if (drag) suppressClick.current = shouldSuppressClick(drag);
      drag = null;
      stop();
      // clickはpointerupの直後に同期で来る。ボタンの外で離してclickが来ない場合に備え、その後で解除する。
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      suppressClick.current = false;
      drag = startDrag(e.clientX, el.scrollLeft);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    // 縦のホイールを横スクロールに変える。passive:falseが要るのでReactのonWheelではなく直接付ける。
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("wheel", onWheel);
      stop();
    };
  }, []);

  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick.current = false;
    }
  };

  return { ref, onClickCapture };
}
