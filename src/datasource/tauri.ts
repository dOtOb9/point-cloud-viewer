// Tauri の API を import してよいのはこのファイルだけ（ARCHITECTURE.md の規約）。
// 他のファイルは DataSource インターフェースだけを見て、ここを直接 import しない。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { DataSource } from "./DataSource";

/**
 * M0 計測用の制御メッセージ。GUI を目視できない環境でも判断できるよう、
 * フロントの計測結果を Rust 側の標準出力にも出す（`npm run tauri dev` の stdout に出る）。
 * 大きいデータそのものはここを通さない（ADR-0001: invoke は制御メッセージ専用）。
 */
export async function reportToBackendConsole(message: string): Promise<void> {
  await invoke("report_diagnostic", { message });
}

/**
 * DataSource の Tauri 実装。`pcv://` カスタムプロトコルでノードデータを取得する
 * （ADR-0001）。M0時点ではベンチ用エンドポイントを叩くだけ。
 */
export class TauriSource implements DataSource {
  async fetchBench(sizeBytes: number): Promise<ArrayBuffer> {
    // convertFileSrc がプラットフォームごとのURL形式（Windows/Androidは
    // http://pcv.localhost/..., macOS/Linuxは pcv://localhost/...）を組み立てる。
    // 引数全体が1セグメントとして encodeURIComponent されるため、"/" を含む
    // パスにはせず、サイズの数値だけを渡す（Rust側 handle_pcv_protocol も参照）。
    const url = convertFileSrc(`${sizeBytes}`, "pcv");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`pcv://${sizeBytes} failed: ${res.status}`);
    }
    return await res.arrayBuffer();
  }
}

/**
 * M0-3 比較用。`invoke` 経由で同じサイズのダミーデータを取得する。
 * ADR-0001 の「invoke は Windows で遅い」という前提を裏付けるための比較対象であり、
 * DataSource の実装ではない（採用しない経路のため、インターフェースに含めない）。
 *
 * 受け取ったバイト数だけを返す（Uint8Array 等への変換コストを計測に混ぜないため）。
 * 変換自体のオーバーヘッドを除いても、Rust 側の serde_json による配列シリアライズと
 * JS 側の JSON.parse だけで invoke のコストは説明できる。
 */
export async function fetchBenchViaInvoke(sizeBytes: number): Promise<number> {
  const bytes = await invoke<number[]>("bench_invoke", { size: sizeBytes });
  return bytes.length;
}
