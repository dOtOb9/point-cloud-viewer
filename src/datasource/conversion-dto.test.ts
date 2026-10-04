// conversion-dto.ts のテスト。`src-tauri/src/conversion.rs`が返すsnake_caseの
// JSONを、camelCase型へ正しく詰め替えられることを確認する。

import { describe, expect, it } from "vitest";
import {
  toConversionOutcome,
  toConversionProgress,
  type ConversionOutcomeDto,
  type ConversionProgressDto,
} from "./conversion-dto";

describe("toConversionOutcome", () => {
  it("already_copcをalreadyCopcへ変換する", () => {
    const dto: ConversionOutcomeDto = { kind: "already_copc", path: "C:/data/beer.copc.laz" };
    expect(toConversionOutcome(dto)).toEqual({ kind: "alreadyCopc", path: "C:/data/beer.copc.laz" });
  });

  it("cachedをoutputPathへ変換する", () => {
    const dto: ConversionOutcomeDto = { kind: "cached", output_path: "C:/data/beer.copc.laz" };
    expect(toConversionOutcome(dto)).toEqual({ kind: "cached", outputPath: "C:/data/beer.copc.laz" });
  });

  it("insufficient_spaceをrequiredBytes/availableBytesへ変換する", () => {
    const dto: ConversionOutcomeDto = {
      kind: "insufficient_space",
      required_bytes: 22_000_000_000,
      available_bytes: 1_000_000_000,
    };
    expect(toConversionOutcome(dto)).toEqual({
      kind: "insufficientSpace",
      requiredBytes: 22_000_000_000,
      availableBytes: 1_000_000_000,
    });
  });

  it("convertingをそのまま変換する", () => {
    const dto: ConversionOutcomeDto = { kind: "converting" };
    expect(toConversionOutcome(dto)).toEqual({ kind: "converting" });
  });
});

describe("toConversionProgress", () => {
  it("readingの各フィールドをcamelCaseへ変換する", () => {
    const dto: ConversionProgressDto = {
      phase: "reading",
      points_read: 4096,
      total_points: 66_848_096,
      elapsed_secs: 1.5,
    };
    expect(toConversionProgress(dto)).toEqual({
      phase: "reading",
      pointsRead: 4096,
      totalPoints: 66_848_096,
      elapsedSecs: 1.5,
    });
  });

  it("post_processingをpostProcessingへ変換する", () => {
    const dto: ConversionProgressDto = { phase: "post_processing", elapsed_secs: 42.0 };
    expect(toConversionProgress(dto)).toEqual({ phase: "postProcessing", elapsedSecs: 42.0 });
  });

  // M4-11(TaskSheets/M4-import-and-conversion.md): Web版だけが送る「準備」
  // 段階の各ステップ。`src/datasource/copc.worker.ts`が送るDTOの形を
  // そのまま確認する。
  describe("preparing(Web版だけの拡張)", () => {
    it("acquiring_lockをacquiringLockへ変換する", () => {
      const dto: ConversionProgressDto = { phase: "preparing", preparing: { step: "acquiring_lock" } };
      expect(toConversionProgress(dto)).toEqual({
        phase: "preparing",
        preparing: { step: "acquiringLock" },
      });
    });

    it("opening_scratch_filesのopened/totalをそのまま伝える", () => {
      const dto: ConversionProgressDto = {
        phase: "preparing",
        preparing: { step: "opening_scratch_files", opened: 12, total: 256 },
      };
      expect(toConversionProgress(dto)).toEqual({
        phase: "preparing",
        preparing: { step: "openingScratchFiles", opened: 12, total: 256 },
      });
    });

    it("starting_decompress_workersのstarted/totalをそのまま伝える", () => {
      const dto: ConversionProgressDto = {
        phase: "preparing",
        preparing: { step: "starting_decompress_workers", started: 2, total: 4 },
      };
      expect(toConversionProgress(dto)).toEqual({
        phase: "preparing",
        preparing: { step: "startingDecompressWorkers", started: 2, total: 4 },
      });
    });

    it("cleaning_stale_scratch・opening_output_file・reading_headerをそれぞれ変換する", () => {
      expect(
        toConversionProgress({ phase: "preparing", preparing: { step: "cleaning_stale_scratch" } }),
      ).toEqual({ phase: "preparing", preparing: { step: "cleaningStaleScratch" } });
      expect(
        toConversionProgress({ phase: "preparing", preparing: { step: "opening_output_file" } }),
      ).toEqual({ phase: "preparing", preparing: { step: "openingOutputFile" } });
      expect(
        toConversionProgress({ phase: "preparing", preparing: { step: "reading_header" } }),
      ).toEqual({ phase: "preparing", preparing: { step: "readingHeader" } });
    });
  });
});
