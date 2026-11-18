export const DRAG_THRESHOLD_PX = 5;

export interface DragState {
  startX: number;
  startScrollLeft: number;
  dragging: boolean;
}

export function startDrag(clientX: number, scrollLeft: number): DragState {
  return { startX: clientX, startScrollLeft: scrollLeft, dragging: false };
}

export function moveDrag(state: DragState, clientX: number): { state: DragState; scrollLeft: number | null } {
  const dx = clientX - state.startX;
  const dragging = state.dragging || Math.abs(dx) >= DRAG_THRESHOLD_PX;
  if (!dragging) return { state, scrollLeft: null };
  return { state: { ...state, dragging: true }, scrollLeft: state.startScrollLeft - dx };
}

export function shouldSuppressClick(state: DragState): boolean {
  return state.dragging;
}
