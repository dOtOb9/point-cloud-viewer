import type { ConversionStageBreakdown } from "./conversion-dto";

export interface ConversionBreakdownMeta {
  platform: "desktop" | "web";
  format: string;
  fileName: string;
  browser?: string;
  hardwareConcurrency?: number;
  deviceMemoryGiB?: number;
}

function formatSeconds(secs: number): string {
  return `${secs.toFixed(3)}秒`;
}

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
  lines.push(`入力ファイル数: ${breakdown.inputFileCount.toLocaleString("ja-JP")}`);
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
  if (breakdown.opfsSeqReadCalls !== null && breakdown.opfsSeqReadSecs !== null) {
    lines.push(
      `(参考)OPFS逐次読み(open_at): 呼び出し${breakdown.opfsSeqReadCalls.toLocaleString("ja-JP")}回` +
        `, 実I/O時間: ${formatSeconds(breakdown.opfsSeqReadSecs)}`,
    );
  }
  return lines.join("\n");
}
