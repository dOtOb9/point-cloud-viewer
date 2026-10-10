// AN-2 視点移動（全体表示・ダブルクリックで寄る）の単体テスト。
import { describe, expect, it } from "vitest";
import { OrbitCamera } from "./orbit-camera";
import { TRANSITION_DURATION_MS, easeInOut, shortestAngleDelta } from "./animation";
import { flyToGoal, pickFlyToPoint } from "./fly-to";
import { closestHierarchyHit, type Ray } from "./raycast";

function run(camera: OrbitCamera, totalMs: number, fps: number): void {
  const dt = 1000 / fps;
  const frames = Math.round(totalMs / dt);
  for (let i = 0; i < frames; i++) camera.update(dt);
}

describe("easeInOut", () => {
  it("端点と中点", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 12);
  });
  it("単調増加で、始まりと終わりがゆっくり", () => {
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = easeInOut(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
  });
  it("範囲外は端点に丸める", () => {
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(2)).toBe(1);
  });
});

describe("shortestAngleDelta", () => {
  it("近いほうへ回る", () => {
    expect(shortestAngleDelta(0, Math.PI * 2 - 0.1)).toBeCloseTo(-0.1, 12);
    expect(shortestAngleDelta(Math.PI * 2 + 0.2, 0)).toBeCloseTo(-0.2, 12);
  });
});

describe("OrbitCamera.animateTo", () => {
  it("TRANSITION_DURATION_MSかけて目標に着き、止まる", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.animateTo({ target: [10, 20, 30], distance: 25, yaw: 1, pitch: 0.5 });
    expect(cam.isAnimating()).toBe(true);
    run(cam, TRANSITION_DURATION_MS / 2, 60);
    expect(cam.target[0]).toBeGreaterThan(0);
    expect(cam.target[0]).toBeLessThan(10);
    expect(cam.distance).toBeLessThan(100);
    expect(cam.distance).toBeGreaterThan(25);
    run(cam, TRANSITION_DURATION_MS, 60);
    expect(cam.isAnimating()).toBe(false);
    expect(cam.target).toEqual([10, 20, 30]);
    expect(cam.distance).toBe(25);
    expect(cam.yaw).toBeCloseTo(1, 12);
    expect(cam.pitch).toBe(0.5);
  });

  it("30fpsと144fpsで同じ状態になる", () => {
    const a = new OrbitCamera([0, 0, 0], 100);
    const b = new OrbitCamera([0, 0, 0], 100);
    a.animateTo({ target: [10, 20, 30], distance: 25, yaw: 1 });
    b.animateTo({ target: [10, 20, 30], distance: 25, yaw: 1 });
    // 250msは30fps(7.5)では割り切れないので、中間は250ms=15フレーム/60fps と 250ms=36フレーム/144fps で比べる
    run(a, 250, 60);
    run(b, 250, 144);
    expect(a.target[0]).toBeCloseTo(b.target[0], 9);
    expect(a.distance).toBeCloseTo(b.distance, 9);
    run(a, 2000, 30);
    run(b, 2000, 144);
    expect(a.target).toEqual(b.target);
    expect(a.distance).toBe(b.distance);
    expect(a.yaw).toBeCloseTo(b.yaw, 12);
  });

  it("動きが無効なら即座に移る", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.motionEnabled = false;
    cam.animateTo({ target: [1, 2, 3], distance: 40, yaw: 0.5, pitch: 0.2 });
    expect(cam.isAnimating()).toBe(false);
    expect(cam.target).toEqual([1, 2, 3]);
    expect(cam.distance).toBe(40);
    expect(cam.yaw).toBe(0.5);
    expect(cam.pitch).toBe(0.2);
  });

  it("cancelTransitionでその場に止まる", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.animateTo({ target: [10, 0, 0], distance: 25 });
    run(cam, 100, 60);
    cam.cancelTransition();
    const x = cam.target[0];
    expect(cam.isAnimating()).toBe(false);
    run(cam, 1000, 60);
    expect(cam.target[0]).toBe(x);
  });

  it("yawは近いほうへ回る（一周しない）", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.yaw = Math.PI * 2 - 0.1;
    cam.animateTo({ target: [0, 0, 0], distance: 100, yaw: 0.1 });
    run(cam, 2000, 60);
    expect(cam.yaw).toBeCloseTo(Math.PI * 2 + 0.1, 12);
  });
});

describe("ダブルクリックで寄る行き先", () => {
  const ray: Ray = { origin: [0, 0, 0], direction: [1, 0, 0] };
  const box = (min: [number, number, number], max: [number, number, number]) => ({ boundsMin: min, boundsMax: max });

  it("1ノードなら、既存のレイキャストの交点そのもの", () => {
    const nodes = [box([10, -5, -5], [20, 5, 5])];
    const hit = closestHierarchyHit(ray, nodes);
    expect(hit).toEqual([10, 0, 0]);
    const picked = pickFlyToPoint(ray, nodes);
    expect(picked).toEqual(hit);
    const goal = flyToGoal(picked!, 80);
    expect(goal.target).toEqual(hit);
    expect(goal.distance).toBeLessThan(80);
    expect(goal.distance).toBeGreaterThan(0);
  });

  it("親子が重なるときは、細かい（小さい）箱の交点を選ぶ", () => {
    const parent = box([10, -50, -50], [110, 50, 50]);
    const child = box([40, -5, -5], [50, 5, 5]);
    expect(pickFlyToPoint(ray, [parent, child])).toEqual([40, 0, 0]);
  });

  it("実データの範囲(clip)で箱を切り、空中の面ではなくデータの上端に寄る", () => {
    // 箱はx=10..110だが、実データはx=30..60だけ。切らなければ10に当たる
    const nodes = [box([10, -50, -50], [110, 50, 50])];
    expect(pickFlyToPoint(ray, nodes)).toEqual([10, 0, 0]);
    expect(pickFlyToPoint(ray, nodes, box([30, -50, -50], [60, 50, 50]))).toEqual([30, 0, 0]);
    // 実データの範囲とまったく重ならない箱は無視する
    expect(pickFlyToPoint(ray, nodes, box([200, 0, 0], [300, 1, 1]))).toBeNull();
  });

  it("何にも当たらなければnull", () => {
    expect(pickFlyToPoint(ray, [box([10, 100, 100], [20, 110, 110])])).toBeNull();
    expect(pickFlyToPoint(ray, [])).toBeNull();
  });

  it("寄ったあとのカメラのtargetは交点に一致する", () => {
    const cam = new OrbitCamera([0, 0, 0], 80);
    const hit = pickFlyToPoint(ray, [box([10, -5, -5], [20, 5, 5])])!;
    const goal = flyToGoal(hit, cam.distance);
    cam.animateTo(goal);
    run(cam, 2000, 60);
    expect(cam.target).toEqual(hit);
    expect(cam.distance).toBeCloseTo(goal.distance, 9);
  });
});
