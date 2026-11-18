import { describe, expect, it } from "vitest";
import {
  BoundedBatchFlow,
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

describe("BoundedBatchFlow", () => {
  it("上限に達するとcanAcquireがfalseを返し、releaseで解放すると再びtrueになる", () => {
    const flow = new BoundedBatchFlow({ maxInFlightBatches: 2, maxInFlightBytes: 1_000 });

    expect(flow.canAcquire()).toBe(true);
    flow.acquire(400);
    expect(flow.inFlightBatches).toBe(1);
    expect(flow.inFlightBytes).toBe(400);

    expect(flow.canAcquire()).toBe(true);
    flow.acquire(400);
    expect(flow.inFlightBatches).toBe(2);

    expect(flow.canAcquire()).toBe(false);

    flow.release(400);
    expect(flow.inFlightBatches).toBe(1);
    expect(flow.inFlightBytes).toBe(400);
    expect(flow.canAcquire()).toBe(true);
  });

  it("バイト数の上限にも達する(バッチ数に余裕があっても止まる)", () => {
    const flow = new BoundedBatchFlow({ maxInFlightBatches: 10, maxInFlightBytes: 500 });
    flow.acquire(300);
    expect(flow.canAcquire()).toBe(true);
    flow.acquire(300);
    expect(flow.canAcquire()).toBe(false);
  });

  it("adjustBytesで見積もりと実際のバイト数の差を補正できる", () => {
    const flow = new BoundedBatchFlow({ maxInFlightBatches: 10, maxInFlightBytes: 1_000 });
    flow.acquire(500);
    flow.adjustBytes(500, 300);
    expect(flow.inFlightBytes).toBe(300);
  });

  it("総リクエスト数を10倍にしても、同時に抱える量の上限は変わらない", () => {
    const limits = { maxInFlightBatches: 4, maxInFlightBytes: 4 * 1_000 };
    const batchBytes = 1_000;

    function simulate(totalRequests: number): { peakBatches: number; peakBytes: number } {
      const flow = new BoundedBatchFlow(limits);
      const outstanding: number[] = [];
      let issued = 0;
      let peakBatches = 0;
      let peakBytes = 0;
      let seed = 1;
      const nextBool = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % 3 !== 0;
      };

      while (issued < totalRequests || outstanding.length > 0) {
        if (issued < totalRequests && flow.canAcquire() && (outstanding.length === 0 || nextBool())) {
          flow.acquire(batchBytes);
          outstanding.push(batchBytes);
          issued += 1;
        } else if (outstanding.length > 0) {
          const bytes = outstanding.shift();
          if (bytes !== undefined) flow.release(bytes);
        } else {
          break;
        }
        peakBatches = Math.max(peakBatches, flow.inFlightBatches);
        peakBytes = Math.max(peakBytes, flow.inFlightBytes);
      }
      return { peakBatches, peakBytes };
    }

    const small = simulate(1_000);
    const large = simulate(10_000);

    expect(small.peakBatches).toBeLessThanOrEqual(limits.maxInFlightBatches);
    expect(small.peakBytes).toBeLessThanOrEqual(limits.maxInFlightBytes);
    expect(large.peakBatches).toBeLessThanOrEqual(limits.maxInFlightBatches);
    expect(large.peakBytes).toBeLessThanOrEqual(limits.maxInFlightBytes);
    expect(large.peakBatches).toBe(small.peakBatches);
    expect(large.peakBytes).toBe(small.peakBytes);
  });
});
