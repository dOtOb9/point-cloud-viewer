// 「上方向（up axis）」の定義をここ1箇所に集約する。
//
// M2-0b: 点群データはZ-up（LAS/COPCは投影座標系なのでZが標高）だが、`orbit-camera.ts`は
// これまでカメラのup/panのworldUpとして`[0, 1, 0]`（Y-up）をハードコードしており、
// 仰角(pitch)の軸がデータに対して90度回っていた（TaskSheets/M2-shading-and-ui.md M2-0b参照）。
//
// PLY/PCDは座標系を持たない（ADR-0008）ため、上方向がZとは限らない。定数ではなく
// 「設定可能な値」として持ち回し、カメラ・パン・ピッチ・（将来の）標高カラーマップ・EDL・
// 空の背景がすべてこの値を参照するようにする。`[0, 1, 0]`や`[0, 0, 1]`をコード中に
// 散らばらせないこと。

export type Vec3 = readonly [number, number, number];

/**
 * 上方向の既定値。
 *
 * NOTE(M2-0b 段階1): このコミット時点ではまだ`[0, 1, 0]`（Y-up）のままにしてある。
 * これは意図的。上方向の参照箇所を1箇所に集約するリファクタと、実際に値をZへ
 * 変える挙動変更を別コミットに分け、後者の効果（地平線の向きが90度変わる）を
 * 単独で確認できるようにするため（所有者の指示）。M2-0b 段階3で`[0, 0, 1]`に変える。
 */
export const DEFAULT_UP_AXIS: Vec3 = [0, 1, 0];

function normalize(v: Vec3): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * 上方向`up`に直交する水平面上の基底（`right`, `forward`）を作る。
 * `yaw = 0`のときにカメラが向く基準方向を決めるためのもの。
 *
 * `up`と平行にならない種ベクトル(seed)を`cross`の相手に選ぶ必要がある。upがZ軸に近い
 * （`|up.z|`が1に近い）ときだけ種を`[1, 0, 0]`に切り替えることで、種とupが平行になり
 * `cross`がゼロベクトルを返す事態を避ける。
 *
 * up=[0,1,0]（従来のY-up）のとき: right=[1,0,0], forward=[0,0,1]。これは
 * `orbit-camera.ts`が持っていた旧来の式（`eye = target + distance*[cosP*sin(yaw), sinP,
 * cosP*cos(yaw)]`）と代数的に一致する（`horizontalBasis`のテスト参照）。
 */
export function horizontalBasis(up: Vec3): { right: [number, number, number]; forward: [number, number, number] } {
  const u = normalize(up);
  const seed: Vec3 = Math.abs(u[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const right = normalize(cross(u, seed));
  const forward = normalize(cross(right, u));
  return { right, forward };
}
