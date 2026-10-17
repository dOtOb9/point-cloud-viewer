// Pure helpers for `DataSource.prepareToOpen`: turn a `ConversionOutcome` (what the `start*` functions return)
// into a `PrepareOutcome`, with the error texts. No Tauri, no React, so it is unit-tested.
// (The Web "not enough space" text, `describeInsufficientSpaceWeb`, is in opfs.ts because it reads OPFS numbers.)
// Used by: tauri.ts, web.ts.
import type { PrepareOutcome } from "./DataSource";
import type { ConversionOutcome } from "./conversion-dto";
import { describeInsufficientSpaceWeb } from "./opfs";

const INSUFFICIENT_SPACE_SUMMARY = "空き容量が足りません";

const OPFS_UNAVAILABLE_SINGLE =
  "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。";
const OPFS_UNAVAILABLE_MULTI =
  "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でまとめてCOPC(.copc.laz)に変換してから開いてください。";

/** `isMulti`: the texts of "OPFS unavailable" differ between the single-file and the multi-file route. */
export function toPrepareOutcome(outcome: ConversionOutcome, isMulti: boolean): PrepareOutcome {
  switch (outcome.kind) {
    case "alreadyCopc":
      return { kind: "ready", path: outcome.path };
    case "cached":
      return { kind: "ready", path: outcome.outputPath };
    case "converting":
      return { kind: "converting" };
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

/** Error text for the desktop "not enough disk space" outcome (sizes in GiB, one decimal). */
export function describeInsufficientSpaceDesktop(requiredBytes: number, availableBytes: number): string {
  const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `空き容量が足りません(必要: 約${toGiB(requiredBytes)}GiB、空き: 約${toGiB(availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`;
}
