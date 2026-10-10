// AN-2 カメラの動き（慣性・なめらかなズーム・視点移動）の単体テスト。
import { describe, expect, it } from "vitest";
import { OrbitCamera } from "./orbit-camera";
import { INERTIA_TAU_MS, VelocityTracker } from "./animation";

/** 合計totalMsを、1フレームfps分の1秒ずつ進める。 */
function run(camera: OrbitCamera, totalMs: number, fps: number): void {
  const dt = 1000 / fps;
  const frames = Math.round(totalMs / dt);
  for (let i = 0; i < frames; i++) camera.update(dt);
}

describe("AN-2 慣性", () => {
  it("減速して、やがて止まる", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.startRotateInertia(3, 0);
    expect(cam.isAnimating()).toBe(true);
    let prevStep = Infinity;
    for (let i = 0; i < 5; i++) {
      const before = cam.yaw;
      run(cam, 100, 60);
      const step = cam.yaw - before;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(prevStep); // 毎回、進みが小さくなる
      prevStep = step;
    }
    run(cam, 10_000, 60);
    expect(cam.isAnimating()).toBe(false);
    const stopped = cam.yaw;
    run(cam, 1000, 60);
    expect(cam.yaw).toBe(stopped);
  });

  it("パンの慣性も止まる", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.startPanInertia(500, 0);
    const start = [...cam.target];
    run(cam, 10_000, 60);
    expect(cam.isAnimating()).toBe(false);
    expect(Math.hypot(cam.target[0] - start[0], cam.target[1] - start[1], cam.target[2] - start[2])).toBeGreaterThan(0);
  });

  it("新しい操作(cancelInertia)で即座に止まる", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.startRotateInertia(3, 1);
    run(cam, 50, 60);
    cam.cancelInertia();
    expect(cam.isAnimating()).toBe(false);
    const yaw = cam.yaw;
    run(cam, 500, 60);
    expect(cam.yaw).toBe(yaw);
  });

  it("30fpsと144fpsで同じ終状態になる（dt非依存）", () => {
    const a = new OrbitCamera([0, 0, 0], 100);
    const b = new OrbitCamera([0, 0, 0], 100);
    a.startRotateInertia(2, 0.3);
    b.startRotateInertia(2, 0.3);
    // 500msは30fps(15フレーム)でも144fps(72フレーム)でもちょうど割り切れる
    run(a, 500, 30);
    run(b, 500, 144);
    const expectYaw = 2 * (INERTIA_TAU_MS / 1000) * (1 - Math.exp(-500 / INERTIA_TAU_MS));
    expect(a.yaw).toBeCloseTo(expectYaw, 9);
    expect(b.yaw).toBeCloseTo(expectYaw, 9);
    expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(1e-9);
    expect(Math.abs(a.pitch - b.pitch)).toBeLessThan(1e-9);
  });

  it("動きが無効なら慣性を始めない（今までどおり）", () => {
    const cam = new OrbitCamera([0, 0, 0], 100);
    cam.motionEnabled = false;
    cam.startRotateInertia(3, 0);
    cam.startPanInertia(500, 0);
    expect(cam.isAnimating()).toBe(false);
    run(cam, 500, 60);
    expect(cam.yaw).toBe(0);
  });
});

describe("VelocityTracker", () => {
  it("直近の位置から速度を出す", () => {
    const t = new VelocityTracker();
    t.add(0, 0, 0);
    t.add(50, 25, 0);
    t.add(100, 50, 0);
    const [vx, vy] = t.velocity(110);
    expect(vx).toBeCloseTo(500, 6);
    expect(vy).toBeCloseTo(0, 6);
  });

  it("止めてから離した(最後の動きが古い)なら速度0", () => {
    const t = new VelocityTracker();
    t.add(0, 0, 0);
    t.add(50, 25, 0);
    expect(t.velocity(500)).toEqual([0, 0]);
  });

  it("サンプルが1つ以下なら速度0", () => {
    const t = new VelocityTracker();
    expect(t.velocity(0)).toEqual([0, 0]);
    t.add(0, 1, 1);
    expect(t.velocity(1)).toEqual([0, 0]);
  });
});
