// M4-12(`TaskSheets/M4-import-and-conversion.md`): 変換完了後に画面へ出す
// 段階別の内訳を、所有者がそのまま報告できるテキストへ整形する。
//
// Rust側(デスクトップ: `src-tauri/src/conversion.rs`、Web版:
// `crates/pcv-wasm/src/dto.rs`)はどちらも同じ形の`ConversionStageBreakdown`
// (秒単位のDuration・点数・ファイルサイズ)を作る。この関数は値の整形
// (文字列の組み立て)だけを行う純粋関数にしてあり、`src/ui/shell/LayerPanel.tsx`
// の「内訳をコピー」ボタンが呼ぶ。プラットフォーム固有の情報(ブラウザ・
// 論理コア数・メモリ)は呼び出し側が`ConversionBreakdownMeta`として渡す
// (このファイル自身はDOM/navigatorに触れない。テストしやすくするため)。

import type { ConversionStageBreakdown } from "./conversion-dto";

/** 内訳のテキストに添える、プラットフォーム・端末の情報。 */
export interface ConversionBreakdownMeta {
  /** "desktop"(Tauri)か"web"(ブラウザ)か。 */
  platform: "desktop" | "web";
  /** 元ファイルの形式(拡張子、小文字)。例: "las"・"laz"・"e57"・"ply"・"pcd"。 */
  format: string;
  /** 元ファイル名(パスではなくファイル名のみを想定)。 */
  fileName: string;
  /** Web版のみ: `navigator.userAgent`。デスクトップは`undefined`。 */
  browser?: string;
  /** 論理コア数(`navigator.hardwareConcurrency`)。取れなければ`undefined`。 */
  hardwareConcurrency?: number;
  /** 端末メモリ(GiB、`navigator.deviceMemory`。Chromeのみ・近似値)。
   *  取れなければ`undefined`。 */
  deviceMemoryGiB?: number;
}

function formatSeconds(secs: number): string {
  return `${secs.toFixed(3)}秒`;
}

/** `total`に対する割合(%)。`total`が0以下なら割合は出さない(0除算を避ける)。 */
function formatPercent(secs: number, total: number): string {
  if (!(total > 0)) return "";
  return ` (${((secs / total) * 100).toFixed(1)}%)`;
}

function formatStageLine(label: string, secs: number, totalSecs: number): string {
  return `  ${label}: ${formatSeconds(secs)}${formatPercent(secs, totalSecs)}`;
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1024) {
    return `${(mib / 1024).toFixed(2)} GiB`;
  }
  return `${mib.toFixed(1)} MiB`;
}

/**
 * 段階ごとの内訳を、所有者がそのまま報告できるテキストに整形する。
 * 行の並び: 見出し → メタ情報(形式・点数・ファイルサイズ・端末情報) →
 * 段階ごとの秒数・割合 → (Web版のみ)OPFS参考値 → 合計。
 */
export function formatConversionBreakdown(
  breakdown: ConversionStageBreakdown,
  meta: ConversionBreakdownMeta,
): string {
  const platformLabel = meta.platform === "desktop" ? "デスクトップ" : "Web";
  const lines: string[] = [];
  lines.push(`変換の内訳 (${platformLabel})`);
  lines.push(`ファイル: ${meta.fileName}`);
  lines.push(`形式: ${meta.format}`);
  lines.push(`点数: ${breakdown.pointCount.toLocaleString("ja-JP")}`);
  lines.push(`入力ファイルサイズ: ${formatBytes(breakdown.fileSizeBytes)}`);
  if (meta.browser !== undefined) {
    lines.push(`ブラウザ: ${meta.browser}`);
  }
  if (meta.hardwareConcurrency !== undefined) {
    lines.push(`論理コア数: ${meta.hardwareConcurrency}`);
  }
  if (meta.deviceMemoryGiB !== undefined) {
    lines.push(`メモリ: 約${meta.deviceMemoryGiB}GiB`);
  }
  lines.push(formatStageLine("入力の読み込みと展開", breakdown.sourceReadAndDecodeSecs, breakdown.totalSecs));
  lines.push(formatStageLine("一時ファイルへの書き込み", breakdown.spillWriteSecs, breakdown.totalSecs));
  lines.push(formatStageLine("octreeの分割(LOD)", breakdown.lodIndexBuildSecs, breakdown.totalSecs));
  lines.push(formatStageLine("ノードの圧縮", breakdown.nodeCompressionSecs, breakdown.totalSecs));
  lines.push(formatStageLine("書き出し", breakdown.headerAndHierarchyWriteSecs, breakdown.totalSecs));
  lines.push(`合計: ${formatSeconds(breakdown.totalSecs)}`);
  if (breakdown.opfsIoSecs !== null) {
    lines.push(`(参考)OPFSの読み書き合計: ${formatSeconds(breakdown.opfsIoSecs)}`);
  }
  // M4-13(`TaskSheets/M4-import-and-conversion.md`): OPFSスクラッチの範囲読み
  // (`read_at`)の統計。「ノード圧縮がLOD順に読むためspill上はランダムアクセス
  // になり、64KiBブロックキャッシュがほぼ毎回外れる」という仮説を、所有者の
  // 実機の数値で直接確かめられるようにする(4つとも揃っているときだけ出す。
  // どれかがnullなら全部nullのはず=デスクトップ)。
  if (
    breakdown.opfsReadAtCalls !== null &&
    breakdown.opfsCacheHits !== null &&
    breakdown.opfsCacheMisses !== null &&
    breakdown.opfsBytesReadFromOpfs !== null
  ) {
    const totalLookups = breakdown.opfsCacheHits + breakdown.opfsCacheMisses;
    const hitRate = totalLookups > 0 ? (breakdown.opfsCacheHits / totalLookups) * 100 : 0;
    lines.push(
      `(参考)OPFS範囲読み(read_at): 呼び出し${breakdown.opfsReadAtCalls.toLocaleString("ja-JP")}回` +
        `, キャッシュヒット${breakdown.opfsCacheHits.toLocaleString("ja-JP")}回` +
        `, ミス${breakdown.opfsCacheMisses.toLocaleString("ja-JP")}回` +
        ` (ヒット率${hitRate.toFixed(1)}%)` +
        `, OPFSから実際に読んだバイト数: ${formatBytes(breakdown.opfsBytesReadFromOpfs)}`,
    );
    if (breakdown.opfsReadSecs !== null) {
      lines.push(`(参考)OPFS範囲読みの実I/O時間: ${formatSeconds(breakdown.opfsReadSecs)}`);
    }
  }
  // M4-13追記: OPFSスクラッチの逐次読み出し(`open_at`)の統計。BEFORE計測で、
  // 上の`read_at`側ではなくこちらが「ノードの圧縮」のほぼ全てを占めていた
  // (`vendor/copc-writer`の`encode_node_points`がノードのLOD順インデックスを
  // 無バッファ・1点ずつ読んでいるため)。
  if (breakdown.opfsSeqReadCalls !== null && breakdown.opfsSeqReadSecs !== null) {
    lines.push(
      `(参考)OPFS逐次読み(open_at): 呼び出し${breakdown.opfsSeqReadCalls.toLocaleString("ja-JP")}回` +
        `, 実I/O時間: ${formatSeconds(breakdown.opfsSeqReadSecs)}`,
    );
  }
  return lines.join("\n");
}
