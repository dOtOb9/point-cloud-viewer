// Tauri の API を import してよいのはこのファイルだけ（ARCHITECTURE.md の規約）。
// 他のファイルは DataSource インターフェースだけを見て、ここを直接 import しない。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { DataSource, OpenedCloud } from "./DataSource";
import {
  toCloudInfo,
  toHierarchyNodeInfo,
  type CloudInfoDto,
  type HierarchyNodeDto,
} from "./copc-dto";
import {
  toConversionOutcome,
  toConversionProgress,
  type ConversionOutcome,
  type ConversionOutcomeDto,
  type ConversionProgress,
  type ConversionProgressDto,
} from "./conversion-dto";
import { isTauriEnvironment } from "./environment";

// `open_copc` (src-tauri/src/copc_state.rs) がJSONで返す形。DTOの中身とcamelCaseへの
// 変換自体は`copc-dto.ts`にある（Web版の`pcv-wasm`も同じ形のJSONを返すため共有する）。
interface OpenCopcResponseDto {
  info: CloudInfoDto;
  nodes: HierarchyNodeDto[];
}

/**
 * M0 計測用の制御メッセージ。GUI を目視できない環境でも判断できるよう、
 * フロントの計測結果を Rust 側の標準出力にも出す（`npm run tauri dev` の stdout に出る）。
 * 大きいデータそのものはここを通さない（ADR-0001: invoke は制御メッセージ専用）。
 *
 * `useCopcViewer.ts`から環境を問わず（Web版でも）呼ばれるので、Tauriの
 * webviewで動いていないときは何もせずに戻る（ブラウザにはこの`invoke`を
 * 受け取るバックエンドが存在しないため）。呼び出し側に環境分岐を書かせず、
 * ここ1箇所に閉じ込めることで、Web版のためにコールサイトを増やさずに済む。
 */
export async function reportToBackendConsole(message: string): Promise<void> {
  if (!isTauriEnvironment()) return;
  await invoke("report_diagnostic", { message });
}

/**
 * M3-2/M3-4: 更新通知が「今動いているアプリのバージョン」と比較するために使う。
 * `tauri.conf.json`の`version`（=ビルド時のCargo/バンドラのバージョン）をTauriが
 * 実行時に返す値で、`package.json`の`version`とは独立している（両者は今のところ
 * 手で一致させている）。
 */
