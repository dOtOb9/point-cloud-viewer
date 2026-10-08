// ADR-0010追記: LOD優先度に、画面中央からの距離に応じた重みを掛ける。
//
// 所有者の要望:「点群の octree 表示に関してなんだが、画面中央のチャンクを
// 優先して細かく表示しないと、使いにくい」。
//
// 画面空間誤差（screenSpaceError）だけで優先度を決めると、画面の端にある
// 近いノードと中央のノードが同じ扱いになり、所有者が見ている中央が後回しに
// なることがあった。この重みを`priority = screenSpaceError * centerPriorityWeight`
// として掛けることで、中央に近いノードの優先度を相対的に上げる。
//
// 選んだ理由・却下した案はTaskSheets/ADR-0010-lod-priority-and-point-budget.mdに
// 追記した。

import { aabbClippedByNearPlane, clipToScreenPixels } from "./screen-space-error";
import { transformPoint, type Mat4 } from "./mat4";

/**
 * 重みの下限（0〜1）。**実測していない、未検証の初期値。**
 *
 * 所有者の要望2「端のノードを永久に読まないようにしない（飢餓を起こさない）」
 * への対応。重みに下限を設けることで、画面空間誤差が十分大きい端のノードは、
 * 点予算に余裕がある限り中央の細かいノードより先に選ばれ得るようにする
 * （`priority = screenSpaceError * weight`なので、weightが0になることは無く、
 * 端のノードの誤差が十分大きければ中央のノードに優先度で勝てる）。
 *
 * 0.2という値自体は「下限が無いのと同じにならない程度に小さく、かつ中央優先の
 * 効果が消えない程度に大きい」という設計判断であり、実機で調整していない。
 */
export const DEFAULT_MIN_CENTER_PRIORITY_WEIGHT = 0.2;

/**
 * 中央優先の強さの既定値。**実測していない、未検証の初期値。**
 *
 * `centerPriorityWeight`のガウス型重みは、画面中央で1、画面端
 * （正規化距離=1）で`exp(-strength)`に近づく。strength=2のとき画面端の
 * ガウス項は`exp(-2)≈0.135`、下限(0.2)との合成後の重みは約0.31。
 * 「中央をはっきり優先するが、強すぎて端が常に下限に張り付くほどではない」
 * という設計判断で選んだ値で、実機での検証は所有者に委ねる
 * （設定画面から0〜に変更できるようにしてある）。
 */
export const DEFAULT_CENTER_PRIORITY_STRENGTH = 2;

/**
 * ノードのAABBの中心から画面中央までの距離に応じた重み（0〜1）を返す。
 *
 * ## 式とその理由
 *
 * 1. **strength <= 0 なら常に1。** 所有者の受け入れ条件「強さ0のとき、今までの
 *    優先度と一致する」をそのまま満たす（`priority = screenSpaceError * 1`）。
 * 2. **カメラがノードの範囲の中に入っている（投影がニアプレーンで切られる）
 *    場合は常に1（最大）。** `aabbClippedByNearPlane`で判定する
 *    （`projectedBoundsDiagonalPixels`のクリップ処理と同じ頂点ごとのw判定を
 *    流用。詳細はそちらのdocコメント参照）。カメラがノードの中にいる状況は
 *    「最も近い」の極限なので、中央優先がそれを邪魔してはならない。
 * 3. **それ以外は、ノード中心を投影した画面座標と画面中央の距離を、画面の
 *    半対角線で正規化し、ガウス型（`exp(-strength * d^2)`）で重みにする。**
 *    画面中央(d=0)で1、画面端(d≈1)で`exp(-strength)`に向かって滑らかに
 *    減衰する。ガウス型を選んだ理由: 線形減衰だと画面中央付近での重みの差が
 *    小さく「中央をはっきり優先する」効果が弱い一方、ガウス型は中央付近は
 *    ほぼ平坦（中央のわずかなブレで優先度が暴れない）で、離れるほど急に
 *    効いてくる。これはEDL(`edl.ts`)等、画面空間の効果に距離の2乗を使う
 *    既存のコードと同じ考え方。
 * 4. **重みは`DEFAULT_MIN_CENTER_PRIORITY_WEIGHT`を下限にクランプする。**
 *    所有者の要望2（飢餓防止）。
 *
 * ノードの「投影した中心」は、AABBのワールド座標の中心点を1点だけ投影する
 * （所有者の要望1が許した2案「投影した中心」「投影した範囲内で画面中央に
 * 最も近い点」のうち前者を選んだ。後者はノードの形状次第で最近点の計算が
 * 複雑になり、ノードの中心という単純な量で「画面のどのあたりにあるか」は
 * 十分近似できるため、所有者が追いやすいboring寄りの案を選んだ）。
 */
export function centerPriorityWeight(
  viewProj: Mat4,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
  canvasWidth: number,
  canvasHeight: number,
  strength: number,
  minWeight: number = DEFAULT_MIN_CENTER_PRIORITY_WEIGHT,
): number {
  if (strength <= 0) return 1;
  if (aabbClippedByNearPlane(viewProj, boundsMin, boundsMax)) return 1;

  const centerWorld: [number, number, number] = [
    (boundsMin[0] + boundsMax[0]) / 2,
    (boundsMin[1] + boundsMax[1]) / 2,
    (boundsMin[2] + boundsMax[2]) / 2,
  ];
  const [cx, cy, , cw] = transformPoint(viewProj, centerWorld);
  const [px, py] = clipToScreenPixels(cx, cy, cw, canvasWidth, canvasHeight);

  const screenCenterX = canvasWidth / 2;
  const screenCenterY = canvasHeight / 2;
  // 半対角線で正規化する: 画面中央で0、画面の四隅ちょうどで1になる
  // （四隅までの距離がどの辺の長さにも依存せず「1」で揃うため、strengthを
  // canvasの縦横比やサイズを気にせず選べる）。
  const halfDiagonal = Math.max(Math.hypot(canvasWidth, canvasHeight) / 2, 1e-6);
  const normalizedDistance = Math.hypot(px - screenCenterX, py - screenCenterY) / halfDiagonal;

  const gaussian = Math.exp(-strength * normalizedDistance * normalizedDistance);
  return minWeight + (1 - minWeight) * gaussian;
}
