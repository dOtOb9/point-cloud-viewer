// Tauri の API を import してよいのはこのファイルだけ（ARCHITECTURE.md の規約）。
// 他のファイルは DataSource インターフェースだけを見て、ここを直接 import しない。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import type { DataSource, OpenedCloud, PrepareOptions, PrepareOutcome } from "./DataSource";
import { basenameOfPath } from "./file-name";
import { toConversionFailureOutcome, toPrepareOutcome } from "./prepare-outcome";
import {
  toCloudInfo,
  toHierarchyNodeInfo,
  type CloudInfoDto,
  type HierarchyNodeDto,
} from "./copc-dto";
import {
  toConversionOutcome,
  toConversionProgress,
  toConversionStageBreakdown,
  type ConversionOutcome,
  type ConversionOutcomeDto,
  type ConversionProgress,
  type ConversionProgressDto,
  type ConversionStageBreakdown,
  type ConversionStageBreakdownDto,
} from "./conversion-dto";
import { isTauriEnvironment } from "./environment";
import type { ExtractFilter, RasterRequest, ToolOptions, ToolResult } from "./tools";
import { decodeSectionProfile, type SectionLineInput, type SectionPoints } from "./section-profile";
import { decodeSectionLine, type SectionGroundLine, type SectionLineRequest } from "./section-line";
import { StaleNodeRequestError } from "./stale-node-error";
import { buildNodeRequestPath } from "./tauri-protocol";
import { OPENABLE_EXTENSIONS } from "./source-format";

/**
 * The file dialog filter, built from `OPENABLE_EXTENSIONS` (`source-format.ts`). The display name
 * also lists ".copc.laz": a COPC is a .laz, so the "laz" extension already covers it.
 */
function openDialogFilters(): { name: string; extensions: string[] }[] {
  const extensions = [...OPENABLE_EXTENSIONS];
  const shown = extensions.flatMap((ext) => (ext === "laz" ? [".laz", ".copc.laz"] : [`.${ext}`]));
  return [{ name: `点群ファイル (${shown.join(" / ")})`, extensions }];
}

// `open_copc` (src-tauri/src/copc_state.rs) がJSONで返す形。DTOの中身とcamelCaseへの
// 変換自体は`copc-dto.ts`にある（Web版の`pcv-wasm`も同じ形のJSONを返すため共有する）。
interface OpenCopcResponseDto {
  info: CloudInfoDto;
  nodes: HierarchyNodeDto[];
  /** ファイル切り替え時の不具合の修正: このファイルに割り当てられた世代番号
   *  （`OpenedFile`のドキュメントコメント参照）。`TauriSource`が覚えておき、
   *  以後の`readNode`の`pcv://`URLに含めて送り返す。 */
  generation: number;
}

/**
 * ファイル切り替え時の不具合の修正: Rust側（`src-tauri/src/lib.rs`の
 * `stale_generation_response()`）が「古い世代のリクエスト」を表すのに使う
 * HTTPステータス。400（クライアントの入力ミス）でも500（サーバの異常）でもない、
 * ファイル切り替え時に普通に起こりうる正常な競合状態を表すため専用の値にした。
 */
const STALE_GENERATION_HTTP_STATUS = 409;

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
 * ADR-0017: the event for files dragged from the OS onto the window (desktop Tauri build only). On the Web
 * the browser's own drop event is handled in `file-picker.ts`, not here.
 * 規約2のため、Tauriのイベント購読はこのファイルの中に閉じ込め、呼び出し側には
 * 「ドロップされたパス」「ドラッグ中かどうか」のコールバックと解除関数だけを見せる。
 * ※デスクトップ/Android実機での動作は未確認(Webビルドでは呼ばれない)。
 */
export async function onFilesDropped(
  onDrop: (paths: string[]) => void,
  onHover: (hovering: boolean) => void,
): Promise<() => void> {
  return await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "over" || payload.type === "enter") onHover(true);
    else if (payload.type === "leave") onHover(false);
    else if (payload.type === "drop") {
      onHover(false);
      if (payload.paths.length > 0) onDrop(payload.paths);
    }
  });
}

/**
 * Shows the OS file picker (desktop) or the content picker (Android) and returns the chosen paths or `content://`
 * URIs, or `null` when cancelled. `multiple: true`, so one chosen file still comes back as an array.
 * The viewer checks whether PLY/E57/PCD files are mixed in with others before it goes on; the dialog filter
 * (`openDialogFilters()`) is the same for every format.
 */
