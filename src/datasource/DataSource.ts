// ADR-0001 で決めた抽象。Tauri の API を直接見てよいのは tauri.ts の実装だけで、
// レンダラ・state・UI はこのインターフェースだけを見る。Web版はこれを実装する
// HttpSource を差し替えるだけで動く想定（M0時点ではまだ存在しない）。

/**
 * ファイルのCRS（`pcv_core::crs::CrsInfo`に対応）。デスクトップ・Webで同じ形。
 * `kind`が`"none"`ならファイルにCRS情報が無い。`error`があれば読み取りに失敗
 * （ファイルは開ける。本文はエラーログに出す。ADR-0015）。
 */
export interface CrsInfo {
  epsg?: number;
  name: string;
  kind: "plane-rectangular" | "utm" | "other" | "none";
  error?: string;
}

/** 点群全体のサマリ（M1-1の `pcv_core::CloudInfo` に対応）。 */
export interface CloudInfo {
  pointCount: number;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  scale: readonly [number, number, number];
  offset: readonly [number, number, number];
  hasColor: boolean;
  crs: CrsInfo;
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

  /**
   * COPCファイルを開き、点群全体の情報とoctreeのノード一覧を取得する。
   *
   * `readerPoolSize`は省略可能。Tauri実装では省略時にRust側が
   * `default_pool_size()`（利用可能な並列度）で決める。明示的に渡せるのは
   * `src/state/useNodeConcurrencyBench.ts`が並行数ごとにプールサイズも
   * 振って計測するため（`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`）。
   * 通常のビューアはこの引数を渡さない。
   */
  open(path: string, readerPoolSize?: number): Promise<OpenedCloud>;

  /**
   * 指定したノードキーの点データを取得する。返るバイト列はM1-2で決めた
   * バイナリ形式（`src/datasource/node-format.ts`の`parseNodeBuffer`でパースする）。
   */
  readNode(key: string): Promise<ArrayBuffer>;
}
