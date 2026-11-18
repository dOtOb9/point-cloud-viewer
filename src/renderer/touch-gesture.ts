export interface TouchPoint {
  x: number;
  y: number;
}

export interface TwoPointerGestureDelta {
  panDeltaX: number;
  panDeltaY: number;
  zoomFactor: number;
  midpoint: TouchPoint;
}

function midpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const MIN_DISTANCE = 1e-3;

export function computeTwoPointerGesture(
  prev: readonly [TouchPoint, TouchPoint],
  curr: readonly [TouchPoint, TouchPoint],
): TwoPointerGestureDelta {
  const prevMid = midpoint(prev[0], prev[1]);
  const currMid = midpoint(curr[0], curr[1]);

  const prevDist = Math.max(distance(prev[0], prev[1]), MIN_DISTANCE);
  const currDist = Math.max(distance(curr[0], curr[1]), MIN_DISTANCE);

  return {
    panDeltaX: currMid.x - prevMid.x,
    panDeltaY: currMid.y - prevMid.y,
    zoomFactor: prevDist / currDist,
    midpoint: currMid,
  };
}
