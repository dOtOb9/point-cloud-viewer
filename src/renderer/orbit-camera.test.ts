import { describe, expect, it } from "vitest";
import { OrbitCamera } from "./orbit-camera";

function distance3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function sub3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize3(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function isParallel(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  const cross: [number, number, number] = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  return Math.hypot(cross[0], cross[1], cross[2]) < 1e-6;
}

describe("OrbitCamera.zoom", () => {
  it("cursorDirectionを渡さない場合、targetは動かさずdistanceだけ縮む（フォールバック）", () => {
    const camera = new OrbitCamera([1, 2, 3], 100);
    camera.zoom(0.5);
    expect(camera.target).toEqual([1, 2, 3]);
    expect(camera.distance).toBeCloseTo(50, 9);
  });

  it("cursorDirectionを渡すと、targetがその方向へ動く", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    const direction: [number, number, number] = [1, 0, 0];

    camera.zoom(0.5, direction);

    expect(camera.target[0]).toBeCloseTo(50, 9);
    expect(camera.target[1]).toBeCloseTo(0, 9);
    expect(camera.target[2]).toBeCloseTo(0, 9);
    expect(camera.distance).toBeCloseTo(50, 9);
  });

  it("移動量はdistanceに比例する: 同じfactorなら、distanceが違っても比率(1-factor)は変わらない", () => {
    const direction: [number, number, number] = [0, 0, 1];
    const factor = 0.8;

    const small = new OrbitCamera([0, 0, 0], 10);
    small.zoom(factor, direction);
    const large = new OrbitCamera([0, 0, 0], 1000);
    large.zoom(factor, direction);

    expect(small.target[2] / 10).toBeCloseTo(1 - factor, 9);
    expect(large.target[2] / 1000).toBeCloseTo(1 - factor, 9);
  });

  it("寄り続けても1ティックの移動量が独立に潰れない: 100回ズームインしても、毎回 distance*(1-factor) だけ動く", () => {
    const camera = new OrbitCamera([0, 0, 0], 1_000_000);
    const direction: [number, number, number] = [1, 0, 0];
    const factor = 1 / 1.1;

    let previousDistance = camera.distance;
    for (let i = 0; i < 100; i++) {
      const before: [number, number, number] = [...camera.target];
      camera.zoom(factor, direction);
      const moved = distance3(camera.target, before);

      const expectedMoved = previousDistance * (1 - factor);
      expect(moved).toBeCloseTo(expectedMoved, 6);

      previousDistance = camera.distance;
    }

    expect(camera.distance).toBeLessThan(1_000_000 * Math.pow(factor, 99));
  });

  it("カーソルが画面中心のとき: 従来どおりtarget方向に寄る挙動と一致する（eyeとtargetが同じ視線軸上を動く）", () => {
    const camera = new OrbitCamera([0, 0, -100], 50);
    const eyeBefore = camera.eye();
    const forward = normalize3(sub3(camera.target, eyeBefore));

    camera.zoom(0.9, forward);
    const eyeAfter = camera.eye();

    expect(isParallel(sub3(eyeAfter, eyeBefore), forward)).toBe(true);

    expect(camera.distance).toBeCloseTo(50 * 0.9, 9);
  });

  it("画面中心へ向けてズームし続けても、eyeとtargetの間隔（distance）は0に漸近するだけで、動き自体は止まらない", () => {
    const camera = new OrbitCamera([0, 0, -1000], 200);
    let previousDistance = camera.distance;
    for (let i = 0; i < 50; i++) {
      const eyeBefore = camera.eye();
      const forward = normalize3(sub3(camera.target, eyeBefore));
      camera.zoom(0.9, forward);
      expect(camera.distance).toBeLessThan(previousDistance);
      previousDistance = camera.distance;
    }
  });
});

