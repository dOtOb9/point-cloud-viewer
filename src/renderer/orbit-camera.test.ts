// orbit-camera.ts のテスト（M1-5）。
//
// 直した不具合（3点、TaskSheets/M1-point-rendering.md M1-5参照）:
//   1. zoom()は固定のtargetに向かって距離を掛け算で縮めるだけで、カーソル位置とは無関係だった
//   2. そのため寄るほど画面中心（=target）に吸い寄せられ、点群の端にある物に寄れなかった
//   3. pan()の速度が`distance`に比例するため、寄るほどパンも実用にならないくらい遅くなった
//
// ここでは「修正前のロジックに戻すと落ちる」ことを意識してテストを書く。
// 特に「towardPointを渡すとtargetがそちらへ寄っていく」テストは、`zoom(factor)`を
// 単純な`distance *= factor`に戻すと必ず失敗する。

import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective } from "./mat4";
import { OrbitCamera } from "./orbit-camera";
import { pickWorldPointUnderCursor } from "./raycast";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

function distance3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("OrbitCamera.zoom", () => {
  it("towardPointを渡さない場合、従来どおりtargetは動かさずdistanceだけ縮む（フォールバック）", () => {
    const camera = new OrbitCamera([1, 2, 3], 100);
    camera.zoom(0.5);
    expect(camera.target).toEqual([1, 2, 3]);
    expect(camera.distance).toBeCloseTo(50, 9);
  });

  it("towardPointを渡すと、targetがそちらへ寄る（中心ではなくカーソル位置に近づく）", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    const edgePoint: [number, number, number] = [50, 0, 0]; // 点群の端にある物、のつもり

    const beforeDistanceToEdge = distance3(camera.target, edgePoint);
    camera.zoom(0.5, edgePoint);
    const afterDistanceToEdge = distance3(camera.target, edgePoint);

    // targetは[0,0,0]のままではなく、edgePoint側へ動いているはず。
    expect(camera.target).not.toEqual([0, 0, 0]);
    expect(afterDistanceToEdge).toBeLessThan(beforeDistanceToEdge);
  });

  it("towardPointがtargetと一致するときは、targetは動かない（中心を指しているときは旧来の動きと一致）", () => {
    const camera = new OrbitCamera([5, 5, 5], 100);
    camera.zoom(0.5, [5, 5, 5]);
    expect(camera.target[0]).toBeCloseTo(5, 9);
    expect(camera.target[1]).toBeCloseTo(5, 9);
    expect(camera.target[2]).toBeCloseTo(5, 9);
  });

  it("寄り続けても止まらない: 同じ点へ向けてズームし続けると、targetとの距離が単調に縮み続ける", () => {
    const camera = new OrbitCamera([0, 0, 0], 1000);
    const edgePoint: [number, number, number] = [500, 0, 0];

    let previousGap = distance3(camera.target, edgePoint);
    let sawProgressEveryTick = true;

    for (let i = 0; i < 60; i++) {
      camera.zoom(1 / 1.1, edgePoint); // ZOOM_STEPの逆数相当（ズームイン）
      const gap = distance3(camera.target, edgePoint);
      if (!(gap < previousGap)) {
        sawProgressEveryTick = false;
      }
      previousGap = gap;
    }

    // 60回ズームインした後、targetは edgePoint のごく近くまで寄っているはず
    // （固定のtargetに漸近するだけの旧実装では、targetとedgePointの距離は
    //  500から一切縮まらない）。
    expect(sawProgressEveryTick).toBe(true);
    expect(previousGap).toBeLessThan(2); // 500 → 60ティックで1/150以下まで縮む
  });

  it("交差が無い（空を指している）場合の呼び出しでは、targetを固定のtowardPointに寄せてしまわない", () => {
    // pickPointUnderCursorがnullを返すケースをシミュレート: 呼び出し側はtowardPointを
    // 渡さずにzoom()を呼ぶ想定。target不変・distance縮小のみになることを確認する。
    const camera = new OrbitCamera([10, 20, 30], 200);
    camera.zoom(1 / 1.1);
    expect(camera.target).toEqual([10, 20, 30]);
    expect(camera.distance).toBeCloseTo(200 / 1.1, 6);
  });

  it("M1-5の回帰: pickWorldPointUnderCursorが返すtowardPointはカメラ位置と一致せず、targetがカメラへ吸い寄せられない", () => {
    // 所有者の実機報告「逆に近づかなくなった」を、raycastとOrbitCameraを繋いだ形で
    // 再現する。カメラは点群のルートAABBの内側にいて、その内側に前方の面(child)が
    // ある。修正前は交点＝カメラ位置になり、zoom()のtarget += (towardPoint - target)
    // でtargetがカメラへ寄っていってしまっていた。
    const eye: [number, number, number] = [0, 0, 0];
    const camera = new OrbitCamera([0, 0, -50], 50); // targetは前方遠くに置く
    const view = lookAt(eye, [0, 0, -1], [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    const root = { boundsMin: [-100, -100, -100] as const, boundsMax: [100, 100, 100] as const }; // カメラを内包
    const child = { boundsMin: [-2, -2, -5] as const, boundsMax: [2, 2, -3] as const }; // 前方の面、カメラは含まない

    const towardPoint = pickWorldPointUnderCursor(
      viewProj,
      CANVAS_WIDTH / 2,
      CANVAS_HEIGHT / 2,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      [root, child],
    );
    expect(towardPoint).not.toBeNull();

    const distanceFromEye = Math.hypot(
      towardPoint![0] - eye[0],
      towardPoint![1] - eye[1],
      towardPoint![2] - eye[2],
    );
    expect(distanceFromEye).toBeGreaterThan(1); // カメラ位置そのものではない

    camera.zoom(0.9, towardPoint!);
    const targetAfter = camera.target;

    // targetはtowardPoint（カメラ前方の面、eyeから3〜5離れた位置）へ少し寄るだけで、
    // eye(カメラ位置)まで一気に吸い寄せられてはいない。
    // 修正前は towardPoint が eye そのものだったため、target は毎ズームでeyeへ
    // 直行し、「距離を詰めても対象に近づかない」（所有者の実機報告）状態になっていた。
    const distanceFromEyeAfter = Math.hypot(
      targetAfter[0] - eye[0],
      targetAfter[1] - eye[1],
      targetAfter[2] - eye[2],
    );
    expect(distanceFromEyeAfter).toBeGreaterThan(10);
  });
});

describe("OrbitCamera.pan", () => {
  it("シーンスケール未設定なら、パン速度は従来どおりdistanceに比例する（既存挙動の回帰確認）", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    camera.pan(10, 0);
    // yaw=0, pitch=0.3のデフォルト姿勢でのforward/right/upから求めた期待値。
    // 実装のspeed = distance * 0.0015 = 0.15 を使って、この移動量を独立に計算する。
    const speed = 100 * 0.0015;
    const expectedMagnitude = Math.hypot(10 * speed, 0);
    const movedMagnitude = distance3(camera.target, [0, 0, 0]);
    expect(movedMagnitude).toBeCloseTo(expectedMagnitude, 6);
  });

  it("寄った状態（distanceが極小）でも、シーンスケールを設定していれば実用的な速度でパンできる", () => {
    const camera = new OrbitCamera([0, 0, 0], 1000);
    camera.setSceneScale(1000); // シーン全体の対角線が1000

    camera.distance = 0.0001; // 寄り切った状態をシミュレート

    camera.pan(10, 0);
    const moved = distance3(camera.target, [0, 0, 0]);

    // distanceだけを使うと 0.0001 * 0.0015 * 10 ≈ 1.5e-6 という無視できる移動量になる。
    // シーンスケール由来の下限（1000 * 0.0005 = 0.5）が効いていれば、その基準の速度で動くはず。
    const speedWithoutFloor = 0.0001 * 0.0015;
    const naiveMagnitude = 10 * speedWithoutFloor;
    expect(moved).toBeGreaterThan(naiveMagnitude * 100); // 少なくとも桁違いに大きい

    const speedWithFloor = 1000 * 0.0005 * 0.0015;
    expect(moved).toBeCloseTo(10 * speedWithFloor, 9);
  });

  it("シーンスケールを設定していても、distanceがそれより大きいうちは従来どおりdistance基準の速度になる", () => {
    const camera = new OrbitCamera([0, 0, 0], 1000);
    camera.setSceneScale(1000); // 下限は 1000 * 0.0005 = 0.5
    camera.distance = 50; // 下限(0.5)よりずっと大きい

    camera.pan(10, 0);
    const moved = distance3(camera.target, [0, 0, 0]);
    const expected = 10 * (50 * 0.0015);
    expect(moved).toBeCloseTo(expected, 6);
  });
});

describe("OrbitCamera.rotate (既存挙動の回帰確認、M1-5では変更していない)", () => {
  it("yawが加算され、pitchがクランプされる", () => {
    const camera = new OrbitCamera([0, 0, 0], 100);
    camera.rotate(0.1, 10); // pitchを極端に大きくしてクランプさせる
    expect(camera.yaw).toBeCloseTo(0.1, 9);
    expect(camera.pitch).toBeLessThan(Math.PI / 2);
  });
});
