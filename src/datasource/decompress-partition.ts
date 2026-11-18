export interface PointRange {
  startIndex: number;
  count: number;
}

export function pointRangesFor(totalPoints: number, workerCount: number): PointRange[] {
  const total = Math.max(0, Math.trunc(totalPoints));
  if (workerCount <= 1 || total === 0) {
    return [{ startIndex: 0, count: total }];
  }
  const base = Math.floor(total / workerCount);
  const ranges: PointRange[] = [];
  let start = 0;
  for (let i = 0; i < workerCount; i++) {
    const isLast = i === workerCount - 1;
    const count = isLast ? total - start : base;
    ranges.push({ startIndex: start, count });
    start += count;
  }
  return ranges;
}

export interface DecompressWorkerCountOptions {
  hardwareConcurrency: number | undefined;
  isMobile: boolean;
}

export const PARALLEL_MIN_POINTS = 500_000;

export const MAX_DECOMPRESS_WORKERS = 8;

export const MAX_DECOMPRESS_WORKERS_MOBILE = 1;

export function decompressWorkerCountFor(
  totalPoints: number,
  options: DecompressWorkerCountOptions,
): number {
  if (totalPoints < PARALLEL_MIN_POINTS) return 1;
  const available =
    options.hardwareConcurrency !== undefined && options.hardwareConcurrency > 0
      ? options.hardwareConcurrency
      : 1;
  const cap = options.isMobile ? MAX_DECOMPRESS_WORKERS_MOBILE : MAX_DECOMPRESS_WORKERS;
  return Math.max(1, Math.min(available, cap));
}

export const DECOMPRESS_BATCH_POINTS = 64 * 1024;

export const MAX_IN_FLIGHT_BATCHES_PER_WORKER = 2;

export interface BatchFlowLimits {
  maxInFlightBatches: number;
  maxInFlightBytes: number;
}

export class BoundedBatchFlow {
  private batches = 0;
  private bytes = 0;

  constructor(private readonly limits: BatchFlowLimits) {}

  canAcquire(): boolean {
    return this.batches < this.limits.maxInFlightBatches && this.bytes < this.limits.maxInFlightBytes;
  }

  acquire(estimatedBytes: number): void {
    this.batches += 1;
    this.bytes += estimatedBytes;
  }

  adjustBytes(estimatedBytes: number, actualBytes: number): void {
    this.bytes += actualBytes - estimatedBytes;
  }

  release(bytes: number): void {
    this.batches -= 1;
    this.bytes -= bytes;
  }

  get inFlightBatches(): number {
    return this.batches;
  }

  get inFlightBytes(): number {
    return this.bytes;
  }
}
