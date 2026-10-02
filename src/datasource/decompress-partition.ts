// M4-7: LAZ展開を複数Workerへ分担させるときの、範囲分割とWorker数の決定。
// Web Worker本体(`copc.worker.ts`)から使うが、Worker固有のAPI(`self`・
// `postMessage`等)を一切使わない純粋関数としてここに切り出してあるので、
// 普通のvitestのユニットテスト(`decompress-partition.test.ts`)で確認できる。

/** 1つの展開Workerが担当する点インデックスの範囲(半開区間)。 */
export interface PointRange {
  startIndex: number;
  count: number;
}

/**
 * `totalPoints`個の点を`workerCount`個の範囲にできるだけ均等に分ける
 * (最後の範囲に余りを寄せる)。`workerCount`が1以下、または`totalPoints`が
 * 0以下のときは、範囲1つ(`[0, totalPoints)`、負なら0点)を返す。
 */
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

/** 並列化する展開Workerの数を決めるときに参照する環境値。 */
export interface DecompressWorkerCountOptions {
  /** `navigator.hardwareConcurrency`相当。取得できない環境では`undefined`。 */
  hardwareConcurrency: number | undefined;
}

/**
 * 並列化(複数の展開Workerを立てる)を始める点数のしきい値。これ未満は
 * 常に1(直列、`WasmConverter.feed`のバッチループ)を返す。
 *
 * 根拠: ネイティブ版の実測(`TaskSheets/M4-import-and-conversion.md`の
 * M4-7、`crates/pcv-convert/examples/parallel_read_bench.rs`)で、
 * 分担の単位が小さすぎるとスレッド起動のオーバーヘッドが展開本体の時間を
 * 上回り、直列より遅くなる逆転が実際に観測された(バッチサイズ64Ki点、
 * 20コアで直列18.1秒・並列30.2秒)。Web版のWorker起動・`File`の構造化
 * クローンのコストはネイティブのスレッド起動よりさらに重いと見て、
 * 余裕を持った値にしてある。
 */
export const PARALLEL_MIN_POINTS = 500_000;

/**
 * 並列化するときに立てる展開Workerの数の上限。
 *
 * 根拠: `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`の`POOL_SIZE`と
 * 同じ考え方の決め打ち。各Workerは独立したwasmヒープ(メモリ)と起動コストを
 * 持つため、`navigator.hardwareConcurrency`をそのまま無制限に使わず、
 * 妥当な値で頭打ちにする。実機で比率を測り直せていないため、将来実測して
 * 変える余地を残す値として、ここにコメントごと置いてある。
 */
export const MAX_DECOMPRESS_WORKERS = 8;

/**
 * 立てる展開Workerの数を決める。`totalPoints`が`PARALLEL_MIN_POINTS`未満、
 * または`hardwareConcurrency`が不明・1以下なら1(直列)を返す。
 */
export function decompressWorkerCountFor(
  totalPoints: number,
  options: DecompressWorkerCountOptions,
): number {
  if (totalPoints < PARALLEL_MIN_POINTS) return 1;
  const available =
    options.hardwareConcurrency !== undefined && options.hardwareConcurrency > 0
      ? options.hardwareConcurrency
      : 1;
  return Math.max(1, Math.min(available, MAX_DECOMPRESS_WORKERS));
}