export async function getAppVersion(): Promise<string> {
  return await getVersion();
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
 * M3: OSのファイル選択ダイアログを出し、選ばれたファイルのパス（デスクトップ）
 * または`content://` URI（Android）を返す。キャンセルされたら`null`。
 *
 * デスクトップ・Android共通で同じ`tauri-plugin-dialog`の`open()`を呼ぶだけでよい
 * （プラットフォームごとの分岐はプラグイン側が吸収する）。返り値の文字列は
 * そのまま`DataSource.open(path)`に渡せる（Rust側の`open_copc`が
 * パスかURIかを判別する。`src-tauri/src/copc_state.rs`参照）。
 *
 * `multiple: false`を渡しているため、`OpenDialogReturn`の条件型により
 * 戻り値の型は`string | null`に確定する（配列にはならない）。
 */
export async function pickLocalFile(): Promise<string | null> {
  return await openFileDialog({
    multiple: false,
    directory: false,
    // M4-3: 生のLAS/LAZも選べるようにする(受け入れ条件)。COPCかどうかは
    // 拡張子ではなくヘッダーで判定する(`start_las_conversion`側、
    // `pcv_convert::copc_detect`)ため、ここでは.las/.lazをまとめて許可するだけでよい。
    filters: [{ name: "LAS/LAZ (.las / .laz / .copc.laz)", extensions: ["las", "laz"] }],
  });
}

/**
 * M4-3: 一時ファイルの置き場所を所有者が設定で選ぶための、OSのフォルダ選択
 * ダイアログ。Androidでは`supportsCustomTempDir()`が`false`を返すため、
 * 呼び出し側(`SettingsModal.tsx`)はそもそもこの関数を使う設定行自体を出さない
 * (Android版のSAFフォルダ選択は`content://`のツリーURIを返し、`tempfile`が
 * 要求する実在のファイルシステムパスとしては使えないため。
 * `src-tauri/src/conversion.rs`の`supports_custom_temp_dir`のコメント参照)。
 */
export async function pickTempDirectory(): Promise<string | null> {
  return await openFileDialog({ multiple: false, directory: true });
}

/** デスクトップだけで一時ディレクトリを設定で選べるようにする
 *  (`src-tauri/src/conversion.rs`の`supports_custom_temp_dir`)。 */
export async function supportsCustomTempDir(): Promise<boolean> {
  return await invoke<boolean>("supports_custom_temp_dir");
}

/**
 * M4-3: 生のLAS/LAZを変換する。既にCOPCなら`{kind: "alreadyCopc"}`、
 * 変換済みキャッシュがあれば`{kind: "cached"}`を即座に返す(変換を待たない)。
 * 空き容量が足りなければ`{kind: "insufficientSpace"}`(変換は始まらない)。
 * それ以外は変換を別スレッドで開始し`{kind: "converting"}`を返す。以後の
 * 進捗・完了・失敗は`onConversionProgress`/`onConversionDone`/
 * `onConversionFailed`のイベントで届く。
 *
 * `tempDir`は所有者が設定で選んだ一時ファイルの置き場所(未設定なら`null`)。
 */
export async function startLasConversion(
  path: string,
  tempDir: string | null,
): Promise<ConversionOutcome> {
  const dto = await invoke<ConversionOutcomeDto>("start_las_conversion", {
    path,
    tempDir,
  });
  return toConversionOutcome(dto);
}

/** 進行中の変換をキャンセルする。進行中の変換が無ければ失敗する。 */
export async function cancelLasConversion(): Promise<void> {
  await invoke("cancel_las_conversion");
}

// Web版には`@tauri-apps/api/event`のバックエンドが無いため、Tauri環境で
// なければ何もしない購読関数を返す(`reportToBackendConsole`と同じ、
// 呼び出し側に環境分岐を書かせないための早期リターンの方針)。
const NOOP_UNLISTEN: UnlistenFn = () => {};

/** 読み込み段階の進捗イベントを購読する。戻り値の関数を呼ぶと購読を解除する。 */
export async function onConversionProgress(
  callback: (progress: ConversionProgress) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) return NOOP_UNLISTEN;
  return await listen<ConversionProgressDto>("conversion-progress", (event) => {
    callback(toConversionProgress(event.payload));
  });
}

/** 変換完了イベントを購読する。ペイロードは出力(COPC)のパス。 */
export async function onConversionDone(
  callback: (outputPath: string) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) return NOOP_UNLISTEN;
  return await listen<{ output_path: string }>("conversion-done", (event) => {
    callback(event.payload.output_path);
  });
}

/** 変換の失敗・キャンセルイベントを購読する。 */
export async function onConversionFailed(
  callback: (message: string, cancelled: boolean) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) return NOOP_UNLISTEN;
  return await listen<{ message: string; cancelled: boolean }>("conversion-failed", (event) => {
    callback(event.payload.message, event.payload.cancelled);
  });
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
      // M3(ADR-0013): 500の場合、本文にはRust側がcatch_unwindで捕まえた
      // panicメッセージ・ノードキーが入っている
      // （src-tauri/src/copc_state.rsのReadNodeError::Panicked、
      // src-tauri/src/lib.rsのinternal_server_error_response参照）。
      // ここで本文を読み捨てるとその情報が失われ、GpuErrorBannerに
      // 「500」としか出せなくなるため、必ず読んでエラーメッセージに含める。
      const body = await res.text().catch(() => "");
      throw new Error(body || `pcv://${key} failed: ${res.status}`);
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
