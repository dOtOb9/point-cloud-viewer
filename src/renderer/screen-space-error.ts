// M1-4: ノードの「誤差」= そのノードの点間隔を画面に投影したピクセル数を求め、
// 優先度に使う。誤差が大きいノードほど「点と点の間が画面上で大きく空いて見えている
// ＝粗い」ので優先的にロードする。
//
// 当初は「画面上の大きさ ÷ 点密度」という式だったが、これは次元が合っておらず、
// 1レベル深くなるごとに誤差が急激に（約1/16に）落ちて深いレベルのノードが
// 事実上読み込まれなくなる不具合があった。次元を直した現在の式・診断の詳細は
// `screenSpaceError()` のdocコメントと
// TaskSheets/ADR-0010-lod-priority-and-point-budget.md を参照。

import { transformPoint, type Mat4 } from "./mat4";

/**
 * クリップ空間のw（= `transformPoint` の第4戻り値）がこれ以下なら
 * 「カメラの後ろ・至近距離」とみなす。0除算を避けるための閾値であって、
 * カメラの実際のニアクリップ距離とは無関係の値（元のコードから引き継いだ値）。
 */
const NEAR_W_EPSILON = 1e-6;

/** AABBの8頂点のうち、頂点番号iを2進数で見たとき何ビット目が立っているかでmin/maxを選ぶ。 */
function aabbCorner(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  index: number,
): [number, number, number] {
  return [
    index & 1 ? max[0] : min[0],
    index & 2 ? max[1] : min[1],
    index & 4 ? max[2] : min[2],
  ];
}

/** クリップ座標(cx, cy, cw)から画面ピクセル座標(px, py)へ変換する。 */
function clipToScreenPixels(
  cx: number,
  cy: number,
  cw: number,
  canvasWidth: number,
  canvasHeight: number,
): [number, number] {
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return [((ndcX + 1) / 2) * canvasWidth, ((1 - ndcY) / 2) * canvasHeight];
}

/**
 * AABBの8頂点をviewProjで投影し、画面上でのバウンディング矩形の対角線の長さ（ピクセル）を返す。
 *
 * 頂点の一部だけがニアプレーンの後ろに回ることがある（ズームインしてカメラがノードの
 * BBOXの近くまたは内側に入ったときなど）。かつてはそのとき即座に「画面いっぱい」相当の
 * 最大値を返していたが、ズームインするとほとんどのノードがこの条件に該当してしまい、
 * 優先度による選別が効かなくなる不具合があった。
 *
 * 正しくは、AABBをニアプレーンでクリップしてから画面上の大きさを求める。
 * `transformPoint` のwはワールド座標のアフイン関数（行列の行との内積）なので、
 * 後ろに回った頂点と手前に残った頂点の間を**ワールド座標のまま**線形補間すれば、
 * wがちょうど`NEAR_W_EPSILON`を跨ぐ点（＝ニアプレーン上の点）を厳密に求められる。
 * AABBの12本の辺すべてについてこれを行い、「手前に残った元の頂点」と
 * 「辺がニアプレーンを跨ぐ箇所にできる新しい頂点」を集めれば、それがクリップ後の
 * 立体の頂点集合になる（凸立体を1枚の平面でクリップしたときの一般的な性質）。
 * 画面上のバウンディング矩形が欲しいだけなので、面を組み立て直す必要はなく、
 * この頂点集合を画面座標に変換してmin/maxを取れば十分。
 */
