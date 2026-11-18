import type { PrepareOutcome } from "./DataSource";
import type { ConversionOutcome } from "./conversion-dto";
import { describeInsufficientSpaceWeb } from "./opfs";

const INSUFFICIENT_SPACE_SUMMARY = "空き容量が足りません";

const OPFS_UNAVAILABLE_SINGLE =
  "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。";
const OPFS_UNAVAILABLE_MULTI =
  "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でまとめてCOPC(.copc.laz)に変換してから開いてください。";

export function toPrepareOutcome(
  outcome: Exclude<ConversionOutcome, { kind: "converting" }>,
  isMulti: boolean,
): PrepareOutcome {
  switch (outcome.kind) {
    case "alreadyCopc":
      return { kind: "ready", path: outcome.path, conversion: null };
    case "cached":
      return { kind: "ready", path: outcome.outputPath, conversion: null };
    case "opfsUnavailable": {
      const text = isMulti ? OPFS_UNAVAILABLE_MULTI : OPFS_UNAVAILABLE_SINGLE;
      return { kind: "failed", summary: text, details: text };
    }
    case "insufficientSpace":
      return {
        kind: "failed",
        summary: INSUFFICIENT_SPACE_SUMMARY,
        details: describeInsufficientSpaceDesktop(outcome.requiredBytes, outcome.availableBytes),
      };
    case "insufficientSpaceWeb":
      return {
        kind: "failed",
        summary: INSUFFICIENT_SPACE_SUMMARY,
        details: describeInsufficientSpaceWeb({
          requiredBytes: outcome.requiredBytes,
          quotaBytes: outcome.quotaBytes,
          usageBytes: outcome.usageBytes,
          persisted: outcome.persisted,
          reclaimableBytes: outcome.reclaimableBytes,
        }),
      };
  }
}

export function toConversionFailureOutcome(message: string, cancelled: boolean): PrepareOutcome {
  if (cancelled) return { kind: "cancelled" };
  return { kind: "failed", summary: message, details: `変換に失敗しました: ${message}` };
}

export function describeInsufficientSpaceDesktop(requiredBytes: number, availableBytes: number): string {
  const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `空き容量が足りません(必要: 約${toGiB(requiredBytes)}GiB、空き: 約${toGiB(availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`;
}
