// orbit-camera.ts のテスト（M1-5）。
//
// M1-5は3回書き直している。今回（3回目）で方式そのものを変えた。
//
// 1回目: zoom()は固定のtargetに向かって距離を掛け算で縮めるだけで、カーソル位置とは
//        無関係だった → 寄るほど画面中心に吸い寄せられ、点群の端にある物に寄れなかった
// 2回目: 「カーソルの下にある点」をoctreeのAABBへのレイキャストで求め、zoom()に渡す
//        方式にした → 実装上のバグ（レイ原点がAABB内側にあると交点=カメラ位置になる、
//        内部ノードの入れ子AABBが常に勝つ）を2件直したが、直した後も
//        「スクロールするほどズームが利かなくなる」という報告が続いた。
//        原因は実装ではなく方式そのもの: towardPointはAABBの面（箱の境界）でしかなく、
//        カメラがその面に近づくほど1ティックの移動量（(1-factor)*targetからの距離）が
//        0に近づき、何もない境界に漸近して止まる。点群の点に到達する構造になっていない。
// 3回目（今回）: 「点」を求めるのをやめ、カーソル位置のレイの「方向」だけを使う方式に
//        変えた。1ティックの移動量`step = distance * (1-factor)`は`distance`
//        （自分が縮めている量そのもの）に比例するので、target/towardPointの位置とは
//        無関係に決まり、独立に0へ潰れることが構造的に起こりえない。
//        止まるとしたらMIN_DISTANCEに当たったときだけ。
//
// このファイルで担保したいこと（下の受け入れ条件と対応）:
// - zoom()が方向ベクトルを取ること
// - ズームを何度繰り返しても、1ティックの移動量がdistanceに比例し続けること
//   （比例定数(1-factor)が毎回同じであることを直接検証する。これがまさに
//   「移動量が独立に潰れない」ことの証明になる）
// - カーソルが画面中心のとき、従来（固定targetへ寄る旧実装）と同じ軸上を動くこと
// - cursorDirection省略時はtargetを動かさずdistanceだけ縮めること（フォールバック）

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

/** aとbが（ほぼ）平行かどうか。外積のノルムが十分小さいかで判定する。 */
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

    // step = distance(100) * (1 - 0.5) = 50。targetは+x方向に50動くはず。
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

    // 移動量はdistanceに正比例するので、比率(移動量 / 開始distance)はどちらも(1-factor)になる。
    expect(small.target[2] / 10).toBeCloseTo(1 - factor, 9);
    expect(large.target[2] / 1000).toBeCloseTo(1 - factor, 9);
  });

  it("寄り続けても1ティックの移動量が独立に潰れない: 100回ズームインしても、毎回 distance*(1-factor) だけ動く", () => {
    // これがM1-5「3回目」の核心。旧方式（AABBの面という『点』へ向けてtargetを寄せる）
    // では、targetが対象に近づくほど「targetからtowardPointまでの距離」が0に近づき、
    // 移動量も一緒に0へ潰れて止まった。この方式ではtargetの位置や対象までの距離とは
    // 無関係に、移動量が「今のdistance」だけで決まる。distanceは毎回factor倍に
    // 縮んでいくが、移動量とdistanceの比率(1-factor)は常に同じであり続ける。
    const camera = new OrbitCamera([0, 0, 0], 1_000_000);
    const direction: [number, number, number] = [1, 0, 0];
    const factor = 1 / 1.1; // ZOOM_STEPの逆数相当（ズームイン）

    let previousDistance = camera.distance;
    for (let i = 0; i < 100; i++) {
      const before: [number, number, number] = [...camera.target];
      camera.zoom(factor, direction);
      const moved = distance3(camera.target, before);

      // 実装のバグ（例えば移動量を固定量にしてしまう等）ならこの比率はズレる。
      // 旧方式（targetの位置に依存する）なら、targetが動くにつれてこの比率も
      // 崩れていくはずだが、方向ベースの実装では毎回ぴったり一致し続ける。
      const expectedMoved = previousDistance * (1 - factor);
      expect(moved).toBeCloseTo(expectedMoved, 6);

      previousDistance = camera.distance;
    }

    // distanceは毎回factor倍に縮み続け、100回後には初期値よりずっと小さくなっている
    // （MIN_DISTANCEに当たっていなければ）。「途中で動かなくなる」ことがない証拠として、
    // 最後まで単調に縮み続けたことを確認する。
    expect(camera.distance).toBeLessThan(1_000_000 * Math.pow(factor, 99));
  });

  it("カーソルが画面中心のとき: 従来どおりtarget方向に寄る挙動と一致する（eyeとtargetが同じ視線軸上を動く）", () => {
    // 「画面中心にカーソルがある」とは、カーソルのレイの方向がちょうど
    // eyeからtargetへ向かう方向（视線方向）と一致するということ。
    const camera = new OrbitCamera([0, 0, -100], 50);
    const eyeBefore = camera.eye();
    const forward = normalize3(sub3(camera.target, eyeBefore));

    camera.zoom(0.9, forward);
    const eyeAfter = camera.eye();

    // 新しいeyeは、旧eye→旧targetの視線軸上に乗っている（横に逸れない）。
    // これは固定target（旧来の一番単純な実装）でdistanceだけを縮めたときと同じ軸で、
    // 「中心を指しているときは中心へ向かって素直に寄る」という従来の挙動と一致する。
    expect(isParallel(sub3(eyeAfter, eyeBefore), forward)).toBe(true);

    // かつ、eyeとtargetの距離（=distance）はfactor倍に縮んでいる。
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
