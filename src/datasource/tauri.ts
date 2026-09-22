// Tauri の API を import してよいのはこのファイルだけ（ARCHITECTURE.md の規約）。
// 他のファイルは DataSource インターフェースだけを見て、ここを直接 import しない。

import { invoke } from "@tauri-apps/api/core";

/**
 * M0 計測用の制御メッセージ。GUI を目視できない環境でも判断できるよう、
 * フロントの計測結果を Rust 側の標準出力にも出す（`npm run tauri dev` の stdout に出る）。
 * 大きいデータそのものはここを通さない（ADR-0001: invoke は制御メッセージ専用）。
 */
export async function reportToBackendConsole(message: string): Promise<void> {
  await invoke("report_diagnostic", { message });
}
