// ADR-0001 で決めた抽象。Tauri の API を直接見てよいのは tauri.ts の実装だけで、
// レンダラ・state・UI はこのインターフェースだけを見る。Web版はこれを実装する
// HttpSource を差し替えるだけで動く想定（M0時点ではまだ存在しない）。

export interface DataSource {
  /**
   * M0時点ではCOPCノードの取得は未実装。`pcv://bench/<size>` から指定バイト数の
   * ダミーデータを取得するだけのベンチ用メソッド。M1でノード取得メソッドに置き換える。
   */
  fetchBench(sizeBytes: number): Promise<ArrayBuffer>;
}
