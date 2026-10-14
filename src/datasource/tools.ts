// L2-C: 点群ツール(点の選択・断面・複数レイヤー)が呼ぶ、「選んだレイヤーから
// 新しい点群を作る」関数の型。デスクトップ(tauri.ts)とWeb(web.ts)で同じ形。
// 座標はどちらも「ファイルの実座標」(f64。描画の原点ずらしを戻した値)。
// Rust側の対応する型は `crates/pcv-core/src/extract.rs` の ExtractFilter。

/** 画面上の多角形。投影して内側に映り、カメラの前(w>0)にある点が対象。奥行きは問わない。 */
export interface ScreenPolygonFilter {
  kind: "screenPolygon";
  /** ワールド(ファイルの実座標)→クリップ座標。列優先の16要素。 */
  viewProj: number[];
  /** NDC(x,y とも -1..1)の頂点。3つ以上。閉じなくてよい。 */
  polygonNdc: [number, number][];
}

/** 向きのある箱(断面の板)。 */
export interface OrientedBoxFilter {
  kind: "orientedBox";
  center: [number, number, number];
  /** 正規直交な3軸(長さ1)。 */
  axes: [[number, number, number], [number, number, number], [number, number, number]];
  /** 各軸方向の半分の長さ(0以上)。 */
  halfExtents: [number, number, number];
}

export type ExtractFilter = ScreenPolygonFilter | OrientedBoxFilter;

/** 抽出・結合の結果。`outputPath` は `DataSource.open()` にそのまま渡せる
 *  (デスクトップは一時フォルダのパス、Webは登録済みのファイルキー "file:N")。 */
export interface ToolResult {
  outputPath: string;
  pointCount: number;
  /** エラーログ(ADR-0011)に出す警告。CRSの無いファイルを通した、など。無ければ空。 */
  warnings: string[];
}

/** 進捗(読み込み段階)。`total` は読む予定の点数。 */
export interface ToolProgress {
  pointsRead: number;
  totalPoints: number;
}

/** 0点のときのエラー本文(Rustと同じ文言)。画面ではそのまま出す。 */
export const EMPTY_SELECTION_MESSAGE = "選んだ範囲に点がありません";

export interface ToolOptions {
  onProgress?: (progress: ToolProgress) => void;
  /** 一時フォルダ(設定で選んだ場所)。デスクトップのみ。 */
  tempDir?: string | null;
}