describe("OrbitCamera.pan", () => {
  it("シーンスケール未設定なら、パン速度は従来どおりdistanceに比例する（既存挙動の回帰確認）", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    camera.pan(10, 0);
    const speed = 100 * 0.0015;
    const expectedMagnitude = Math.hypot(10 * speed, 0);
    const movedMagnitude = distance3(camera.target, [0, 0, 0]);
    expect(movedMagnitude).toBeCloseTo(expectedMagnitude, 6);
  });

  it("寄った状態（distanceが極小）でも、シーンスケールを設定していれば実用的な速度でパンできる", () => {
    const camera = new OrbitCamera([0, 0, 0], 1000);
    camera.setSceneScale(1000);

    camera.distance = 0.0001;

    camera.pan(10, 0);
    const moved = distance3(camera.target, [0, 0, 0]);

    const speedWithoutFloor = 0.0001 * 0.0015;
    const naiveMagnitude = 10 * speedWithoutFloor;
    expect(moved).toBeGreaterThan(naiveMagnitude * 100);

    const speedWithFloor = 1000 * 0.0005 * 0.0015;
    expect(moved).toBeCloseTo(10 * speedWithFloor, 9);
  });

  it("シーンスケールを設定していても、distanceがそれより大きいうちは従来どおりdistance基準の速度になる", () => {
    const camera = new OrbitCamera([0, 0, 0], 1000);
    camera.setSceneScale(1000);
    camera.distance = 50;

    camera.pan(10, 0);
    const moved = distance3(camera.target, [0, 0, 0]);
    const expected = 10 * (50 * 0.0015);
    expect(moved).toBeCloseTo(expected, 6);
  });
});

describe("OrbitCamera.rotate (既存挙動の回帰確認、M1-5では変更していない)", () => {
  it("yawが加算され、pitchがクランプされる", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    camera.rotate(0.1, 10);
    expect(camera.yaw).toBeCloseTo(0.1, 9);
    expect(camera.pitch).toBeLessThan(Math.PI / 2);
  });
});

describe("OrbitCamera 上方向 (M2-0b)", () => {
  it("既定の上方向はZ（[0,0,1]）: LAS/COPCは投影座標系なのでZが標高（段階3）", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    expect(camera.getUpAxis()).toEqual([0, 0, 1]);
  });

  it("既定の姿勢(pitch=0.3, upAxis=Z)は真上からの俯瞰ではなく、少し見下ろす角度になる", () => {
    const camera = new OrbitCamera([0, 0, 0], 1000);
    const eye = camera.eye();
    const horizontalDistance = Math.hypot(eye[0] - camera.target[0], eye[1] - camera.target[1]);
    const height = Math.abs(eye[2] - camera.target[2]);
    expect(height / horizontalDistance).toBeCloseTo(Math.tan(0.3), 6);
    expect(height / horizontalDistance).toBeLessThan(1);
  });

  it("pitch=0のとき、eyeからtargetへの視線方向は上方向(upAxis)と直交する（＝水平）", () => {
    for (const up of [
      [0, 1, 0],
      [0, 0, 1],
    ] as const) {
      const camera = new OrbitCamera([0, 0, 0], 100);
      camera.setUpAxis(up);
      camera.pitch = 0;
      const eye = camera.eye();
      const forward = normalize3(sub3(camera.target, eye));
      const dot = forward[0] * up[0] + forward[1] * up[1] + forward[2] * up[2];
      expect(dot).toBeCloseTo(0, 9);
    }
  });

  it("pitch=±90°(クランプ直前)のとき、視線はほぼ上方向(upAxis)と平行になる", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    camera.setUpAxis([0, 0, 1]);
    camera.pitch = Math.PI / 2 - 0.01;
    const eye = camera.eye();
    const forward = normalize3(sub3(camera.target, eye));
    const dot = forward[0] * 0 + forward[1] * 0 + forward[2] * 1;
    expect(Math.abs(dot)).toBeGreaterThan(0.999);
  });

  it("setUpAxis()でカメラを追従させると、上方向を変えてもeyeとtargetの距離(distance)は変わらない", () => {
    const camera = new OrbitCamera([1, 2, 3], 50);
    camera.pitch = 0.4;
    camera.yaw = 1.1;
    const before = distance3(camera.eye(), camera.target);
    camera.setUpAxis([0, 0, 1]);
    const after = distance3(camera.eye(), camera.target);
    expect(after).toBeCloseTo(before, 9);
    expect(after).toBeCloseTo(50, 9);
  });

  it("pan()も設定した上方向を使う: upAxisをZにすると、パンは新しい水平面（XY平面）内で動く", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    camera.setUpAxis([0, 0, 1]);
    camera.pitch = 0;

    camera.pan(0, 10);

    expect(camera.target[2]).not.toBeCloseTo(0, 6);
    expect(Math.abs(camera.target[2])).toBeGreaterThan(0);
  });
});
