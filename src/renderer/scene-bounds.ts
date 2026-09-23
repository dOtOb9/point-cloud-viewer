// シーンのバウンディングボックスに関する純粋計算。
//
// **なぜこのファイルがあるか（実機不具合の教訓、M2-2）:** `point-cloud-renderer.ts`の
// `setHierarchy()`は元々、octreeノードのbounds(`HierarchyNodeInfo.boundsMin`/
// `boundsMax`)の和集合から「カメラの初期位置・グリッドの尺度を決めるための
// シーン全体のバウンディングボックス」を計算していた。この同じ値を、標高
// カラーマップ(M2-2)の正規化レンジにもそのまま使い回したところ、所有者の
// 実機で「標高が全部紫になる」不具合が起きた。
//
// **原因:** COPCのoctreeはルートが立方体で、ノードのbounds
// (`crates/pcv-core/src/copc.rs`の`voxel_bounds`が返す値)はその立方体を
// 素直に分割したセルである。航空測量データ(`sofi.copc.laz`等)は水平方向が
// 数km、実際の標高差は数十mしかないため、立方体のZ範囲は水平方向の広さに
// 合わせて大きく引き伸ばされる（例: 水平方向2km四方なら、Zの範囲も
// 約2km分に引き伸ばされる）。この引き伸ばされた範囲で標高を正規化すると、
// すべての点の`t`がほぼ0（レンジの下端＝`ELEVATION_RAMP`の最初の色）に
// 張り付いてしまい、標高モードの色が全点ほぼ同じ紫色になっていた。
//
// **直し方:** カメラ位置決め・グリッド尺度決めに使う「シーンのバウンディング
// ボックス」（`computeSceneBounds`、ノードのbounds由来のまま。**この用途では
// 立方体のままで問題無い**ため変更していない）と、標高カラーマップに使う
// 「標高の正規化レンジ」（`elevationRangeFromCloudBounds`、LASヘッダーの
// 実データ範囲＝`CloudInfo.min`/`max`のZ成分。`crates/pcv-core/src/copc.rs`の
// `build_cloud_info`がLASヘッダーの`min_z`/`max_z`をそのまま入れている）を、
// はっきり別の関数・別の入力に分けた。両者を1箇所（同じ`min`/`max`変数）で
// 済ませていたことが混同の原因だったため、型レベルでも別の関数にして
// 「標高レンジはノードのboundsを一切受け取らない」ことをシグネチャで示す。

import type { HierarchyNodeInfo } from "../datasource/DataSource";
import type { ValueRange } from "./colormap";

/** カメラの初期位置・グリッドの尺度決めに使う、シーン全体のバウンディングボックス。 */
export interface SceneBounds {
  min: [number, number, number];
  max: [number, number, number];
  /** `OrbitCamera.target`にそのまま代入できるよう、意図的にmutableな`[number,number,number]`にしてある。 */
  center: [number, number, number];
  /** バウンディングボックスの対角線の長さ。0(点が1つしかない等)の場合は100にフォールバックする。 */
  diagonal: number;
}

/**
 * octreeノードのbounds(`boundsMin`/`boundsMax`)の和集合から、シーン全体の
 * バウンディングボックスを求める。カメラの初期位置(`target`/`distance`)・
 * グリッドの間隔/フェード距離/地面の高さの決定に使う。
 *
 * **ここで返るZ範囲を標高カラーマップの正規化には使わないこと。** COPCの
 * octreeはルートが立方体なので、Z範囲は水平方向の広さまで引き伸ばされて
 * いる（ファイル冒頭のコメント参照）。標高には`elevationRangeFromCloudBounds`
 * （LASヘッダーの実データ範囲）を使うこと。
 *
 * `nodes`が空の場合は`null`を返す（呼び出し側は既存のカメラ位置を変えない）。
 */
export function computeSceneBounds(nodes: readonly HierarchyNodeInfo[]): SceneBounds | null {
  if (nodes.length === 0) return null;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], node.boundsMin[axis]);
      max[axis] = Math.max(max[axis], node.boundsMax[axis]);
    }
  }
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 100;

  return { min, max, center, diagonal };
}

/**
 * 標高カラーマップ(M2-2)の正規化に使うレンジを、LASヘッダーの実データ範囲
 * (`CloudInfo.min`/`max`のZ成分)から作る。
 *
 * **`computeSceneBounds`が返すノードのbounds(octreeセル、立方体)は入力に
 * 取らない。** シグネチャ自体が「標高レンジはヘッダーの範囲だけで決まり、
 * ノードのboundsは一切関与しない」ことを示す（実機不具合の経緯はファイル
 * 冒頭のコメント参照）。
 *
 * 標高の軸は**upAxis（カメラの表示上の上方向）ではなく、常にLAS座標系のZ
 * (3成分目)を使う**。upAxisは表示上「どちらを上として振る舞うか」という
 * 概念で、LASファイルのZ座標（実世界の高さ、標高）とは別の概念だからである。
 */
export function elevationRangeFromCloudBounds(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): ValueRange {
  return { min: min[2], max: max[2] };
}
