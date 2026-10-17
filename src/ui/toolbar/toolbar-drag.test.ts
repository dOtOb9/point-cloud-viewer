import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD_PX, moveDrag, shouldSuppressClick, startDrag } from "./toolbar-drag";

describe("toolbar-drag", () => {
  it("閾値未満の動きはクリックのまま(スクロールもしない)", () => {
    const r = moveDrag(startDrag(100, 50), 100 + DRAG_THRESHOLD_PX - 1);
    expect(r.scrollLeft).toBeNull();
    expect(shouldSuppressClick(r.state)).toBe(false);
  });

  it("閾値以上はドラッグで、クリックを抑止する", () => {
    const r = moveDrag(startDrag(100, 50), 100 + DRAG_THRESHOLD_PX);
    expect(r.state.dragging).toBe(true);
    expect(shouldSuppressClick(r.state)).toBe(true);
  });

  it("右へ引くとscrollLeftは減り、左へ引くと増える", () => {
    expect(moveDrag(startDrag(100, 50), 130).scrollLeft).toBe(20);
    expect(moveDrag(startDrag(100, 50), 70).scrollLeft).toBe(80);
  });

  it("一度ドラッグになったら、押した位置へ戻してもドラッグのまま", () => {
    const a = moveDrag(startDrag(100, 50), 140);
    const b = moveDrag(a.state, 100);
    expect(shouldSuppressClick(b.state)).toBe(true);
    expect(b.scrollLeft).toBe(50);
  });

  it("動かさずに離したらクリック", () => {
    expect(shouldSuppressClick(startDrag(10, 0))).toBe(false);
  });
});