export async function pickLocalFiles(): Promise<string[] | null> {
  return await openFileDialog({
    multiple: true,
    directory: false,
    filters: openDialogFilters(),
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

/**
 * M4-14: 複数のLAS/LAZを選んだときの変換開始。`startLasConversion`と同じ
 * `ConversionOutcome`(`kind: "converting"`のときは進捗・完了・失敗を
 * `startLasConversion`と共通のイベント(`onConversionProgress`等)で待つ)。
 * Rust側(`src-tauri/src/conversion.rs`の`start_multi_las_conversion`)が
 * `paths.length === 1`のときは`start_las_conversion`へ委譲するため、単一
 * ファイルの選択は今までと同じ挙動になる。
 */
export async function startMultiLasConversion(
  paths: string[],
  tempDir: string | null,
): Promise<ConversionOutcome> {
  const dto = await invoke<ConversionOutcomeDto>("start_multi_las_conversion", {
    paths,
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

/** 変換完了イベントを購読する。ペイロードは出力(COPC)のパスと、
 *  M4-12(`TaskSheets/M4-import-and-conversion.md`)で追加した段階ごとの
 *  内訳(`sourceFormat`は元ファイルの拡張子、`stageTimings`は秒単位の内訳。
 *  `src-tauri/src/conversion.rs`の`ConversionDoneEvent`参照)。 */
export async function onConversionDone(
  callback: (
    outputPath: string,
    sourceFormat: string,
    stageTimings: ConversionStageBreakdown,
    /** L2-C: warnings for the error log (e.g. files without a CRS were let through). Empty if none. */
    warnings: string[],
  ) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnvironment()) return NOOP_UNLISTEN;
  return await listen<{
    output_path: string;
    source_format: string;
    stage_timings: ConversionStageBreakdownDto;
    warnings?: string[];
  }>("conversion-done", (event) => {
    callback(
      event.payload.output_path,
      event.payload.source_format,
      toConversionStageBreakdown(event.payload.stage_timings),
      event.payload.warnings ?? [],
    );
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

/** How a conversion ended, as the events say it. */
type ConversionEnd =
  | {
      kind: "done";
      outputPath: string;
      sourceFormat: string;
      stageTimings: ConversionStageBreakdown;
      warnings: string[];
    }
  | { kind: "failed"; message: string; cancelled: boolean };

/**
 * Subscribes to the progress / done / failed events and returns a promise for the first end event.
 * Call it BEFORE the command that starts the conversion; call `stop` in a `finally`.
 * Progress goes to `onProgress` as it comes.
 */
async function watchConversionEnd(
  onProgress: ((progress: ConversionProgress) => void) | undefined,
): Promise<{ end: Promise<ConversionEnd>; stop: () => void }> {
  let finish: (end: ConversionEnd) => void = () => {};
  const end = new Promise<ConversionEnd>((resolve) => {
    finish = resolve;
  });
  const unlistenAll: UnlistenFn[] = [];
  const stop = () => unlistenAll.forEach((unlisten) => unlisten());
  try {
    if (onProgress) unlistenAll.push(await onConversionProgress(onProgress));
    unlistenAll.push(
      await onConversionDone((outputPath, sourceFormat, stageTimings, warnings) =>
        finish({ kind: "done", outputPath, sourceFormat, stageTimings, warnings }),
      ),
    );
    unlistenAll.push(
      await onConversionFailed((message, cancelled) => finish({ kind: "failed", message, cancelled })),
    );
  } catch (e) {
    // A subscription failed: let go of the ones that worked, then report the failure.
    stop();
    throw e;
  }
  return { end, stop };
}

/**
 * The Tauri implementation of DataSource. Node data is fetched over the `pcv://` custom protocol (ADR-0001).
 */
export class TauriSource implements DataSource {
  /**
   * `DataSource.prepareToOpen` for the desktop. Items are paths. One path: `start_las_conversion` (a COPC
   * comes back as `alreadyCopc` after a header read; a raw file checks the cache, then the free space, then
   * starts converting). Several paths: `start_multi_las_conversion`. `isMobile` is not used.
   * When the command says `converting`, this waits for the `conversion-done` / `conversion-failed` event.
   * The events are subscribed to BEFORE the command is invoked, so a fast "done" cannot be missed.
   */
  async prepareToOpen(items: string[] | File[], options: PrepareOptions): Promise<PrepareOutcome> {
    const paths: string[] = [];
    for (const item of items) {
      if (typeof item !== "string") throw new Error("ローカルファイルの選択はWeb版でのみサポートしています");
      paths.push(item);
    }
    const watch = await watchConversionEnd(options.onProgress);
    try {
      const isMulti = paths.length !== 1;
      const started = isMulti
        ? await startMultiLasConversion(paths, options.tempDir)
        : await startLasConversion(paths[0], options.tempDir);
      if (started.kind !== "converting") return toPrepareOutcome(started, isMulti);

      options.onConverting?.();
      const end = await watch.end;
      if (end.kind !== "done") return toConversionFailureOutcome(end.message, end.cancelled);
      return {
        kind: "ready",
        // The converted file is already COPC, so this is the path to open (no second start_las_conversion).
        path: end.outputPath,
        conversion: {
          outputName: basenameOfPath(end.outputPath),
          platform: "desktop",
          sourceFormat: end.sourceFormat,
          stageTimings: end.stageTimings,
          warnings: end.warnings,
          download: null,
        },
      };
    } finally {
      watch.stop();
    }
  }

  /** Asks the backend to cancel. The conversion may have finished already, so a failure is only logged. */
  cancelConversion(): void {
    cancelLasConversion().catch((e: unknown) => {
      console.error("cancelLasConversion failed", e);
    });
  }

  async open(path: string): Promise<OpenedCloud> {
    const dto = await invoke<OpenCopcResponseDto>("open_copc", { path });
    return {
      // Rust側の世代番号がそのままcloudId。readNode(pcv://のURL)とcloseに渡す。
      cloudId: dto.generation,
      info: toCloudInfo(dto.info),
      nodes: dto.nodes.map(toHierarchyNodeInfo),
    };
  }

  async close(cloudId: number): Promise<void> {
    await invoke("close_copc", { generation: cloudId });
  }

  async readNode(cloudId: number, key: string): Promise<ArrayBuffer> {
    // パス形式: "<generation>/<level>-<x>-<y>-<z>"（`buildNodeRequestPath`、
    // `tauri-protocol.ts`参照）。generationの意味は`currentGeneration`フィールドの
    // コメント、Rust側は`src-tauri/src/lib.rs`の`parse_pcv_path`参照。
    //
    // 緊急修正（v0.1.3でノード読み出しが全滅した不具合）: convertFileSrcは
    // 渡した文字列全体を1回のencodeURIComponentでエンコードしてから1セグメント
    // としてURLに埋め込むため、ここに含めた"/"も"%2F"になって届く。以前は
    // 区切りに":"を使っていたが、Rust側がパーセントデコードせずに解析していた
    // ため常に失敗していた（詳細はTaskSheets/M1-point-rendering.md）。
    const segment = buildNodeRequestPath(cloudId, key);
    const url = convertFileSrc(segment, "pcv");
    const res = await fetch(url);
    if (res.status === STALE_GENERATION_HTTP_STATUS) {
      // ファイル切り替え時の不具合の修正: Rust側が「古い世代のリクエスト」と
      // 判定した。エラーではなく、呼び出し側（NodeLoader）が黙って捨てるべき
      // 結果なので、専用の型で伝える（stale-node-error.ts参照）。
      throw new StaleNodeRequestError(key);
    }
    if (!res.ok) {
      // M3(ADR-0013): 500の場合、本文にはRust側がcatch_unwindで捕まえた
      // panicメッセージ・ノードキーが入っている
      // （src-tauri/src/copc_state.rsのReadNodeError::Panicked、
      // src-tauri/src/lib.rsのinternal_server_error_response参照）。
      // ここで本文を読み捨てるとその情報が失われ、ErrorDialogに
      // 「500」としか出せなくなるため、必ず読んでエラーメッセージに含める。
      const body = await res.text().catch(() => "");
      throw new Error(body || `pcv://${segment} failed: ${res.status}`);
    }
    return await res.arrayBuffer();
  }
}

// --- L2-C: point-cloud tools (extraction, merge) ---

interface ToolResultDto {
  output_path: string;
  point_count: number;
  warnings: string[];
}

function toToolResult(dto: ToolResultDto): ToolResult {
  return { outputPath: dto.output_path, pointCount: dto.point_count, warnings: dto.warnings };
}

/** Forwards progress events (the same `conversion-progress` as conversion) to `onProgress` while `run` is running. */
async function withToolProgress<T>(
  options: ToolOptions | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const callback = options?.onProgress;
  const unlisten = callback
    ? await onConversionProgress((progress) => {
        if (progress.phase === "reading") {
          callback({ pointsRead: progress.pointsRead, totalPoints: progress.totalPoints });
        }
      })
    : NOOP_UNLISTEN;
  try {
    return await run();
  } finally {
    unlisten();
  }
}

/**
 * Creates a new COPC from only the points of an open COPC (`path` = the path passed to `open()`) that match `filter`.
 * Passing the returned `outputPath` to `open()` makes a new layer. The source file is not modified.
 * With zero points it throws (the text is "選んだ範囲に点がありません", shown on screen as is). Cancel with `cancelLasConversion()`
 * (same as conversion; the error text is "キャンセルされた").
 */
export async function extractToCopc(
  path: string,
  filter: ExtractFilter,
  options?: ToolOptions,
): Promise<ToolResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<ToolResultDto>("extract_copc", {
      path,
      filter,
      tempDir: options?.tempDir ?? null,
    });
    return toToolResult(dto);
  });
}

/**
 * Merges several open COPC files (paths passed to `open()`) into one COPC.
 * Files without a CRS are let through and the reason is returned in `warnings` (for the error log).
 * Throws if files that both have a CRS differ.
 */
export async function mergeCopcs(paths: string[], options?: ToolOptions): Promise<ToolResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<ToolResultDto>("merge_copcs", {
      paths,
      tempDir: options?.tempDir ?? null,
    });
    return toToolResult(dto);
  });
}

// --- G2: cross-section view ---

/**
 * Reads the points of an open cross-section layer (`cloudId` from `open()`) as `(s, z)` points, at most `cap`
 * of them (0 = the default). The binary buffer comes straight from Rust (see `section-profile.ts`).
 */
export async function readSectionProfile(
  cloudId: number,
  line: SectionLineInput,
  cap: number,
): Promise<SectionPoints> {
  const buffer = await invoke<ArrayBuffer>("read_section_profile", { generation: cloudId, line, cap });
  return decodeSectionProfile(buffer);
}

// --- G1: rasterize ---

interface RasterToolResultDto extends ToolResultDto {
  geotiff_path: string;
  width: number;
  height: number;
}

/**
 * Rasterizes an open COPC (`path` = the path passed to `open()`): writes a GeoTIFF and a display COPC (one point per
 * non-empty cell). Passing the returned `outputPath` to `open()` makes the display layer; `raster.geotiff.path` is the
 * GeoTIFF in the temp folder (copy it with `saveGeoTiff`). Cancel with `cancelLasConversion()`.
 */
export async function rasterizeToCopc(
  path: string,
  request: RasterRequest,
  options?: ToolOptions,
): Promise<ToolResult> {
  return await withToolProgress(options, async () => {
    const dto = await invoke<RasterToolResultDto>("rasterize_copc", {
      path,
      options: request,
      tempDir: options?.tempDir ?? null,
    });
    return {
      ...toToolResult(dto),
      raster: { ...request, width: dto.width, height: dto.height, geotiff: { path: dto.geotiff_path, download: null } },
    };
  });
}

/**
 * Asks the user where to save a GeoTIFF (the system save dialog), then copies `sourcePath` there.
 * Returns false when the user closed the dialog without choosing.
 */
export async function saveGeoTiff(sourcePath: string, suggestedName: string): Promise<boolean> {
  const destination = await saveFileDialog({
    defaultPath: suggestedName,
    filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
  });
  if (!destination) return false;
  await invoke("save_tool_file", { source: sourcePath, destination });
  return true;
}

// --- G2: section line ---

/**
 * Computes the ground line of a cross section from the SOURCE layer (`cloudId` of the layer the section was cut
 * from). Progress comes through `options.onProgress` as per mille (`totalPoints` is 1000), and the tool cancel
 * (`cancelLasConversion()`) stops it; the error text is then "キャンセルされた".
 */
export async function computeSectionLine(
  cloudId: number,
  line: SectionLineInput,
  request: SectionLineRequest,
  options?: ToolOptions,
): Promise<SectionGroundLine> {
  return await withToolProgress(options, async () => {
    const buffer = await invoke<ArrayBuffer>("compute_section_line", { generation: cloudId, line, request });
    return decodeSectionLine(buffer);
  });
}
