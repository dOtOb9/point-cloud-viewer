// L1-A: リボンの「マウスで押したまま横に引くと動く」判定。Reactに依存しない純粋な関数だけ置く
// (単体テストは ribbon-drag.test.ts)。DOMのイベントとの接続は useRibbonDragScroll.ts。
//
// 考え方: 押した位置と今の位置のX差が閾値(5px)を超えたら「ドラッグ」とみなす。
// ドラッグだったときだけ、離した直後のclickを握りつぶす(ボタンの誤クリック防止)。
// 閾値未満なら普通のクリックとして効く。

/** これ以上(px)動いたらドラッグ。小さな手ぶれでクリックが効かなくならない程度の値(未検証の初期値)。 */
export const DRAG_THRESHOLD_PX = 5;

export interface DragState {
  /** 押した位置のclientX。 */
  startX: number;
  /** 押した時点のscrollLeft。 */
  startScrollLeft: number;
  /** 閾値を一度でも超えたか(超えたら、戻しても「ドラッグだった」まま)。 */
  dragging: boolean;
}

export function startDrag(clientX: number, scrollLeft: number): DragState {
  return { startX: clientX, startScrollLeft: scrollLeft, dragging: false };
}

/** マウスが動いた。新しい状態と、設定すべきscrollLeftを返す(まだドラッグでなければscrollLeftはnull＝動かさない)。 */
export function moveDrag(state: DragState, clientX: number): { state: DragState; scrollLeft: number | null } {
  const dx = clientX - state.startX;
  const dragging = state.dragging || Math.abs(dx) >= DRAG_THRESHOLD_PX;
  if (!dragging) return { state, scrollLeft: null };
  // 指で紙を引く向き: 右へ引くと内容が右へ動く(=scrollLeftは減る)。
  return { state: { ...state, dragging: true }, scrollLeft: state.startScrollLeft - dx };
}

/** 離した直後のclickを握りつぶすべきか。 */
export function shouldSuppressClick(state: DragState): boolean {
  return state.dragging;
}
