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
  /** Meters per horizontal coordinate unit (1 = meters, 0.3048 = international foot). Absent = unknown: do not convert. */
  horizontalUnitToMeter?: number;
  /** Meters per vertical (elevation) unit. May differ from the horizontal one. Absent = unknown. */
  verticalUnitToMeter?: number;
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
  /** 開いたファイルの識別子。`readNode`・`close`に渡す。Tauriでは`pcv://<cloudId>/<key>`の世代番号、WebではWorkerの表のキー。 */
  cloudId: number;
  info: CloudInfo;
  nodes: HierarchyNodeInfo[];
}

/**
 * renderer（NodeLoader）が必要とする最小の形: キーだけでノードを読む。
 * renderer は DataSource や cloudId を知らない。呼び出し側が
 * `{ readNode: (key) => source.readNode(cloudId, key) }` のように cloudId を
 * 閉じ込めて渡す（L1-multi-layer.md の取り決め）。L1-C が renderer を
 * 作り直すとき、これは `LayerInput.readNode` に置き換わる。
 */
export interface NodeReader {
  readNode(key: string): Promise<ArrayBuffer>;
}

export interface DataSource {
  /**
   * Opens a COPC file and returns the info of the whole cloud and the list of octree nodes.
   * Files already open stay open (several can be open at once). `close` closes one.
   */
  open(path: string): Promise<OpenedCloud>;

  /**
   * 指定したノードキーの点データを取得する。返るバイト列はM1-2で決めた
   * バイナリ形式（`src/datasource/node-format.ts`の`parseNodeBuffer`でパースする）。
   */
  readNode(cloudId: number, key: string): Promise<ArrayBuffer>;

  /**
   * `cloudId`のファイルを閉じ、リーダー（Tauri: ファイルハンドルのプール、
   * Web: Workerのwasmリーダー）を手放す。閉じたあとの`readNode`は
   * `StaleNodeRequestError`になる。既に閉じている・知らない`cloudId`でもエラーにしない。
   */
  close(cloudId: number): Promise<void>;
}
