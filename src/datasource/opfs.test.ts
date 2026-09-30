// opfs.ts の純粋関数(キャッシュのキー・容量の判定)のテスト。
// 実際のOPFS I/Oはブラウザでしか意味を持たないため、ここではテストしない
// (所有者がブラウザで確かめる手順は TaskSheets/M4-import-and-conversion.md の
// M4-6bに書く)。

import { describe, expect, it } from "vitest";
import {
  cacheKeyFor,
  hasEnoughQuota,
  outputFileNameFor,
  requiredScratchBytes,
  SCRATCH_SIZE_FACTOR,
  type FileFingerprint,
} from "./opfs";

describe("cacheKeyFor", () => {
  it("同じ指紋からは同じキーが決定的に出る", () => {
    const fp: FileFingerprint = { name: "a.laz", size: 1234, lastModified: 5678 };
    expect(cacheKeyFor(fp)).toBe(cacheKeyFor({ ...fp }));
  });

  it("名前・サイズ・更新日時のいずれかが違えば別のキーになる", () => {
    const base: FileFingerprint = { name: "a.laz", size: 1234, lastModified: 5678 };
    const byName = cacheKeyFor(base);
    expect(cacheKeyFor({ ...base, name: "b.laz" })).not.toBe(byName);
    expect(cacheKeyFor({ ...base, size: 1235 })).not.toBe(byName);
    expect(cacheKeyFor({ ...base, lastModified: 5679 })).not.toBe(byName);
  });

  it("OPFSのファイル名として安全な文字だけを返す(16進数8桁)", () => {
    const key = cacheKeyFor({ name: "変な/名前?.laz", size: 0, lastModified: 0 });
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("outputFileNameFor", () => {
  it("キーに.copc.lazを付けたものを返す", () => {
    const fp: FileFingerprint = { name: "a.laz", size: 1, lastModified: 1 };
    expect(outputFileNameFor(fp)).toBe(`${cacheKeyFor(fp)}.copc.laz`);
  });
});

describe("requiredScratchBytes / hasEnoughQuota", () => {
  it("ADR-0006の実測どおり入力サイズの11倍を必要量とする", () => {
    expect(SCRATCH_SIZE_FACTOR).toBe(11);
    expect(requiredScratchBytes(1_000)).toBe(11_000);
  });

  it("空き容量が必要量以上なら足りると判定する", () => {
    const inputSize = 1_000_000;
    const required = requiredScratchBytes(inputSize);
    expect(hasEnoughQuota({ quota: required, usage: 0 }, inputSize)).toBe(true);
    expect(hasEnoughQuota({ quota: required - 1, usage: 0 }, inputSize)).toBe(false);
  });

  it("使用済み(usage)を差し引いた空きで判定する", () => {
    const inputSize = 1_000;
    const required = requiredScratchBytes(inputSize);
    expect(hasEnoughQuota({ quota: required + 500, usage: 500 }, inputSize)).toBe(true);
    expect(hasEnoughQuota({ quota: required + 500, usage: 501 }, inputSize)).toBe(false);
  });
});