export function projectedBoundsDiagonalPixels(
  viewProj: Mat4,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  canvasWidth: number,
  canvasHeight: number,
): number {
  const corners: [number, number, number][] = [];
  const clip: [number, number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const corner = aabbCorner(min, max, i);
    corners.push(corner);
    clip.push(transformPoint(viewProj, corner));
  }

  const screenPoints: [number, number][] = [];

  // 手前に残る元の頂点はそのまま画面座標に変換する。
  for (let i = 0; i < 8; i++) {
    const [cx, cy, , cw] = clip[i];
    if (cw > NEAR_W_EPSILON) {
      screenPoints.push(clipToScreenPixels(cx, cy, cw, canvasWidth, canvasHeight));
    }
  }

  // 頂点番号が1ビットだけ違うペアが、AABBの辺（12本）にあたる。
  // その辺がニアプレーンを跨いでいたら、交点をワールド座標の線形補間で求める。
  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue; // 辺は小さい方の頂点番号からだけ数える（二重に数えない）
      const j = i | bit;
      const wi = clip[i][3];
      const wj = clip[j][3];
      const iIsFront = wi > NEAR_W_EPSILON;
      const jIsFront = wj > NEAR_W_EPSILON;
      if (iIsFront === jIsFront) continue; // 両方手前 or 両方後ろなら、この辺はニアプレーンを跨がない

      const t = (NEAR_W_EPSILON - wi) / (wj - wi);
      const a = corners[i];
      const b = corners[j];
      const crossingPoint: [number, number, number] = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
      const [cx, cy, , cw] = transformPoint(viewProj, crossingPoint);
      screenPoints.push(clipToScreenPixels(cx, cy, cw, canvasWidth, canvasHeight));
    }
  }

  if (screenPoints.length === 0) {
    // 8頂点すべてがニアプレーンの後ろ。本来は視錐台カリングで弾かれているはずだが、
    // 万一ここに来た場合に備えて、従来どおり画面いっぱい相当の最大値を返しておく。
    return canvasWidth + canvasHeight;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of screenPoints) {
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }

  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * ノードの「誤差」= そのノードの点間隔を画面に投影したピクセル数。大きいほど
 * 優先度が高い（画面上で1点あたりの間隔が大きく見えている＝粗い、ということ）。
 *
 * ## 以前の式が間違っていた理由（2026-09-23の診断）
 *
 * 以前は `sizePixels / density`（= 画面上のBBOX対角長 × 体積 ÷ 点数）を
 * 誤差としていた。「まばらさ」を測るつもりが、次元が合っていなかった。
 * 「まばらさ」は本来**点間隔**（1次元、長さ）で測るべきところを、
 * `体積 ÷ 点数`（点間隔の3乗、体積の次元）で測っていたため、
 * ノードが1レベル細かくなるごとに（体積が1/8・点数はほぼ一定なので）
 * 誤差が1/8×さらにsizePixelsが1/2で**約1/16に落ちる**、という急すぎる
 * 減衰になっていた。距離の効果は1/距離の1乗しかないため、深いノードが
 * 浅く遠いノードに優先度で勝つには非現実的な倍率の接近が要り、
 * 実質的に深いレベルのノードがロードされないという不具合になっていた
 * （実測・詳細は `TaskSheets/ADR-0010-lod-priority-and-point-budget.md` および
 * `TaskSheets/M1-point-rendering.md` M1-4参照）。
 *
 * ## 新しい式
 *
 * 誤差 = 点間隔(ワールド単位) × そのノード位置でのピクセル/ワールド単位。
 *
 * - 点間隔 = `(体積 / 点数) ^ (1/3)`。体積を点数で均等に分け合った1点あたりの
 *   立方体の一辺の長さ、という意味。次元は長さ（1次元）で、「まばらさ」の
 *   物理量として正しい
 * - ピクセル/ワールド単位 = `projectedBoundsDiagonalPixels()`（画面上の対角線
 *   ピクセル数）÷ BBOXのワールド対角長。「このノードのあたりで、ワールド1単位が
 *   何ピクセルに見えるか」という、そのノードの位置・距離に依存するスケール
 *
 * この2つを掛けると、「点と点の間隔が画面上で何ピクセルに見えるか」になる。
 * 1レベル下がると点間隔が1/2になり、他の項（距離由来のピクセル/ワールド単位）は
 * 変わらないので、誤差もちょうど1/2になる。これで「1レベル深くなる」ことと
 * 「距離が2倍近づく」ことが釣り合う、素直なスケーリングになる。
 *
 * `projectedBoundsDiagonalPixels` はニアプレーンのクリップ処理を含む
 * 繊細なコード（M1-point-rendering.md M1-4の実機不具合対応）なので、
 * ここでは中身を変えずそのまま再利用する。
 */
export function screenSpaceError(
  viewProj: Mat4,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
  pointCount: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const sizePixels = projectedBoundsDiagonalPixels(viewProj, boundsMin, boundsMax, canvasWidth, canvasHeight);

  const dx = Math.max(boundsMax[0] - boundsMin[0], 1e-6);
  const dy = Math.max(boundsMax[1] - boundsMin[1], 1e-6);
  const dz = Math.max(boundsMax[2] - boundsMin[2], 1e-6);
  const volume = dx * dy * dz;
  const pointSpacing = Math.cbrt(volume / Math.max(pointCount, 1));

  // BBOXのワールド対角長。sizePixelsはこのBBOXが画面上で占める対角線の長さなので、
  // 割ればそのノードの位置での「ワールド1単位あたり何ピクセルか」が出る。
  const worldDiagonal = Math.max(Math.hypot(dx, dy, dz), 1e-6);
  const pixelsPerWorldUnit = sizePixels / worldDiagonal;

  return pointSpacing * pixelsPerWorldUnit;
}
