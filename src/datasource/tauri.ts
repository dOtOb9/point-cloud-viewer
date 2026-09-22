// Tauri の API を import してよいのはこのファイルだけ（ARCHITECTURE.md の規約）。
// 他のファイルは DataSource インターフェースだけを見て、ここを直接 import しない。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { CloudInfo, DataSource, HierarchyNodeInfo, OpenedCloud } from "./DataSource";

// `open_copc` (src-tauri/src/copc_state.rs) がJSONで返す形。フィールド名はRust側の
// serdeデフォルト（snake_case）のまま受け取り、ここでDataSourceのcamelCase型に詰め替える。
interface CloudInfoDto {
  point_count: number;
  min: [number, number, number];
  max: [number, number, number];
  scale: [number, number, number];
  offset: [number, number, number];
  has_color: boolean;
}

interface HierarchyNodeDto {
  key: string;
  point_count: number;
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
}

interface OpenCopcResponseDto {
  info: CloudInfoDto;
  nodes: HierarchyNodeDto[];
}

function toCloudInfo(dto: CloudInfoDto): CloudInfo {
  return {
    pointCount: dto.point_count,
    min: dto.min,
    max: dto.max,
    scale: dto.scale,
    offset: dto.offset,
    hasColor: dto.has_color,
  };
}

function toHierarchyNodeInfo(dto: HierarchyNodeDto): HierarchyNodeInfo {
  return {
    key: dto.key,
    pointCount: dto.point_count,
    boundsMin: dto.bounds_min,
    boundsMax: dto.bounds_max,
  };
}

/**
 * M0 計測用の制御メッセージ。GUI を目視できない環境でも判断できるよう、
 * フロントの計測結果を Rust 側の標準出力にも出す（`npm run tauri dev` の stdout に出る）。
 * 大きいデータそのものはここを通さない（ADR-0001: invoke は制御メッセージ専用）。
 */
export async function reportToBackendConsole(message: string): Promise<void> {
  await invoke("report_diagnostic", { message });
}

/**
 * M2: 並行リクエストの計測ハーネス（`useNodeConcurrencyBench`）が使う。
 * `TaskSheets/TEST-DATA.md` のテストデータは `.gitignore` されておりCIには無いため、
 * リポジトリの `data/<filename>` を実行時に探し、無ければ `null` を返す
 * （呼び出し側はその場合ベンチをスキップする）。パス解決はRust側で
 * `CARGO_MANIFEST_DIR` から行うため、`npm run tauri dev` のカレントディレクトリに
 * 依存しない（Rust側の実装は `src-tauri/src/lib.rs` の `default_bench_data_path`）。
 */
export async function resolveBenchDataPath(filename: string): Promise<string | null> {
  return await invoke<string | null>("default_bench_data_path", { filename });
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

  async open(path: string, readerPoolSize?: number): Promise<OpenedCloud> {
    const dto = await invoke<OpenCopcResponseDto>("open_copc", {
      path,
      poolSize: readerPoolSize ?? null,
    });
    return {
      info: toCloudInfo(dto.info),
      nodes: dto.nodes.map(toHierarchyNodeInfo),
    };
  }

  async readNode(key: string): Promise<ArrayBuffer> {
    // keyは "level-x-y-z" の1セグメント文字列（M0で判明した制約: convertFileSrcは
    // 引数全体を1セグメントとしてencodeURIComponentするため、"/"を含むパスは使えない）。
    const url = convertFileSrc(key, "pcv");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`pcv://${key} failed: ${res.status}`);
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
