// decompress-partition.ts のテスト。Worker/wasmには依存しない純粋関数なので、
// 実際のWorkerなしでテストできる。

import { describe, expect, it } from "vitest";
import {
  decompressWorkerCountFor,
  pointRangesFor,
  MAX_DECOMPRESS_WORKERS,
  MAX_DECOMPRESS_WORKERS_MOBILE,
  PARALLEL_MIN_POINTS,
} from "./decompress-partition";

describe("pointRangesFor", () => {
  it("割り切れる点数を均等に分ける", () => {
    expect(pointRangesFor(100, 4)).toEqual([
      { startIndex: 0, count: 25 },
      { startIndex: 25, count: 25 },
      { startIndex: 50, count: 25 },
      { startIndex: 75, count: 25 },
    ]);
  });

  it("割り切れない余りを最後の範囲に寄せる", () => {
    expect(pointRangesFor(10, 3)).toEqual([
      { startIndex: 0, count: 3 },
      { startIndex: 3, count: 3 },
      { startIndex: 6, count: 4 },
    ]);
  });

  it("範囲は重ならず、合計が総点数に一致する", () => {
    const ranges = pointRangesFor(66_848_096, 7);
    const total = ranges.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(66_848_096);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].startIndex).toBe(ranges[i - 1].startIndex + ranges[i - 1].count);
    }
  });

  it("workerCountが1以下なら範囲1つを返す", () => {
    expect(pointRangesFor(1000, 1)).toEqual([{ startIndex: 0, count: 1000 }]);
    expect(pointRangesFor(1000, 0)).toEqual([{ startIndex: 0, count: 1000 }]);
  });

  it("totalPointsが0以下なら空の範囲を返す", () => {
    expect(pointRangesFor(0, 4)).toEqual([{ startIndex: 0, count: 0 }]);
  });
});

describe("decompressWorkerCountFor", () => {
  it("PARALLEL_MIN_POINTS未満では常に1(直列)を返す", () => {
    expect(
      decompressWorkerCountFor(PARALLEL_MIN_POINTS - 1, { hardwareConcurrency: 16, isMobile: false }),
    ).toBe(1);
  });

  it("PARALLEL_MIN_POINTS以上かつhardwareConcurrencyが十分ならその値を使う", () => {
    expect(
      decompressWorkerCountFor(PARALLEL_MIN_POINTS, { hardwareConcurrency: 4, isMobile: false }),
    ).toBe(4);
  });

  it("MAX_DECOMPRESS_WORKERSで頭打ちになる", () => {
    expect(
      decompressWorkerCountFor(100_000_000, { hardwareConcurrency: 32, isMobile: false }),
    ).toBe(MAX_DECOMPRESS_WORKERS);
  });

  it("hardwareConcurrencyが不明・0以下なら1を返す", () => {
    expect(
      decompressWorkerCountFor(100_000_000, { hardwareConcurrency: undefined, isMobile: false }),
    ).toBe(1);
    expect(decompressWorkerCountFor(100_000_000, { hardwareConcurrency: 0, isMobile: false })).toBe(1);
  });

  // M4-11: モバイルでは展開用Workerの数を抑える(decompress-partition.tsの
  // MAX_DECOMPRESS_WORKERS_MOBILEのドキュメント参照)。
  describe("モバイル", () => {
    it("MAX_DECOMPRESS_WORKERS_MOBILE(=1)で頭打ちになり、追加のWorkerを一切立てない", () => {
      expect(MAX_DECOMPRESS_WORKERS_MOBILE).toBe(1);
      expect(
        decompressWorkerCountFor(100_000_000, { hardwareConcurrency: 8, isMobile: true }),
      ).toBe(1);
    });

    it("hardwareConcurrencyが大きくても、デスクトップのMAX_DECOMPRESS_WORKERSより小さい値になる", () => {
      const mobileCount = decompressWorkerCountFor(100_000_000, {
        hardwareConcurrency: 32,
        isMobile: true,
      });
      const desktopCount = decompressWorkerCountFor(100_000_000, {
        hardwareConcurrency: 32,
        isMobile: false,
      });
      expect(mobileCount).toBeLessThan(desktopCount);
    });

    it("PARALLEL_MIN_POINTS未満では、モバイルでも(元々1なので)変わらず1を返す", () => {
      expect(
        decompressWorkerCountFor(PARALLEL_MIN_POINTS - 1, { hardwareConcurrency: 8, isMobile: true }),
      ).toBe(1);
    });
  });
});
