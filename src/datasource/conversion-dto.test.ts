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
});
