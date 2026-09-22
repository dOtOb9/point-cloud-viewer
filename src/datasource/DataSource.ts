// ADR-0001 で決めた抽象。Tauri の API を直接見てよいのは tauri.ts の実装だけで、
// レンダラ・state・UI はこのインターフェースだけを見る。Web版はこれを実装する
// HttpSource を差し替えるだけで動く想定（M0時点ではまだ存在しない）。

/** 点群全体のサマリ（M1-1の `pcv_core::CloudInfo` に対応）。 */
export interface CloudInfo {
  pointCount: number;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  scale: readonly [number, number, number];
  offset: readonly [number, number, number];
  hasColor: boolean;
}

/** octreeの1ノード分のメタデータ。点データそのものは含まない（`readNode`で別途取得）。 */
export interface HierarchyNodeInfo {
  /** `readNode` にそのまま渡せるキー文字列（例: "0-0-0-0"）。 */
  key: string;
  pointCount: number;
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
}

export interface OpenedCloud {
  info: CloudInfo;
  nodes: HierarchyNodeInfo[];
}

export interface DataSource {
  /**
   * M0時点ではCOPCノードの取得は未実装。`pcv://bench/<size>` から指定バイト数の
   * ダミーデータを取得するだけのベンチ用メソッド。
   */
  fetchBench(sizeBytes: number): Promise<ArrayBuffer>;

  /** COPCファイルを開き、点群全体の情報とoctreeのノード一覧を取得する。 */
  open(path: string): Promise<OpenedCloud>;

  /**
   * 指定したノードキーの点データを取得する。返るバイト列はM1-2で決めた
   * バイナリ形式（`src/datasource/node-format.ts`の`parseNodeBuffer`でパースする）。
   */
  readNode(key: string): Promise<ArrayBuffer>;
}
